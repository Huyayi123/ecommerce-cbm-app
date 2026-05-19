export type TakealotInventoryRow = {
  sku: string;
  shopName: string;
  apiSalesQuantity: number;
  localStockQuantity: number;
  takealotStockQuantity: number;
  stockOnWayQuantity: number;
  raw?: unknown;
};

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumQuantityAvailable(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => {
      if (item && typeof item === 'object') {
        return total + numberValue((item as Record<string, unknown>).quantity_available);
      }
      return total + numberValue(item);
    }, 0);
  }

  if (value && typeof value === 'object') {
    return numberValue((value as Record<string, unknown>).quantity_available);
  }

  return numberValue(value);
}

function sumSalesUnits(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => {
      if (item && typeof item === 'object') {
        return total + numberValue((item as Record<string, unknown>).sales_units);
      }
      return total + numberValue(item);
    }, 0);
  }

  if (value && typeof value === 'object') {
    return numberValue((value as Record<string, unknown>).sales_units);
  }

  return numberValue(value);
}

export function normalizeTakealotInventoryRow(input: Record<string, unknown>, shopName: string): TakealotInventoryRow {
  const localStockQuantity = input.leadtime_stock === undefined
    ? numberValue(input.quantity_available)
    : sumQuantityAvailable(input.leadtime_stock);
  const takealotStockQuantity = input.stock_at_takealot_total === undefined
    ? sumQuantityAvailable(input.stock_at_takealot)
    : numberValue(input.stock_at_takealot_total);
  const stockOnWayQuantity = input.total_stock_on_way === undefined
    ? sumQuantityAvailable(input.stock_on_way)
    : numberValue(input.total_stock_on_way);

  return {
    sku: String(input.sku ?? input.seller_sku ?? input.merchant_sku ?? input.offer_sku ?? '').trim(),
    shopName,
    apiSalesQuantity: sumSalesUnits(input.sales_units),
    localStockQuantity,
    takealotStockQuantity,
    stockOnWayQuantity,
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
