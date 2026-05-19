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
  const url = new URL(inventoryPath, baseUrl);
  url.searchParams.set('page_size', process.env.TAKEALOT_PAGE_SIZE || '100');

  const headers = {
    Accept: 'application/json',
    Authorization: `Key ${apiKey}`,
  };

  try {
    const upstream = await fetch(url, { headers });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      response.status(upstream.status).json({ error: payload.message || payload.error || 'Takealot API 请求失败', details: payload });
      return;
    }

    const requestedSkus = new Set(String(request.query.skus || '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean));
    const rows = rowsFromPayload(payload).filter((row) => requestedSkus.size === 0 || requestedSkus.has(skuFor(row)));
    response.status(200).json({ store, rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Takealot API 连接失败' });
  }
}
