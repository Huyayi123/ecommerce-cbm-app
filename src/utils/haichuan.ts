import type { HaichuanProductDetail, HaichuanWarehouseLot, PurchaseRecord, SkuItem } from '../types';
import { effectivePurchaseQuantity, purchaseQuantityWithMixed, withPurchaseTotals } from './purchaseRecords';
import { round } from './number';

export function declaredTotalCartonCount(record: Pick<PurchaseRecord, 'cartonCount' | 'tailQuantity'>): number {
  return Math.max(0, Math.trunc(Number(record.cartonCount) || 0)) + (Number(record.tailQuantity) > 0 ? 1 : 0);
}

export function haichuanPurchaseTotalQuantity(record: PurchaseRecord): number {
  return Math.max(0, purchaseQuantityWithMixed(withPurchaseTotals(record)));
}

export function haichuanProductDetails(record: PurchaseRecord, skuItems: SkuItem[] = []): HaichuanProductDetail[] {
  const normalized = withPurchaseTotals(record);
  const skuByKey = new Map(skuItems.filter((item) => item.sku.trim()).map((item) => [item.sku.trim().toUpperCase(), item]));
  const mainQuantity = effectivePurchaseQuantity(normalized);
  const details: HaichuanProductDetail[] = [{
    id: `main-${normalized.id}`,
    internalCode: normalized.internalCode,
    sku: normalized.sku,
    productName: normalized.productName,
    englishName: normalized.englishName,
    quantity: mainQuantity,
    unitCbm: normalized.unitCbm,
    totalCbm: round(mainQuantity * normalized.unitCbm, 4),
    isMixed: false,
    mixedGroupId: '',
    mixedGroupName: '',
    mixedGroupCartonCount: 0,
  }];
  for (const group of normalized.mixedGroups) {
    for (const line of group.lines) {
      const sku = skuByKey.get(line.sku.trim().toUpperCase());
      details.push({
        id: line.id,
        internalCode: sku?.internalCode || '',
        sku: line.sku,
        productName: line.productName || sku?.productName || '',
        englishName: line.englishName || sku?.englishName || '',
        quantity: line.quantity,
        unitCbm: line.unitCbm,
        totalCbm: line.totalCbm,
        isMixed: true,
        mixedGroupId: group.id,
        mixedGroupName: group.groupName,
        mixedGroupCartonCount: group.cartonCount,
      });
    }
  }
  return details.filter((detail) => detail.quantity > 0 || detail.sku || detail.productName);
}

export function calculateHaichuanLoadingSuggestion(
  lot: Pick<HaichuanWarehouseLot,
    'remainingCartonCount' | 'remainingProductQuantity' | 'remainingCbm' | 'declaredCartonCount' |
    'declaredUnitsPerCarton' | 'declaredTailQuantity' | 'unitCbm' | 'hasPackingVariance'>,
  requestedCartonCount: number,
): { productQuantity: number; cbm: number; isEstimated: boolean } {
  const remainingCartons = Math.max(0, Math.trunc(lot.remainingCartonCount));
  const requested = Math.max(0, Math.min(Math.trunc(requestedCartonCount), remainingCartons));
  if (requested === 0 || remainingCartons === 0) return { productQuantity: 0, cbm: 0, isEstimated: false };
  if (requested === remainingCartons) {
    return { productQuantity: lot.remainingProductQuantity, cbm: lot.remainingCbm, isEstimated: false };
  }

  if (lot.hasPackingVariance) {
    return {
      productQuantity: Math.floor((lot.remainingProductQuantity * requested) / remainingCartons),
      cbm: (lot.remainingCbm * requested) / remainingCartons,
      isEstimated: true,
    };
  }

  const standardCartons = Math.min(requested, Math.max(0, Math.trunc(lot.declaredCartonCount)));
  const includesTail = requested > standardCartons && lot.declaredTailQuantity > 0;
  const productQuantity = Math.min(
    lot.remainingProductQuantity,
    standardCartons * Math.max(0, lot.declaredUnitsPerCarton) + (includesTail ? lot.declaredTailQuantity : 0),
  );
  return { productQuantity, cbm: productQuantity * lot.unitCbm, isEstimated: false };
}

export function haichuanWarehouseStatus(
  remainingCartonCount: number,
  reservedCartonCount: number,
): HaichuanWarehouseLot['status'] {
  if (remainingCartonCount <= 0) return 'depleted';
  if (reservedCartonCount <= 0) return 'available';
  if (reservedCartonCount >= remainingCartonCount) return 'fully_reserved';
  return 'partially_reserved';
}

export function selectableHaichuanWarehouseLots<T extends Pick<HaichuanWarehouseLot, 'id' | 'remainingCartonCount' | 'reservedCartonCount'>>(lots: T[]): T[] {
  return lots.filter((lot) => lot.remainingCartonCount > 0 && lot.reservedCartonCount === 0);
}

export function toggleAllHaichuanWarehouseLots(
  current: Record<string, number>,
  visibleLots: Array<Pick<HaichuanWarehouseLot, 'id' | 'remainingCartonCount' | 'reservedCartonCount'>>,
): Record<string, number> {
  const selectable = selectableHaichuanWarehouseLots(visibleLots);
  const allSelected = selectable.length > 0 && selectable.every((lot) => current[lot.id] !== undefined);
  const next = { ...current };
  for (const lot of selectable) {
    if (allSelected) delete next[lot.id];
    else next[lot.id] = lot.remainingCartonCount;
  }
  return next;
}

export function previewHaichuanWarehouseQuantity(
  lot: Pick<HaichuanWarehouseLot, 'initialProductQuantity' | 'remainingProductQuantity' | 'initialCbm' | 'unitCbm'>,
  newTotal: number,
): { consumed: number; remaining: number; remainingCbm: number; valid: boolean } {
  const consumed = Math.max(0, lot.initialProductQuantity - lot.remainingProductQuantity);
  const valid = Number.isFinite(newTotal) && newTotal >= consumed;
  const remaining = valid ? newTotal - consumed : 0;
  const unitCbm = lot.initialProductQuantity > 0 ? lot.initialCbm / lot.initialProductQuantity : lot.unitCbm;
  return { consumed, remaining, remainingCbm: remaining * unitCbm, valid };
}
