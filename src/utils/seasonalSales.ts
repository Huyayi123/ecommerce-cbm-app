import { useEffect, useState } from 'react';

const stores = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];
const storeNames = new Map(stores.map((store) => [store.toLowerCase(), store]));
const cache = new Map<string, Promise<Record<string, number>>>();

function referenceMonth() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric',
  }).formatToParts();
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return new Date(Date.UTC(year - 1, month, 1)).toISOString().slice(0, 7);
}

function fetchSales(store: string, month: string) {
  const key = month + ':' + store;
  const existing = cache.get(key);
  if (existing) return existing;
  const query = new URLSearchParams({ store, view: 'seasonal-sales' });
  const request = fetch('/api/takealot-inventory?' + query).then(async (response) => {
    if (!response.ok) throw new Error('历史销量查询失败');
    const result = await response.json();
    if (result.month !== month || !result.sales) throw new Error('历史销量月份不匹配');
    return result.sales as Record<string, number>;
  }).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, request);
  return request;
}

export function useSeasonalSales(rows: { shopName?: string; sku: string }[]) {
  const [month, setMonth] = useState(referenceMonth);
  const [data, setData] = useState<Record<string, Record<string, number>>>({});
  const storeKeys = [...new Set(rows.map((row) => storeNames.get(row.shopName?.trim().toLowerCase() ?? '')).filter(Boolean))].sort().join(',');
  useEffect(() => {
    const timer = window.setInterval(() => setMonth(referenceMonth()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    for (const store of storeKeys.split(',').filter(Boolean)) {
      void fetchSales(store, month).then((sales) => {
        if (active) setData((current) => ({ ...current, [month + ':' + store]: sales }));
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [month, storeKeys]);

  return {
    label: '去年下月销量（' + month + '）',
    value(shopName: string | undefined, sku: string) {
      const store = storeNames.get(shopName?.trim().toLowerCase() ?? '');
      const sales = data[month + ':' + store];
      const key = sku.trim().replace(/\s+/g, '').toUpperCase();
      return sales && key ? (Object.hasOwn(sales, key) ? sales[key] : 0) : '—';
    },
  };
}
