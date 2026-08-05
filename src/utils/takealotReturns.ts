import type { TakealotReturn } from '../types';

export async function fetchTakealotReturns(shopName: string, dateFrom: string, dateTo: string, onProgress?: (pages: number, rows: number) => void): Promise<TakealotReturn[]> {
  const rows: TakealotReturn[] = [];
  let continuationToken = '';
  let pages = 0;
  do {
    const params = new URLSearchParams({ store: shopName });
    if (continuationToken) params.set('continuation_token', continuationToken);
    else { params.set('date_from', dateFrom); params.set('date_to', dateTo); }
    const response = await fetch(`/api/takealot-returns?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload.error ?? `Takealot 退货同步失败：${response.status}`));
    rows.push(...(Array.isArray(payload.rows) ? payload.rows as TakealotReturn[] : []));
    continuationToken = String(payload.continuationToken ?? '');
    pages += 1;
    onProgress?.(pages, rows.length);
    if (pages >= 1000) throw new Error('退货分页超过 1000 页，已停止同步');
  } while (continuationToken);
  return rows;
}
