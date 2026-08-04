import type { TakealotSale } from '../types';

export type TakealotSalesResponse = {
  store: string;
  dateFrom: string;
  dateTo: string;
  pagesFetched: number;
  rows: TakealotSale[];
};

export async function fetchTakealotSales(shopName: string): Promise<TakealotSalesResponse> {
  const response = await fetch(`/api/takealot-sales?store=${encodeURIComponent(shopName)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error ?? `Takealot 销售同步失败：${response.status}`));
  return {
    store: String(payload.store ?? shopName),
    dateFrom: String(payload.dateFrom ?? ''),
    dateTo: String(payload.dateTo ?? ''),
    pagesFetched: Number(payload.pagesFetched ?? 0),
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  };
}
