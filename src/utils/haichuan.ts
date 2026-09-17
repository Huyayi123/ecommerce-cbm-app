import type { HaichuanWarehouseLot, PurchaseRecord } from '../types';

export function declaredTotalCartonCount(record: Pick<PurchaseRecord, 'cartonCount' | 'tailQuantity'>): number {
  return Math.max(0, Math.trunc(Number(record.cartonCount) || 0)) + (Number(record.tailQuantity) > 0 ? 1 : 0);
}

export function haichuanPurchaseTotalQuantity(record: Pick<PurchaseRecord, 'confirmedPurchaseQuantity' | 'purchaseQuantity'>): number {
  return Math.max(0, Number(record.confirmedPurchaseQuantity ?? record.purchaseQuantity) || 0);
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
