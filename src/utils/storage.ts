import type { PurchaseRecord, PurchaseRow, PurchaseStatus, SkuItem } from '../types';
import { hydrateSku } from './calculations';

const STORAGE_KEY = 'container-cbm-calculator:sku-items';

export function loadSkuItems(): SkuItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item) =>
      hydrateSku({
        id: String(item.id ?? crypto.randomUUID()),
        sku: String(item.sku ?? ''),
        productName: String(item.productName ?? ''),
        englishName: String(item.englishName ?? ''),
        manufacturerName: String(item.manufacturerName ?? ''),
        shopName: String(item.shopName ?? item.category ?? ''),
        buyerName: String(item.buyerName ?? ''),
        purchasePrice: nullableNumber(item.purchasePrice) ?? 0,
        cartonLengthCm: Number(item.cartonLengthCm ?? 0),
        cartonWidthCm: Number(item.cartonWidthCm ?? 0),
        cartonHeightCm: Number(item.cartonHeightCm ?? 0),
        unitsPerCarton: Number(item.unitsPerCarton ?? 0),
        totalQuantity: Number(item.totalQuantity ?? 0),
        totalCbm: Number(item.totalCbm ?? 0),
        note: String(item.note ?? ''),
      }),
    );
  } catch {
    return [];
  }
}

export function saveSkuItems(items: SkuItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

const PURCHASE_STORAGE_KEY = 'container-cbm-calculator:purchase-rows';
const PURCHASE_RECORD_STORAGE_KEY = 'container-cbm-calculator:purchase-records';

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadPurchaseRows(): PurchaseRow[] {
  try {
    const raw = localStorage.getItem(PURCHASE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((row, index) => ({
      rowId: String(row.rowId ?? crypto.randomUUID()),
      rowNumber: Number(row.rowNumber ?? index + 2),
      sku: String(row.sku ?? ''),
      purchaseQuantity: nullableNumber(row.purchaseQuantity),
      raw: typeof row.raw === 'object' && row.raw !== null ? row.raw : {},
    }));
  } catch {
    return [];
  }
}

export function savePurchaseRows(rows: PurchaseRow[]): void {
  localStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(rows));
}

function purchaseStatus(value: unknown): PurchaseStatus {
  if (value === 'arrived' || value === 'cancelled' || value === 'in_transit') return value;
  return 'in_transit';
}

export function loadPurchaseRecords(): PurchaseRecord[] {
  try {
    const raw = localStorage.getItem(PURCHASE_RECORD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((record) => {
      const quantity = nullableNumber(record.purchaseQuantity) ?? 0;
      const price = nullableNumber(record.purchasePrice) ?? 0;
      return {
        id: String(record.id ?? crypto.randomUUID()),
        manufacturerName: String(record.manufacturerName ?? ''),
        sku: String(record.sku ?? ''),
        productName: String(record.productName ?? ''),
        shopName: String(record.shopName ?? ''),
        buyerName: String(record.buyerName ?? ''),
        purchaseQuantity: quantity,
        purchasePrice: price,
        totalAmount: quantity * price,
        purchaseDate: String(record.purchaseDate ?? new Date().toISOString().slice(0, 10)),
        estimatedArrivalDate: String(record.estimatedArrivalDate ?? ''),
        status: purchaseStatus(record.status),
        totalCbm: nullableNumber(record.totalCbm) ?? 0,
        note: String(record.note ?? ''),
      };
    });
  } catch {
    return [];
  }
}

export function savePurchaseRecords(records: PurchaseRecord[]): void {
  localStorage.setItem(PURCHASE_RECORD_STORAGE_KEY, JSON.stringify(records));
}
