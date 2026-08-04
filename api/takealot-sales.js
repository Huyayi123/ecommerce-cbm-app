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
  const envName = `TAKEALOT_API_KEY_${storeName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  return process.env[envName] || process.env.TAKEALOT_API_KEY || '';
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  const store = String(request.query.store || '').trim();
  const apiKey = apiKeyForStore(store);
  if (!store) return response.status(400).json({ error: '缺少店铺参数' });
  if (!apiKey) return response.status(400).json({ error: `店铺 ${store} 未配置 Takealot API Key` });

  const continuationToken = String(request.query.continuation_token || '').trim();
  const requestedDateTo = String(request.query.date_to || '').trim();
  const requestedDateFrom = String(request.query.date_from || '').trim();
  const dateTo = requestedDateTo ? new Date(`${requestedDateTo}T00:00:00Z`) : new Date();
  const dateFrom = requestedDateFrom ? new Date(`${requestedDateFrom}T00:00:00Z`) : new Date(dateTo);
  if (!requestedDateFrom) dateFrom.setUTCDate(dateFrom.getUTCDate() - 179);
  if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) return response.status(400).json({ error: '销售日期参数无效' });
  const baseUrl = process.env.TAKEALOT_MARKETPLACE_API_BASE_URL || 'https://marketplace-api.takealot.com/v1';

  try {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/sales`);
    if (continuationToken) {
      url.searchParams.set('continuation_token', continuationToken);
    } else {
      url.searchParams.set('order_date__gte', isoDate(dateFrom));
      url.searchParams.set('order_date__lte', isoDate(dateTo));
      url.searchParams.set('limit', '100');
      ['sku', 'order_date', 'sale_status', 'selling_price', 'quantity', 'total_fees'].forEach((field) => url.searchParams.append('fields', field));
    }
    const upstream = await fetch(url, { headers: { Accept: 'application/json', 'X-API-Key': apiKey } });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return response.status(upstream.status).json({ error: payload.message || payload.error || 'Takealot 销售 API 请求失败' });
    const items = Array.isArray(payload.items) ? payload.items : [];
    const rows = items.map((item) => ({
      sku: String(item.sku ?? '').trim(),
      orderDate: String(item.order_date ?? ''),
      saleStatus: String(item.sale_status ?? ''),
      sellingPrice: nullableNumber(item.selling_price),
      quantity: Number(item.quantity ?? 0),
      totalFees: nullableNumber(item.total_fees),
    }));

    return response.status(200).json({
      store,
      dateFrom: isoDate(dateFrom),
      dateTo: isoDate(dateTo),
      rows,
      continuationToken: String(payload.continuation_token ?? ''),
    });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: error instanceof Error ? error.message : 'Takealot 销售 API 连接失败' });
  }
}
