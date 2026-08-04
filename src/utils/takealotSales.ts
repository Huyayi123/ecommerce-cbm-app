import type { TakealotSale } from '../types';

export type TakealotSalesResponse = {
  store: string;
  dateFrom: string;
  dateTo: string;
  pagesFetched: number;
  rows: TakealotSale[];
};

export async function fetchTakealotSales(shopName: string, onProgress?: (pages: number, rows: number) => void): Promise<TakealotSalesResponse> {
  const allRows: TakealotSale[] = [];
  let continuationToken = '';
  let dateFrom = '';
  let dateTo = '';
  let pagesFetched = 0;

  do {
    const params = new URLSearchParams({ store: shopName });
    if (continuationToken) params.set('continuation_token', continuationToken);
    const response = await fetch(`/api/takealot-sales?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload.error ?? `Takealot 销售同步失败：${response.status}`));
    const rows = Array.isArray(payload.rows) ? payload.rows as TakealotSale[] : [];
    allRows.push(...rows);
    dateFrom ||= String(payload.dateFrom ?? '');
    dateTo ||= String(payload.dateTo ?? '');
    continuationToken = String(payload.continuationToken ?? '');
    pagesFetched += 1;
    onProgress?.(pagesFetched, allRows.length);
    if (pagesFetched >= 1000) throw new Error('销售明细分页超过 1000 页，已停止同步以避免异常循环');
  } while (continuationToken);

  return { store: shopName, dateFrom, dateTo, pagesFetched, rows: allRows };
}
