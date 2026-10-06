function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function skuKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function statusTextFor(row) {
  return [
    row?.status,
    row?.offer_status,
    row?.buyability,
    row?.buyable,
    row?.is_buyable,
    row?.isBuyable,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join(' ').toLowerCase();
}

export function availabilityStatusFor(row) {
  const statusText = statusTextFor(row);
  if (/\bdisabled\b/.test(statusText)) return 'disabled';
  if (/\bnot[\s_-]*buyable\b/.test(statusText)) return 'not_buyable';
  if (/\bbuyable\b/.test(statusText) || /\benabled\b/.test(statusText)
    || row?.buyable === true || row?.is_buyable === true || row?.isBuyable === true) return 'buyable';
  return 'unknown';
}

export function previousTwoCompleteMonths(referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(referenceDate);
  const year = Number(parts.find((part) => part.type === 'year')?.value ?? 0);
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? 0);
  const olderStart = new Date(Date.UTC(year, month - 3, 1));
  const newerStart = new Date(Date.UTC(year, month - 2, 1));
  const rangeEnd = new Date(Date.UTC(year, month - 1, 0));
  const isoDate = (date) => date.toISOString().slice(0, 10);
  const monthKey = (date) => date.toISOString().slice(0, 7);
  return {
    dateFrom: isoDate(olderStart),
    dateTo: isoDate(rangeEnd),
    months: [monthKey(olderStart), monthKey(newerStart)],
  };
}

function isValidSale(row) {
  if (!skuKey(row?.sku)) return false;
  if (numberValue(row?.quantity) <= 0) return false;
  const orderDate = String(row?.order_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(orderDate)) return false;
  const status = String(row?.sale_status ?? '').trim().toLowerCase();
  return !/(cancel|refund|return|failed)/.test(status);
}

function salesRowsFromPayload(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

export async function fetchHistoricalMonthlySales(storeName, apiKey, referenceDate = new Date()) {
  if (!apiKey) throw new Error(`店铺 ${storeName} 未配置 Takealot API Key`);
  const range = previousTwoCompleteMonths(referenceDate);
  const baseUrl = process.env.TAKEALOT_MARKETPLACE_API_BASE_URL || 'https://marketplace-api.takealot.com/v1';
  const maxPages = Math.max(1, Number(process.env.TAKEALOT_SALES_MAX_PAGES) || 500);
  const monthlyBySku = new Map();
  const seenRows = new Set();
  let continuationToken = '';
  let pagesFetched = 0;
  let ignoredRows = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/sales`);
    if (continuationToken) {
      url.searchParams.set('continuation_token', continuationToken);
    } else {
      url.searchParams.set('order_date__gte', range.dateFrom);
      url.searchParams.set('order_date__lte', range.dateTo);
      url.searchParams.set('limit', '100');
      ['order_item_id', 'order_id', 'sku', 'order_date', 'sale_status', 'quantity'].forEach((field) => url.searchParams.append('fields', field));
    }

    const response = await fetch(url, { headers: { Accept: 'application/json', 'X-API-Key': apiKey } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Takealot 历史销量请求失败：${response.status}`);
    const rows = salesRowsFromPayload(payload);
    pagesFetched = page;

    for (const row of rows) {
      const identity = String(row?.order_item_id ?? `${row?.order_id ?? ''}|${row?.sku ?? ''}|${row?.order_date ?? ''}|${row?.quantity ?? ''}`);
      if (seenRows.has(identity)) continue;
      seenRows.add(identity);
      if (!isValidSale(row)) {
        ignoredRows += 1;
        continue;
      }
      const month = String(row.order_date).slice(0, 7);
      if (!range.months.includes(month)) {
        ignoredRows += 1;
        continue;
      }
      const key = skuKey(row.sku);
      const values = monthlyBySku.get(key) ?? new Map();
      values.set(month, (values.get(month) ?? 0) + numberValue(row.quantity));
      monthlyBySku.set(key, values);
    }

    const nextToken = String(payload?.continuation_token ?? '').trim();
    if (!nextToken || nextToken === continuationToken) break;
    continuationToken = nextToken;
    if (page === maxPages) throw new Error(`Takealot 历史销量分页超过上限 ${maxPages} 页`);
  }

  return { range, monthlyBySku, pagesFetched, ignoredRows };
}

export async function enrichOffersWithHistoricalSales(rows, storeName, apiKey, referenceDate = new Date()) {
  const activeRows = rows.filter((row) => availabilityStatusFor(row) !== 'disabled');
  const needsHistory = activeRows.some((row) => availabilityStatusFor(row) === 'not_buyable');
  if (!needsHistory) {
    return activeRows.map((row) => ({ ...row, __availabilityStatus: availabilityStatusFor(row) }));
  }

  const history = await fetchHistoricalMonthlySales(storeName, apiKey, referenceDate);
  return activeRows.map((row) => {
    const availabilityStatus = availabilityStatusFor(row);
    if (availabilityStatus !== 'not_buyable') return { ...row, __availabilityStatus: availabilityStatus };
    const values = history.monthlyBySku.get(skuKey(row?.sku ?? row?.seller_sku ?? row?.merchant_sku ?? row?.offer_sku)) ?? new Map();
    const [olderMonth, newerMonth] = history.range.months;
    const olderSales = numberValue(values.get(olderMonth));
    const newerSales = numberValue(values.get(newerMonth));
    const historicalMonthlySales = Math.max(olderSales, newerSales);
    return {
      ...row,
      __availabilityStatus: availabilityStatus,
      __historicalMonthlySales: historicalMonthlySales,
      __historicalSalesMessage: `Not Buyable：${olderMonth}销量${olderSales}，${newerMonth}销量${newerSales}，取最高值${historicalMonthlySales}`,
    };
  });
}

