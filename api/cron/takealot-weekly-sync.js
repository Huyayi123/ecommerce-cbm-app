import { availabilityStatusFor, enrichOffersWithHistoricalSales } from '../_lib/takealotHistoricalSales.js';

const DEFAULT_SYNC_STORES = ['Bestby', 'Aicom', 'Arfast'];
const LOCAL_STOCK_BUFFER = 4;
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

function shanghaiMonthAndDay(orderDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(orderDate);
  return {
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 0),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 0),
  };
}

function stockMonthsForMonthlySales(monthlySales, orderDate = new Date()) {
  const { month, day } = shanghaiMonthAndDay(orderDate);

  if (month === 7 || month === 9) {
    if (monthlySales > 100) return 7;
    if (monthlySales >= 80) return 6;
    if (monthlySales >= 50) return 5;
    if (monthlySales >= 20) return 4;
    if (monthlySales >= 10) return 3;
    return 2;
  }

  if (month === 8) {
    if (monthlySales > 100) return 8;
    if (monthlySales >= 80) return 7;
    if (monthlySales >= 20) return 6;
    if (monthlySales >= 10) return 4;
    return 3;
  }

  if (month === 10) {
    if (day <= 15) return monthlySales >= 50 ? 5 : 4.5;
    return monthlySales >= 50 ? 4 : 3.5;
  }

  if (month === 11) {
    if (day <= 15) return monthlySales >= 50 ? 4 : 3.5;
    if (monthlySales > 50) return 4;
    if (monthlySales >= 20) return 3;
    return 2;
  }

  if (monthlySales > 50) return 4;
  if (monthlySales >= 20) return 3;
  return 2;
}

function newProductRulesForStore(storeName) {
  return NEW_PRODUCT_RULES[storeName] || [];
}

function newProductMultiplierForRank(storeName, rank) {
  const rule = newProductRulesForStore(storeName).find((item) => rank > 0 && rank <= item.limit);
  return rule?.multiplier ?? 1;
}

function applySuggestedQuantityMinimum(monthlySales, quantity) {
  if (monthlySales >= 10 && quantity > 0 && quantity < 50) return 50;
  if (monthlySales >= 5 && monthlySales < 10 && quantity > 0 && quantity < 30) return 30;
  return quantity;
}

function aicomDirectTargetQuantity(rank, rawMonthlySales) {
  if (rank <= 0 || rank > 15) return null;
  if (rawMonthlySales <= 3) {
    return {
      targetQuantity: 0,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，未超过 3，暂不补订`,
    };
  }
  if (rawMonthlySales <= 5) {
    return {
      targetQuantity: 40,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 40 个`,
    };
  }
  if (rawMonthlySales <= 8) {
    return {
      targetQuantity: 50,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 50 个`,
    };
  }
  return {
    targetQuantity: 60,
    message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 60 个`,
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
      if (availabilityStatusFor(row) === 'disabled') {
        disabledRows += 1;
      } else {
        allRows.push(row);
      }
    }

    if (rows.length < pageSize) break;
    if (newRowsOnPage === 0) break;
    if (totalResults !== null && seenKeys.size >= totalResults) break;
  }

  const enrichedRows = await enrichOffersWithHistoricalSales(allRows, storeName, apiKey);
  return { rows: enrichedRows, pagesFetched, totalResults, fetchedRows, activeRows: enrichedRows.length, disabledRows, duplicateRows };
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
    body: JSON.stringify(rows.map(({ _container, ...row }) => row)),
  });
  if (!insertResponse.ok) {
    const payload = await insertResponse.json().catch(() => ({}));
    throw new Error(payload.message || `写入采购建议失败：${insertResponse.status}`);
  }
}

function buildContainerRows(suggestions, scannedAt = new Date().toISOString()) {
  return suggestions
    .filter((row) => numberValue(row.suggested_quantity) > 0)
    .map((row, index) => ({
      id: `weekly-${row.shop_name}-${row.sku || index + 1}`,
      row_number: index + 2,
      internal_code: row._container?.internalCode || null,
      sku: row.sku || '',
      product_name: row.product_name || '',
      english_name: row._container?.englishName || '',
      manufacturer_name: row.manufacturer_name || '',
      purchase_quantity: numberValue(row.suggested_quantity),
      raw: {
        source: 'weekly-sales-suggestion',
        scannedAt,
        shopName: row.shop_name || '',
        buyerName: row.buyer_name || '',
        imageUrl: row._container?.imageUrl || '',
        monthlySales: numberValue(row._container?.rawMonthlySales),
        stockMonths: numberValue(row.stock_months),
        messages: Array.isArray(row.messages) ? row.messages : [],
      },
    }));
}

async function insertRows(table, rows) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const response = await fetch(supabaseUrl(table), {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(rows.slice(offset, offset + 500)),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || `写入 ${table} 失败：${response.status}`);
    }
  }
}

async function deleteAllContainerRows() {
  const response = await fetch(supabaseUrl('container_rows?id=neq.never-match'), {
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `清空装柜计算失败：${response.status}`);
  }
}

async function replaceContainerRows(rows) {
  const previousRows = await supabaseSelectAll('container_rows?select=id,row_number,internal_code,sku,product_name,english_name,manufacturer_name,purchase_quantity,raw');
  await deleteAllContainerRows();
  try {
    await insertRows('container_rows', rows);
  } catch (error) {
    try {
      await deleteAllContainerRows();
      await insertRows('container_rows', previousRows);
    } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : '写入装柜计算失败'}；恢复原装柜数据也失败：${rollbackError instanceof Error ? rollbackError.message : '未知错误'}`);
    }
    throw error;
  }
}

async function fetchSkuItemsForSync() {
  try {
    return await supabaseSelectAll('sku_items?select=sku,internal_code,product_name,english_name,image_url,manufacturer_name,shop_name,buyer_name,is_seasonal,units_per_carton,unit_cbm,total_cbm,total_quantity');
  } catch (error) {
    if (!String(error?.message ?? error).includes('is_seasonal')) throw error;
    return supabaseSelectAll('sku_items?select=sku,internal_code,product_name,english_name,image_url,manufacturer_name,shop_name,buyer_name,units_per_carton,unit_cbm,total_cbm,total_quantity');
  }
}

function skuKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function effectivePurchaseQuantity(record) {
  return record.confirmed_purchase_quantity === null || record.confirmed_purchase_quantity === undefined
    ? numberValue(record.purchase_quantity)
    : numberValue(record.confirmed_purchase_quantity);
}

function isInTransitStatus(status) {
  return ['in_transit', 'ordered', '海运在途', '已下单'].includes(String(status ?? '').trim());
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

async function buildStoreSuggestions(storeName) {
  const [{ rows: takealotRows, pagesFetched, totalResults, fetchedRows, activeRows, disabledRows, duplicateRows }, skuItems, purchaseRecords] = await Promise.all([
    fetchTakealotRows(storeName),
    fetchSkuItemsForSync(),
    supabaseSelectAll('purchase_records?select=sku,purchase_quantity,shop_name,status'),
  ]);

  const newProductRankMap = buildNewProductRankMap(storeName, takealotRows);
  const skuMap = new Map(skuItems.filter((item) => skuKey(item.sku)).map((item) => [skuKey(item.sku), item]));
  const skuCatalogRows = skuItems.length;
  const skuCatalogSkuRows = skuItems.filter((item) => skuKey(item.sku)).length;
  const inTransitMap = new Map();
  for (const record of purchaseRecords) {
    if (!isInTransitStatus(record.status)) continue;
    const key = skuKey(record.sku);
    inTransitMap.set(key, (inTransitMap.get(key) ?? 0) + effectivePurchaseQuantity(record));
  }

  const suggestions = takealotRows.map((row, index) => {
    const sku = skuFor(row);
    const key = skuKey(sku);
    const skuItem = skuMap.get(key);
    const isNotBuyable = row.__availabilityStatus === 'not_buyable';
    const rawMonthlySales = isNotBuyable ? numberValue(row.__historicalMonthlySales) : sumSalesUnits(row.sales_units);
    const newProductRank = newProductRankMap.get(key) ?? 0;
    const forecast = isNotBuyable
      ? { monthlySales: rawMonthlySales, message: String(row.__historicalSalesMessage || '') }
      : forecastMonthlySales(storeName, newProductRank, rawMonthlySales);
    const monthlySales = forecast.monthlySales;
    const stockMonths = stockMonthsForMonthlySales(monthlySales);
    const localStockQuantity = sumQuantityAvailable(row.leadtime_stock ?? row.quantity_available) + LOCAL_STOCK_BUFFER;
    const takealotStockQuantity = row.stock_at_takealot_total === undefined ? sumQuantityAvailable(row.stock_at_takealot) : numberValue(row.stock_at_takealot_total);
    const stockOnWayQuantity = row.total_stock_on_way === undefined ? sumQuantityAvailable(row.stock_on_way) : numberValue(row.total_stock_on_way);
    const inTransitQuantity = inTransitMap.get(key) ?? 0;
    const calculatedTargetQuantity = round(monthlySales * stockMonths, 2);
    const directTarget = !isNotBuyable && storeName === 'Aicom' ? aicomDirectTargetQuantity(newProductRank, rawMonthlySales) : null;
    const targetQuantity = directTarget?.targetQuantity ?? calculatedTargetQuantity;
    const rawSuggestedQuantity = Math.max(round(targetQuantity - localStockQuantity - takealotStockQuantity - stockOnWayQuantity - inTransitQuantity, 2), 0);
    const suggestedQuantity = applySuggestedQuantityMinimum(monthlySales, rawSuggestedQuantity);
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
        ...(skuItem?.is_seasonal ? ['季节性产品，请结合旺季/淡季人工确认采购量'] : []),
        ...(directTarget?.message ? [`${directTarget.message}，扣减库存和海运在途后建议 ${suggestedQuantity} 个`] : forecast.message ? [forecast.message] : []),
      ],
      _container: {
        internalCode: skuItem?.internal_code || '',
        englishName: skuItem?.english_name || '',
        imageUrl: skuItem?.image_url || '',
        rawMonthlySales,
      },
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
    const stores = requestedStore ? [requestedStore] : DEFAULT_SYNC_STORES;
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

    let containerRows = null;
    if (!requestedStore && errors.length === 0) {
      const rows = buildContainerRows(allSuggestions);
      await replaceContainerRows(rows);
      containerRows = rows.length;
    }

    return jsonResponse({
      ok: errors.length === 0,
      stores: results,
      errors,
      rows: allSuggestions.length,
      positiveSuggestionRows: allSuggestions.filter((row) => numberValue(row.suggested_quantity) > 0).length,
      containerRows,
    });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : '自动同步失败' }, 500);
  }
}

export { applySuggestedQuantityMinimum, buildContainerRows, stockMonthsForMonthlySales };

export default {
  fetch: runSync,
};
