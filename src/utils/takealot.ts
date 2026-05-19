export type TakealotInventoryRow = {
  sku: string;
  shopName: string;
  localStockQuantity: number;
  takealotStockQuantity: number;
  stockOnWayQuantity: number;
  raw?: unknown;
};

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeTakealotInventoryRow(input: Record<string, unknown>, shopName: string): TakealotInventoryRow {
  const leadtimeStock = input.leadtime_stock && typeof input.leadtime_stock === 'object'
    ? input.leadtime_stock as Record<string, unknown>
    : {};
  const stockOnWay = input.stock_on_way && typeof input.stock_on_way === 'object'
    ? input.stock_on_way as Record<string, unknown>
    : {};

  return {
    sku: String(input.sku ?? input.seller_sku ?? input.merchant_sku ?? input.offer_sku ?? '').trim(),
    shopName,
    localStockQuantity: numberValue(leadtimeStock.quantity_available ?? input.quantity_available),
    takealotStockQuantity: numberValue(input.stock_at_takealot_total ?? input.stock_at_takealot),
    stockOnWayQuantity: numberValue(input.total_stock_on_way ?? stockOnWay.total_stock_on_way ?? stockOnWay.quantity_available ?? input.stock_on_way),
    raw: input,
  };
}

export async function fetchTakealotInventory(shopName: string, skus: string[]): Promise<TakealotInventoryRow[]> {
  const params = new URLSearchParams();
  params.set('store', shopName);
  if (skus.length > 0) params.set('skus', Array.from(new Set(skus.filter(Boolean))).join(','));

  const response = await fetch(`/api/takealot-inventory?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Takealot 库存同步失败：${response.status}`));
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return rows.map((row: unknown) => normalizeTakealotInventoryRow(row as Record<string, unknown>, shopName));
}
