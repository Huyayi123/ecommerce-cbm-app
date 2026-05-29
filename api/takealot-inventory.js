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
  return String(row?.sku ?? row?.seller_sku ?? row?.merchant_sku ?? row?.offer_sku ?? '').trim().toUpperCase();
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

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const store = String(request.query.store || '').trim();
  const apiKey = apiKeyForStore(store);
  if (!store) {
    response.status(400).json({ error: '缺少店铺参数' });
    return;
  }
  if (!apiKey) {
    response.status(400).json({ error: `店铺 ${store} 未配置 Takealot API Key` });
    return;
  }

  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const inventoryPath = process.env.TAKEALOT_INVENTORY_PATH || '/v2/offers';
  const pageSize = numberFromEnv('TAKEALOT_PAGE_SIZE', 100);
  const maxPages = numberFromEnv('TAKEALOT_MAX_PAGES', 50);
  const requestedSkus = new Set(String(request.query.skus || '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean));
  const headers = {
    Accept: 'application/json',
    Authorization: `Key ${apiKey}`,
  };

  try {
    const allRows = [];
    const seenKeys = new Set();
    let totalResults = null;
    let pagesFetched = 0;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const url = new URL(inventoryPath, baseUrl);
      url.searchParams.set('page_size', String(pageSize));
      url.searchParams.set('page_number', String(pageNumber));

      const upstream = await fetch(url, { headers });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        response.status(upstream.status).json({ error: payload.message || payload.error || 'Takealot API 请求失败', details: payload });
        return;
      }

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
        if (requestedSkus.size === 0 || requestedSkus.has(skuFor(row))) allRows.push(row);
      }

      if (rows.length < pageSize) break;
      if (newRowsOnPage === 0) break;
      if (totalResults !== null && seenKeys.size >= totalResults) break;
    }

    response.status(200).json({ store, rows: allRows, totalResults, pagesFetched });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Takealot API 连接失败' });
  }
}
