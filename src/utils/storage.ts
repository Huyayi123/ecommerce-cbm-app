import type { PurchaseRecord, PurchaseRow, PurchaseStatus, SkuItem } from '../types';
import { hydrateSku } from './calculations';
import { ensureInternalCodes } from './internalCodes';
import { normalizeMixedGroups, withPurchaseTotals } from './purchaseRecords';

const STORAGE_KEY = 'container-cbm-calculator:sku-items';

export function loadSkuItems(): SkuItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return ensureInternalCodes(parsed.map((item) =>
      hydrateSku({
        id: String(item.id ?? crypto.randomUUID()),
        internalCode: String(item.internalCode ?? item.internal_code ?? ''),
        sku: String(item.sku ?? ''),
        tsin: String(item.tsin ?? ''),
        productName: String(item.productName ?? ''),
        englishName: String(item.englishName ?? ''),
        imageUrl: String(item.imageUrl ?? item.image_url ?? ''),
        manufacturerName: String(item.manufacturerName ?? ''),
        storageLocation: String(item.storageLocation ?? item.storage_location ?? ''),
        purchaseUrl: String(item.purchaseUrl ?? item.purchase_url ?? ''),
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
    ));
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
      internalCode: String(row.internalCode ?? row.internal_code ?? row.raw?.internalCode ?? ''),
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

function poolStatus(value: unknown, status: PurchaseStatus, isConfirmed: boolean): PurchaseRecord['poolStatus'] {
  if (value === 'pending_purchase' || value === 'submitted_to_pool' || value === 'sent_to_inventory') return value;
  return isConfirmed && (status === 'in_transit' || status === 'arrived') ? 'sent_to_inventory' : 'pending_purchase';
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
      const status = purchaseStatus(record.status);
      const isConfirmed = Boolean(record.isConfirmed ?? status !== 'pending');
      return withPurchaseTotals({
        id: String(record.id ?? crypto.randomUUID()),
        internalCode: String(record.internalCode ?? record.internal_code ?? ''),
        manufacturerName: String(record.manufacturerName ?? ''),
        sku: String(record.sku ?? ''),
        productName: String(record.productName ?? ''),
        englishName: String(record.englishName ?? ''),
        imageUrl: String(record.imageUrl ?? record.image_url ?? ''),
        shopName: String(record.shopName ?? ''),
        buyerName: String(record.buyerName ?? ''),
        assignedBuyerName: String(record.assignedBuyerName ?? record.buyerName ?? ''),
        assignedBuyerEmail: String(record.assignedBuyerEmail ?? ''),
        isConfirmed,
        purchaseQuantity: quantity,
        confirmedPurchaseQuantity: confirmedQuantity,
        purchasePrice: price,
        freightCost: nullableNumber(record.freightCost ?? record.freight_cost) ?? 0,
        totalAmount: nullableNumber(record.totalAmount) ?? effectiveQuantity * price,
        purchaseDate: String(record.purchaseDate ?? new Date().toISOString().slice(0, 10)),
        purchasePoolId: String(record.purchasePoolId ?? record.purchase_pool_id ?? record.purchaseBatchId ?? record.purchase_batch_id ?? ''),
        purchasePoolName: String(record.purchasePoolName ?? record.purchase_pool_name ?? record.purchaseBatchName ?? record.purchase_batch_name ?? ''),
        purchasePoolDate: String(record.purchasePoolDate ?? record.purchase_pool_date ?? record.purchaseBatchDate ?? record.purchase_batch_date ?? ''),
        poolStatus: poolStatus(record.poolStatus ?? record.pool_status, status, isConfirmed),
        purchaseBatchId: String(record.purchaseBatchId ?? record.purchase_batch_id ?? ''),
        purchaseBatchName: String(record.purchaseBatchName ?? record.purchase_batch_name ?? ''),
        purchaseBatchDate: String(record.purchaseBatchDate ?? record.purchase_batch_date ?? ''),
        estimatedArrivalDate: String(record.estimatedArrivalDate ?? ''),
        status,
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
        logisticsBatchId: String(record.logisticsBatchId ?? record.logistics_batch_id ?? ''),
        logisticsConfirmationStatus: (
          record.logisticsConfirmationStatus === 'draft'
          || record.logisticsConfirmationStatus === 'submitted'
          || record.logisticsConfirmationStatus === 'approved'
          || record.logisticsConfirmationStatus === 'rejected'
        ) ? record.logisticsConfirmationStatus : 'unassigned',
        logisticsLoadedCartonCount: nullableNumber(record.logisticsLoadedCartonCount ?? record.logistics_loaded_carton_count),
        logisticsLoadedTailQuantity: nullableNumber(record.logisticsLoadedTailQuantity ?? record.logistics_loaded_tail_quantity) ?? 0,
        logisticsLeftCartonCount: nullableNumber(record.logisticsLeftCartonCount ?? record.logistics_left_carton_count),
        logisticsLeftTailQuantity: nullableNumber(record.logisticsLeftTailQuantity ?? record.logistics_left_tail_quantity) ?? 0,
        logisticsSourceRecordId: String(record.logisticsSourceRecordId ?? record.logistics_source_record_id ?? ''),
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
