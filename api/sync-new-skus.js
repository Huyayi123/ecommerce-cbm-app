const DEFAULT_STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

function envStoreConfig() {
  try {
    const parsed = JSON.parse(process.env.TAKEALOT_STORES_JSON || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function apiKeyForStore(storeName) {
  const config = envStoreConfig().find((item) => item && item.name === storeName);
  if (config?.apiKeyEnv && process.env[config.apiKeyEnv]) return process.env[config.apiKeyEnv];
  if (config?.apiKey) return config.apiKey;
  const storeSpecificEnv = `TAKEALOT_API_KEY_${storeName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  if (process.env[storeSpecificEnv]) return process.env[storeSpecificEnv];
  return process.env.TAKEALOT_API_KEY || '';
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.offers)) return payload.offers;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function skuFor(row) {
  return String(row?.sku ?? row?.seller_sku ?? row?.merchant_sku ?? row?.offer_sku ?? '').trim().toUpperCase();
}

function titleFor(row) {
  return String(row?.title ?? row?.product_title ?? row?.name ?? row?.product_name ?? '').trim();
}

function rowKey(row) {
  return String(row?.offer_id ?? row?.sku ?? row?.barcode ?? JSON.stringify(row)).trim();
}

function isDisabledRow(row) {
  return String(row?.status ?? '').trim().toLowerCase().startsWith('disabled');
}

function normalizeImageUrl(value) {
  return String(value ?? '').replace(/^http:\/\/takealot\.s3\.amazonaws\.com\//i, 'https://takealot.s3.amazonaws.com/');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isImageUrl(value) {
  return isHttpUrl(value) && /\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(value);
}

function findImageUrl(value, depth = 0, allowAnyHttpUrl = false) {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return (allowAnyHttpUrl ? isHttpUrl(value) : isImageUrl(value)) ? normalizeImageUrl(value) : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item, depth + 1, allowAnyHttpUrl);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const record = value;
    const priorityKeys = ['image_url', 'imageUrl', 'image', 'images', 'thumbnail', 'thumbnail_url', 'product_image', 'lead_image', 'main_image'];
    for (const key of priorityKeys) {
      const found = findImageUrl(record[key], depth + 1, true);
      if (found) return found;
    }
    for (const item of Object.values(record)) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function supabaseUrl(path) {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL');
  return `${base.replace(/\/$/, '')}/rest/v1/${path}`;
}

async function supabaseRequest(method, path, body, headers = {}) {
  const response = await fetch(supabaseUrl(path), {
    method,
    headers: supabaseHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Supabase request failed: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function fetchExistingSkuSet() {
  const existing = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const rows = await supabaseRequest('GET', `sku_items?select=sku&sku=not.is.null&order=sku.asc&offset=${from}&limit=${pageSize}`);
    const data = Array.isArray(rows) ? rows : [];
    for (const row of data) {
      const sku = String(row.sku ?? '').trim().toUpperCase();
      if (sku) existing.add(sku);
    }
    if (data.length < pageSize) break;
  }
  return existing;
}

async function fetchTakealotRows(storeName) {
  const apiKey = apiKeyForStore(storeName);
  if (!apiKey) throw new Error(`Store ${storeName} has no Takealot API Key configured`);
  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const inventoryPath = process.env.TAKEALOT_INVENTORY_PATH || '/v2/offers';
  const pageSize = numberFromEnv('TAKEALOT_PAGE_SIZE', 100);
  const maxPages = numberFromEnv('TAKEALOT_MAX_PAGES', 50);
  const headers = { Accept: 'application/json', Authorization: `Key ${apiKey}` };
  const rows = [];
  const seenKeys = new Set();
  let disabledSkipped = 0;
  let totalResults = null;
  let pagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(inventoryPath, baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('page_number', String(pageNumber));
    const upstream = await fetch(url, { headers });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || payload.error || `Takealot API request failed: ${upstream.status}`);
    const pageRows = rowsFromPayload(payload);
    const payloadTotal = Number(payload?.total_results);
    if (Number.isFinite(payloadTotal)) totalResults = payloadTotal;
    pagesFetched = pageNumber;

    let newRowsOnPage = 0;
    for (const row of pageRows) {
      const key = rowKey(row);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      newRowsOnPage += 1;
      if (isDisabledRow(row)) {
        disabledSkipped += 1;
        continue;
      }
      rows.push(row);
    }

    if (pageRows.length < pageSize) break;
    if (newRowsOnPage === 0) break;
    if (totalResults !== null && seenKeys.size >= totalResults) break;
  }

  return { rows, disabledSkipped, totalResults, pagesFetched };
}

function skuInsertRow(row, storeName) {
  const sku = skuFor(row);
  return {
    id: `takealot-${sku}`,
    sku,
    product_name: '',
    english_name: titleFor(row),
    image_url: findImageUrl(row),
    manufacturer_name: '',
    shop_name: storeName,
    buyer_name: '',
    purchase_price: 0,
    unit_cbm: 0,
    total_cbm: 0,
    total_quantity: 0,
    box_length_cm: 0,
    box_width_cm: 0,
    box_height_cm: 0,
    units_per_carton: 0,
    notes: '',
    is_seasonal: false,
    storage_location: '',
    purchase_url: '',
    updated_at: new Date().toISOString(),
  };
}

async function insertSkuRows(rows) {
  if (rows.length === 0) return;
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    try {
      await supabaseRequest('POST', 'sku_items?on_conflict=id', chunk, {
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/storage_location|purchase_url|schema cache|PGRST204/i.test(message)) throw error;
      const legacyChunk = chunk.map(({ storage_location, purchase_url, ...row }) => row);
      await supabaseRequest('POST', 'sku_items?on_conflict=id', legacyChunk, {
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      });
    }
  }
}

async function syncNewSkus(stores = DEFAULT_STORES, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const existingSkus = await fetchExistingSkuSet();
  const summary = [];
  const insertedRows = [];

  for (const storeName of stores) {
    const result = {
      store: storeName,
      checked: 0,
      inserted: 0,
      skippedExisting: 0,
      skippedDisabled: 0,
      skippedNoSku: 0,
      failed: '',
      pagesFetched: 0,
      totalResults: null,
    };

    try {
      const { rows, disabledSkipped, totalResults, pagesFetched } = await fetchTakealotRows(storeName);
      result.skippedDisabled = disabledSkipped;
      result.pagesFetched = pagesFetched;
      result.totalResults = totalResults;
      const rowsToInsert = [];
      for (const row of rows) {
        result.checked += 1;
        const sku = skuFor(row);
        if (!sku) {
          result.skippedNoSku += 1;
          continue;
        }
        if (existingSkus.has(sku)) {
          result.skippedExisting += 1;
          continue;
        }
        existingSkus.add(sku);
        const insertRow = skuInsertRow(row, storeName);
        rowsToInsert.push(insertRow);
      }
      if (!dryRun) {
        await insertSkuRows(rowsToInsert);
      }
      result.inserted = rowsToInsert.length;
      insertedRows.push(...rowsToInsert);
    } catch (error) {
      result.failed = error instanceof Error ? error.message : String(error);
    }
    summary.push(result);
  }

  return {
    dryRun,
    stores,
    inserted: insertedRows.length,
    insertedSkus: insertedRows.map((row) => ({ sku: row.sku, shopName: row.shop_name, englishName: row.english_name })),
    summary,
  };
}

function storesFromRequest(request) {
  const raw = String(request.query?.stores || request.query?.store || '').trim();
  if (!raw) return DEFAULT_STORES;
  return raw.split(',').map((store) => store.trim()).filter(Boolean);
}

export default async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method || '')) {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const dryRun = ['1', 'true', 'yes'].includes(String(request.query?.dryRun || '').trim().toLowerCase());
    const result = await syncNewSkus(storesFromRequest(request), { dryRun });
    response.status(200).json(result);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'SKU new product sync failed' });
  }
}
