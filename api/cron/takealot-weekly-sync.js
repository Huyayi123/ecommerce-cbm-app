const DEFAULT_SYNC_STORES = ['MegaValue', 'KeepFit'];
const NEW_PRODUCT_RULES = {
  Bestby: [
    { limit: 60, multiplier: 3 },
    { limit: 100, multiplier: 2 },
    { limit: 200, multiplier: 1.5 },
  ],
  Arfast: [
    { limit: 15, multiplier: 3 },
    { limit: 40, multiplier: 1.5 },
  ],
  Aicom: [
    { limit: 25, multiplier: 2 },
  ],
};

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function syncStoresFromEnv() {
  const raw = process.env.TAKEALOT_SYNC_STORES || '';
  return raw.split(',').map((store) => store.trim()).filter(Boolean);
}

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

function skuFor(row) {
  return String(row?.sku ?? row?.seller_sku ?? row?.merchant_sku ?? row?.offer_sku ?? '').trim();
}

function rowKey(row) {
  return String(row?.offer_id ?? row?.sku ?? row?.barcode ?? JSON.stringify(row)).trim();
}

function isDisabledRow(row) {
  return String(row?.status ?? '').trim().toLowerCase().startsWith('disabled');
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sumQuantityAvailable(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + numberValue(item?.quantity_available ?? item), 0);
  if (value && typeof value === 'object') return numberValue(value.quantity_available);
  return numberValue(value);
}

function sumSalesUnits(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + numberValue(item?.sales_units ?? item), 0);
  if (value && typeof value === 'object') return numberValue(value.sales_units);
  return numberValue(value);
}

function stockMonthsForMonthlySales(monthlySales) {
  if (monthlySales > 50) return 4;
  if (monthlySales >= 21) return 3;
  return 2;
}

function newProductRulesForStore(storeName) {
  return NEW_PRODUCT_RULES[storeName] || [];
}

function newProductMultiplierForRank(storeName, rank) {
  const rule = newProductRulesForStore(storeName).find((item) => rank > 0 && rank <= item.limit);
  return rule?.multiplier ?? 1;
}

function aicomDirectSuggestedQuantity(rank, rawMonthlySales) {
  if (rank <= 0 || rank > 15) return null;
  if (rawMonthlySales <= 3) {
    return {
      suggestedQuantity: 0,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，未超过 3，暂不补订`,
    };
  }
  if (rawMonthlySales <= 5) {
    return {
      suggestedQuantity: 40,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，建议采购数量直接 40 个`,
    };
  }
  if (rawMonthlySales <= 8) {
    return {
      suggestedQuantity: 50,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，建议采购数量直接 50 个`,
    };
  }
  return {
    suggestedQuantity: 60,
    message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，建议采购数量直接 60 个`,
  };
}

function forecastMonthlySales(storeName, rank, rawMonthlySales) {
  if (storeName === 'Aicom' && rank > 0 && rank <= 15) {
    return { monthlySales: rawMonthlySales, message: '' };
  }

  const multiplier = newProductMultiplierForRank(storeName, rank);
  if (multiplier > 1 && rawMonthlySales > 0) {
    return {
      monthlySales: rawMonthlySales * multiplier,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，按 ${multiplier} 倍预测`,
    };
  }
  return { monthlySales: rawMonthlySales, message: '' };
}

function buildNewProductRankMap(storeName, takealotRows) {
  if (newProductRulesForStore(storeName).length === 0) return new Map();
  const sortedSkus = takealotRows
    .map((row) => skuFor(row))
    .filter(Boolean)
    .sort((a, b) => numberValue(a) - numberValue(b));
  const ranks = new Map();
  [...sortedSkus].reverse().forEach((sku, index) => {
    ranks.set(skuKey(sku), index + 1);
  });
  return ranks;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function fetchTakealotRows(storeName) {
  const apiKey = apiKeyForStore(storeName);
  if (!apiKey) throw new Error(`店铺 ${storeName} 未配置 Takealot API Key`);

  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const inventoryPath = process.env.TAKEALOT_INVENTORY_PATH || '/v2/offers';
  const pageSize = numberFromEnv('TAKEALOT_PAGE_SIZE', 100);
  const maxPages = numberFromEnv('TAKEALOT_MAX_PAGES', 50);
  const headers = { Accept: 'application/json', Authorization: `Key ${apiKey}` };
  const allRows = [];
  const seenKeys = new Set();
  let fetchedRows = 0;
  let disabledRows = 0;
  let duplicateRows = 0;
  let totalResults = null;
  let pagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(inventoryPath, baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('page_number', String(pageNumber));

    const upstream = await fetch(url, { headers });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || payload.error || `Takealot API 请求失败：${upstream.status}`);

    const rows = rowsFromPayload(payload);
    fetchedRows += rows.length;
    const payloadTotal = Number(payload?.total_results);
    if (Number.isFinite(payloadTotal)) totalResults = payloadTotal;
    pagesFetched = pageNumber;

    let newRowsOnPage = 0;
    for (const row of rows) {
      const key = rowKey(row);
      if (!key || seenKeys.has(key)) {
        duplicateRows += 1;
        continue;
      }
      seenKeys.add(key);
      newRowsOnPage += 1;
      if (isDisabledRow(row)) {
        disabledRows += 1;
      } else {
        allRows.push(row);
      }
    }

    if (rows.length < pageSize) break;
    if (newRowsOnPage === 0) break;
    if (totalResults !== null && seenKeys.size >= totalResults) break;
  }

  return { rows: allRows, pagesFetched, totalResults, fetchedRows, activeRows: allRows.length, disabledRows, duplicateRows };
}

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('缺少 SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function supabaseUrl(path) {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('缺少 SUPABASE_URL 或 VITE_SUPABASE_URL');
  return `${base.replace(/\/$/, '')}/rest/v1/${path}`;
}

async function supabaseSelect(path) {
  const response = await fetch(supabaseUrl(path), { headers: supabaseHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Supabase 查询失败：${response.status}`);
  return Array.isArray(payload) ? payload : [];
}

async function supabaseSelectAll(path) {
  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; ; offset += pageSize) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await supabaseSelect(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows;
}

async function replaceSalesSuggestions(rows, storeNames = []) {
  const deletePath = storeNames.length === 1
    ? `sales_suggestions?shop_name=eq.${encodeURIComponent(storeNames[0])}`
    : 'sales_suggestions?id=neq.never-match';
  const deleteResponse = await fetch(supabaseUrl(deletePath), {
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (!deleteResponse.ok) {
    const payload = await deleteResponse.json().catch(() => ({}));
    throw new Error(payload.message || `清空采购建议失败：${deleteResponse.status}`);
  }
  if (rows.length === 0) return;

  const insertResponse = await fetch(supabaseUrl('sales_suggestions'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!insertResponse.ok) {
    const payload = await insertResponse.json().catch(() => ({}));
    throw new Error(payload.message || `写入采购建议失败：${insertResponse.status}`);
  }
}

function skuKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function effectivePurchaseQuantity(record) {
  return numberValue(record.purchase_quantity);
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

async function buildStoreSuggestions(storeName) {
  const [{ rows: takealotRows, pagesFetched, totalResults, fetchedRows, activeRows, disabledRows, duplicateRows }, skuItems, purchaseRecords] = await Promise.all([
    fetchTakealotRows(storeName),
    supabaseSelectAll('sku_items?select=sku,product_name,english_name,manufacturer_name,shop_name,buyer_name,units_per_carton,unit_cbm,total_cbm,total_quantity'),
    supabaseSelectAll('purchase_records?status=eq.in_transit&select=sku,purchase_quantity,shop_name'),
  ]);

  const newProductRankMap = buildNewProductRankMap(storeName, takealotRows);
  const skuMap = new Map(skuItems.filter((item) => skuKey(item.sku)).map((item) => [skuKey(item.sku), item]));
  const skuCatalogRows = skuItems.length;
  const skuCatalogSkuRows = skuItems.filter((item) => skuKey(item.sku)).length;
  const inTransitMap = new Map();
  for (const record of purchaseRecords) {
    const key = skuKey(record.sku);
    inTransitMap.set(key, (inTransitMap.get(key) ?? 0) + effectivePurchaseQuantity(record));
  }

  const suggestions = takealotRows.map((row, index) => {
    const sku = skuFor(row);
    const key = skuKey(sku);
    const skuItem = skuMap.get(key);
    const rawMonthlySales = sumSalesUnits(row.sales_units);
    const newProductRank = newProductRankMap.get(key) ?? 0;
    const forecast = forecastMonthlySales(storeName, newProductRank, rawMonthlySales);
    const monthlySales = forecast.monthlySales;
    const stockMonths = stockMonthsForMonthlySales(monthlySales);
    const localStockQuantity = sumQuantityAvailable(row.leadtime_stock ?? row.quantity_available);
    const takealotStockQuantity = row.stock_at_takealot_total === undefined ? sumQuantityAvailable(row.stock_at_takealot) : numberValue(row.stock_at_takealot_total);
    const stockOnWayQuantity = row.total_stock_on_way === undefined ? sumQuantityAvailable(row.stock_on_way) : numberValue(row.total_stock_on_way);
    const inTransitQuantity = inTransitMap.get(key) ?? 0;
    const targetQuantity = round(monthlySales * stockMonths, 2);
    const directSuggestion = storeName === 'Aicom' ? aicomDirectSuggestedQuantity(newProductRank, rawMonthlySales) : null;
    const suggestedQuantity = directSuggestion
      ? directSuggestion.suggestedQuantity
      : Math.max(round(targetQuantity - localStockQuantity - takealotStockQuantity - stockOnWayQuantity - inTransitQuantity, 2), 0);
    const manualUnitCbm = numberValue(skuItem?.unit_cbm);
    const totalCbm = numberValue(skuItem?.total_cbm);
    const totalQuantity = numberValue(skuItem?.total_quantity);
    const unitCbm = manualUnitCbm || (totalQuantity > 0 && totalCbm > 0 ? totalCbm / totalQuantity : 0);

    return {
      id: `cron-${storeName}-${sku || index}`,
      sku,
      product_name: skuItem?.english_name || skuItem?.product_name || row.title || '',
      shop_name: storeName,
      manufacturer_name: skuItem?.manufacturer_name || '',
      buyer_name: skuItem?.buyer_name || '',
      monthly_sales: monthlySales,
      stock_months: stockMonths,
      target_quantity: targetQuantity,
      local_stock_quantity: localStockQuantity,
      takealot_stock_quantity: takealotStockQuantity,
      stock_on_way_quantity: stockOnWayQuantity,
      in_transit_quantity: inTransitQuantity,
      suggested_quantity: suggestedQuantity,
      units_per_carton: skuItem?.units_per_carton ?? null,
      estimated_cartons: numberValue(skuItem?.units_per_carton) > 0 ? round(suggestedQuantity / numberValue(skuItem.units_per_carton), 2) : null,
      estimated_cbm: unitCbm > 0 ? round(suggestedQuantity * unitCbm, 4) : null,
      messages: [
        ...(skuItem ? [] : ['未录入 SKU 资料']),
        ...(directSuggestion?.message ? [directSuggestion.message] : forecast.message ? [forecast.message] : []),
      ],
    };
  });

  return {
    store: storeName,
    rows: suggestions.length,
    matchedSkuRows: suggestions.filter((row) => !row.messages.some((message) => message.includes('未录入 SKU 资料'))).length,
    missingSkuRows: suggestions.filter((row) => row.messages.some((message) => message.includes('未录入 SKU 资料'))).length,
    skuCatalogRows,
    skuCatalogSkuRows,
    matchedSkuSamples: suggestions
      .filter((row) => !row.messages.some((message) => message.includes('未录入 SKU 资料')))
      .slice(0, 5)
      .map((row) => row.sku),
    missingSkuSamples: suggestions
      .filter((row) => row.messages.some((message) => message.includes('未录入 SKU 资料')))
      .slice(0, 5)
      .map((row) => row.sku),
    fetchedRows,
    activeRows,
    disabledRows,
    duplicateRows,
    newProducts: suggestions.filter((row) => row.messages.some((message) => message.includes('新品预测'))).length,
    pagesFetched,
    totalResults,
    suggestions,
  };
}

async function runSync(request) {
  if (request.method !== 'GET' && request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get?.('authorization') ?? request.headers.authorization ?? '';
  if (cronSecret && authorization !== `Bearer ${cronSecret}`) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    const url = new URL(request.url);
    const requestedStore = url.searchParams.get('store')?.trim();
    const stores = requestedStore ? [requestedStore] : (syncStoresFromEnv().length > 0 ? syncStoresFromEnv() : DEFAULT_SYNC_STORES);
    const results = [];
    const errors = [];
    const allSuggestions = [];

    for (const store of stores) {
      try {
        const result = await buildStoreSuggestions(store);
        results.push({
          store: result.store,
          rows: result.rows,
          matchedSkuRows: result.matchedSkuRows,
          missingSkuRows: result.missingSkuRows,
          skuCatalogRows: result.skuCatalogRows,
          skuCatalogSkuRows: result.skuCatalogSkuRows,
          matchedSkuSamples: result.matchedSkuSamples,
          missingSkuSamples: result.missingSkuSamples,
          fetchedRows: result.fetchedRows,
          activeRows: result.activeRows,
          disabledRows: result.disabledRows,
          duplicateRows: result.duplicateRows,
          newProducts: result.newProducts,
          pagesFetched: result.pagesFetched,
          totalResults: result.totalResults,
        });
        allSuggestions.push(...result.suggestions);
      } catch (error) {
        console.error(error);
        errors.push({ store, error: error instanceof Error ? error.message : '同步失败' });
      }
    }

    if (requestedStore && errors.length > 0) return jsonResponse({ ok: false, errors }, 500);
    if (allSuggestions.length === 0 && errors.length > 0) return jsonResponse({ ok: false, errors }, 500);

    await replaceSalesSuggestions(allSuggestions, requestedStore ? stores : []);
    return jsonResponse({ ok: errors.length === 0, stores: results, errors, rows: allSuggestions.length });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : '自动同步失败' }, 500);
  }
}

export default {
  fetch: runSync,
};
