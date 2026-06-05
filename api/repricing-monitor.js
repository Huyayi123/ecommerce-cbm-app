const DEFAULT_STORE = 'MegaValue';

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

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.offers)) return payload.offers;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = numberValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
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

function sumQuantityAvailable(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + (numberValue(item?.quantity_available ?? item?.quantity ?? item) ?? 0), 0);
  }
  if (value && typeof value === 'object') return numberValue(value.quantity_available ?? value.quantity) ?? 0;
  return numberValue(value) ?? 0;
}

function stockFor(row) {
  const explicit = numberValue(row?.quantity_available ?? row?.stock_quantity ?? row?.available_quantity);
  if (explicit !== null) return explicit;
  return sumQuantityAvailable(row?.leadtime_stock ?? row?.stock ?? row?.inventory);
}

function myPriceFor(row) {
  return positiveNumber(row?.selling_price ?? row?.price ?? row?.offer_price ?? row?.current_price);
}

function offerUrlFor(row) {
  return String(row?.offer_url ?? row?.canonical_url ?? row?.product_url ?? row?.url ?? '').trim();
}

function tsinFor(row) {
  return String(row?.tsin_id ?? row?.tsin ?? row?.product_id ?? '').trim();
}

function extractPlid(value) {
  const text = String(value ?? '');
  const match = text.match(/PLID(\d+)/i);
  return match ? match[1] : '';
}

function normalizeSeller(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sellerIsKnown(value) {
  const seller = normalizeSeller(value);
  return Boolean(seller && !['unknown', 'buy_box_seller', 'takealot_public_page', '-'].includes(seller));
}

function sameSeller(a, b) {
  return normalizeSeller(a) === normalizeSeller(b);
}

function parseRawOffers(rawOffers) {
  if (!Array.isArray(rawOffers)) return [];
  return rawOffers.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const price = positiveNumber(item.price ?? item.selling_price ?? item.offer_price ?? item.pretty_price);
    if (!price) return [];
    const stockValue = item.in_stock ?? item.stock ?? item.quantity_available ?? item.available;
    const inStock = typeof stockValue === 'boolean'
      ? stockValue
      : !['0', 'false', 'none', 'out_of_stock', 'disabled'].includes(String(stockValue ?? 'true').toLowerCase());
    return [{
      seller: String(item.seller ?? item.seller_name ?? item.display_name ?? item.name ?? '').trim(),
      price,
      inStock,
      isBuyBox: Boolean(item.is_buy_box ?? item.buy_box),
    }];
  });
}

function parseProductDetails(data) {
  const buybox = data?.buybox || {};
  const sellerDetail = data?.seller_detail || {};
  const seller = String(sellerDetail.display_name ?? sellerDetail.name ?? '').trim();
  let buyBoxPrice = positiveNumber(
    buybox.pretty_price
    ?? buybox.price
    ?? buybox.selling_price
    ?? buybox?.prices?.selling_price,
  );

  if (!buyBoxPrice) {
    const selected = (buybox.items || []).find((item) => item?.is_selected) || (buybox.items || [])[0];
    buyBoxPrice = positiveNumber(selected?.pretty_price ?? selected?.price ?? selected?.selling_price);
  }

  const rawOffers = data?.other_offers || data?.offers || data?.marketplace_offers || buybox?.other_offers || [];
  const offers = parseRawOffers(rawOffers);
  if (buyBoxPrice) {
    offers.unshift({
      seller,
      price: buyBoxPrice,
      inStock: true,
      isBuyBox: true,
    });
  }

  return {
    buyBoxPrice,
    buyBoxSeller: seller,
    offers: offers.filter((offer) => offer.inStock),
  };
}

async function fetchProductDetails(row) {
  const plid = extractPlid(offerUrlFor(row));
  if (!plid) return { source: 'no_plid', buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  const url = `https://api.takealot.com/rest/v-1-10-0/product-details/PLID${plid}`;
  const upstream = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ecommerce-cbm-repricing/1.0)',
    },
  });
  if (!upstream.ok) {
    return { source: `product_details_http_${upstream.status}`, buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  }
  const data = await upstream.json().catch(() => ({}));
  return { source: 'product_details_api', ...parseProductDetails(data) };
}

function evaluateAlert({ row, storeName, productDetails }) {
  const sku = skuFor(row);
  const myPrice = myPriceFor(row);
  const stock = stockFor(row);
  const title = titleFor(row);

  if (!sku || !myPrice) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'none',
      alertMessage: '',
      isActive: false,
      isOutOfStock: stock <= 0,
      source: productDetails.source,
    };
  }

  if (stock <= 0) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'out_of_stock',
      alertMessage: '',
      isActive: false,
      isOutOfStock: true,
      source: productDetails.source,
    };
  }

  const competitorOffers = productDetails.offers
    .filter((offer) => sellerIsKnown(offer.seller))
    .filter((offer) => !sameSeller(offer.seller, storeName))
    .filter((offer) => offer.price < myPrice)
    .sort((a, b) => a.price - b.price);

  const bestCompetitor = competitorOffers[0];
  if (!bestCompetitor) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'none',
      alertMessage: '',
      isActive: false,
      isOutOfStock: false,
      source: productDetails.source,
    };
  }

  const priceGap = Number((myPrice - bestCompetitor.price).toFixed(2));
  const lostBuyBox = bestCompetitor.isBuyBox || (
    productDetails.buyBoxPrice !== null
    && productDetails.buyBoxPrice === bestCompetitor.price
  );

  return {
    sku,
    title,
    myPrice,
    buyBoxPrice: productDetails.buyBoxPrice,
    lowestCompetitorPrice: bestCompetitor.price,
    lowestCompetitorSeller: bestCompetitor.seller,
    priceGap,
    alertLevel: 'high',
    alertType: lostBuyBox ? 'lost_buy_box' : 'followed_price',
    alertMessage: `${sku} confirmed competitor ${bestCompetitor.seller} is R ${priceGap.toFixed(2)} lower than my price.`,
    isActive: true,
    isOutOfStock: false,
    source: productDetails.source,
  };
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
    throw new Error(payload.message || payload.error || `Supabase ${method} ${path} failed: ${response.status}`);
  }
  return response;
}

async function syncRepricingResult({ storeName, storeId, row, alert, checkedAt }) {
  const sku = alert.sku || skuFor(row);
  if (!sku) return;
  const alertId = `${storeName.trim().toLowerCase()}:${sku.trim().toUpperCase()}`;
  const title = alert.title || titleFor(row);
  const productPayload = {
    id: alertId,
    shop_name: storeName,
    store_id: storeId,
    sku,
    tsin: tsinFor(row),
    title,
    offer_url: offerUrlFor(row),
    canonical_url: offerUrlFor(row),
    updated_at: checkedAt,
  };
  await supabaseRequest('POST', 'repricing_products?on_conflict=id', productPayload, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });

  const snapshotPayload = {
    shop_name: storeName,
    store_id: storeId,
    sku,
    title,
    my_price: alert.myPrice,
    buy_box_price: alert.buyBoxPrice,
    lowest_competitor_price: alert.lowestCompetitorPrice,
    lowest_competitor_seller: alert.lowestCompetitorSeller,
    competitor_sellers: alert.lowestCompetitorSeller,
    price_gap: alert.priceGap,
    has_buy_box: !alert.isActive,
    lost_buy_box: alert.alertType === 'lost_buy_box',
    is_out_of_stock: alert.isOutOfStock,
    alert_level: alert.alertLevel,
    alert_type: alert.alertType,
    alert_message: alert.alertMessage,
    source: alert.source,
    checked_at: checkedAt,
  };
  await supabaseRequest('POST', 'repricing_snapshots', snapshotPayload, { Prefer: 'return=minimal' });

  const alertPayload = {
    id: alertId,
    shop_name: storeName,
    store_id: storeId,
    sku,
    title,
    my_price: alert.myPrice,
    buy_box_price: alert.buyBoxPrice,
    lowest_competitor_price: alert.lowestCompetitorPrice,
    lowest_competitor_seller: alert.lowestCompetitorSeller,
    price_gap: alert.priceGap,
    alert_level: alert.alertLevel,
    alert_type: alert.alertType,
    alert_message: alert.alertMessage,
    is_active: alert.isActive,
    checked_at: checkedAt,
    updated_at: checkedAt,
  };
  await supabaseRequest('POST', 'repricing_alerts?on_conflict=id', alertPayload, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

async function fetchTakealotRows(storeName, limit) {
  const apiKey = apiKeyForStore(storeName);
  if (!apiKey) throw new Error(`Store ${storeName} has no Takealot API Key configured`);

  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const inventoryPath = process.env.TAKEALOT_INVENTORY_PATH || '/v2/offers';
  const pageSize = numberFromEnv('TAKEALOT_PAGE_SIZE', 100);
  const maxPages = numberFromEnv('TAKEALOT_REPRICING_MAX_PAGES', numberFromEnv('TAKEALOT_MAX_PAGES', 50));
  const headers = { Accept: 'application/json', Authorization: `Key ${apiKey}` };
  const allRows = [];
  const seenKeys = new Set();
  let pagesFetched = 0;
  let totalResults = null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(inventoryPath, baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('page_number', String(pageNumber));
    const upstream = await fetch(url, { headers });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || payload.error || `Takealot API request failed: ${upstream.status}`);

    const rows = rowsFromPayload(payload);
    const payloadTotal = Number(payload?.total_results);
    if (Number.isFinite(payloadTotal)) totalResults = payloadTotal;
    pagesFetched = pageNumber;

    let newRowsOnPage = 0;
    for (const row of rows) {
      const key = rowKey(row);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      newRowsOnPage += 1;
      if (isDisabledRow(row)) continue;
      allRows.push(row);
      if (limit && allRows.length >= limit) return { rows: allRows, pagesFetched, totalResults };
    }

    if (rows.length < pageSize) break;
    if (newRowsOnPage === 0) break;
    if (totalResults !== null && seenKeys.size >= totalResults) break;
  }

  return { rows: allRows, pagesFetched, totalResults };
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const storeName = String(request.query.store || DEFAULT_STORE).trim();
  const limit = Math.min(Math.max(Number(request.query.limit || 20), 1), 500);
  const storeId = storeName.toLowerCase();
  const checkedAt = new Date().toISOString();

  try {
    const { rows, pagesFetched, totalResults } = await fetchTakealotRows(storeName, limit);
    const details = [];
    let checked = 0;
    let confirmedAlerts = 0;
    let inactive = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const productDetails = await fetchProductDetails(row);
        const alert = evaluateAlert({ row, storeName, productDetails });
        await syncRepricingResult({ storeName, storeId, row, alert, checkedAt });
        checked += 1;
        if (alert.isActive) confirmedAlerts += 1;
        else inactive += 1;
        details.push({
          sku: alert.sku,
          title: alert.title,
          myPrice: alert.myPrice,
          buyBoxPrice: alert.buyBoxPrice,
          competitorPrice: alert.lowestCompetitorPrice,
          competitorSeller: alert.lowestCompetitorSeller,
          alertLevel: alert.alertLevel,
          alertType: alert.alertType,
          isActive: alert.isActive,
          source: alert.source,
        });
      } catch (error) {
        console.error(error);
        errors += 1;
        details.push({ sku: skuFor(row), error: error instanceof Error ? error.message : 'Unknown row error' });
      }
    }

    response.status(200).json({
      ok: errors === 0,
      store: storeName,
      checked,
      confirmedAlerts,
      inactive,
      errors,
      pagesFetched,
      totalResults,
      details: details.slice(0, 50),
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Repricing monitor failed' });
  }
}
