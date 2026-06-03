import type { PurchaseRecord, PurchaseRow, PurchaseStatus, SkuItem } from '../types';
import { hydrateSku } from './calculations';
import { normalizeMixedGroups, withPurchaseTotals } from './purchaseRecords';

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
        imageUrl: String(item.imageUrl ?? item.image_url ?? ''),
        manufacturerName: String(item.manufacturerName ?? ''),
        shopName: String(item.shopName ?? item.category ?? ''),
        buyerName: String(item.buyerName ?? ''),
        isSeasonal: Boolean(item.isSeasonal ?? item.is_seasonal ?? false),
        purchasePrice: nullableNumber(item.purchasePrice) ?? 0,
        cartonLengthCm: Number(item.cartonLengthCm ?? 0),
        cartonWidthCm: Number(item.cartonWidthCm ?? 0),
        cartonHeightCm: Number(item.cartonHeightCm ?? 0),
        unitsPerCarton: Number(item.unitsPerCarton ?? 0),
        totalQuantity: Number(item.totalQuantity ?? 0),
        totalCbm: Number(item.totalCbm ?? 0),
        manualUnitCbm: Number(item.manualUnitCbm ?? item.unitCbm ?? 0),
        notes: String(item.notes ?? item.note ?? ''),
        cbmSource: item.cbmSource ?? 'missing',
        updatedAt: String(item.updatedAt ?? new Date().toISOString()),
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
      productName: String(row.productName ?? ''),
      englishName: String(row.englishName ?? ''),
      imageUrl: String(row.imageUrl ?? row.raw?.imageUrl ?? ''),
      manufacturerName: String(row.manufacturerName ?? ''),
      purchaseQuantity: nullableNumber(row.purchaseQuantity),
      manualTotalCbm: nullableNumber(row.manualTotalCbm ?? row.raw?.manualTotalCbm),
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
  if (value === 'ordered' || value === 'in_transit') return 'in_transit';
  if (value === 'pending' || value === 'arrived' || value === 'cancelled') return value;
  return 'pending';
}

export function loadPurchaseRecords(): PurchaseRecord[] {
  try {
    const raw = localStorage.getItem(PURCHASE_RECORD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((record) => {
      const quantity = nullableNumber(record.purchaseQuantity) ?? 0;
      const confirmedQuantity = nullableNumber(record.confirmedPurchaseQuantity);
      const price = nullableNumber(record.purchasePrice) ?? 0;
      const effectiveQuantity = confirmedQuantity ?? quantity;
      return withPurchaseTotals({
        id: String(record.id ?? crypto.randomUUID()),
        manufacturerName: String(record.manufacturerName ?? ''),
        sku: String(record.sku ?? ''),
        productName: String(record.productName ?? ''),
        englishName: String(record.englishName ?? ''),
        imageUrl: String(record.imageUrl ?? record.image_url ?? ''),
        shopName: String(record.shopName ?? ''),
        buyerName: String(record.buyerName ?? ''),
        assignedBuyerName: String(record.assignedBuyerName ?? record.buyerName ?? ''),
        assignedBuyerEmail: String(record.assignedBuyerEmail ?? ''),
        isConfirmed: Boolean(record.isConfirmed ?? record.status !== 'pending'),
        purchaseQuantity: quantity,
        confirmedPurchaseQuantity: confirmedQuantity,
        purchasePrice: price,
        totalAmount: nullableNumber(record.totalAmount) ?? effectiveQuantity * price,
        purchaseDate: String(record.purchaseDate ?? new Date().toISOString().slice(0, 10)),
        estimatedArrivalDate: String(record.estimatedArrivalDate ?? ''),
        status: purchaseStatus(record.status),
        unitCbm: nullableNumber(record.unitCbm) ?? 0,
        totalCbm: nullableNumber(record.totalCbm) ?? 0,
        loadingType: record.loadingType === '整柜' || record.loadingType === '冠通' ? record.loadingType : '',
        containerDate: String(record.containerDate ?? ''),
        totalWeightKg: nullableNumber(record.totalWeightKg),
        cartonCount: nullableNumber(record.cartonCount),
        unitsPerCarton: nullableNumber(record.unitsPerCarton ?? record.units_per_carton),
        tailQuantity: nullableNumber(record.tailQuantity ?? record.tail_quantity) ?? 0,
        isMixed: Boolean(record.isMixed ?? record.is_mixed ?? false),
        mixedGroups: normalizeMixedGroups(record.mixedGroups ?? record.mixed_groups),
        logisticsTotalCbm: nullableNumber(record.logisticsTotalCbm),
        note: String(record.note ?? ''),
      });
    });
  } catch {
    return [];
  }
}

export function savePurchaseRecords(records: PurchaseRecord[]): void {
  localStorage.setItem(PURCHASE_RECORD_STORAGE_KEY, JSON.stringify(records));
}
