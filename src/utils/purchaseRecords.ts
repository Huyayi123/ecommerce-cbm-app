import type { PurchaseRecord } from '../types';
import { round } from './number';

type PurchaseQuantityLike = Pick<PurchaseRecord, 'purchaseQuantity' | 'confirmedPurchaseQuantity'>;

export function effectivePurchaseQuantity(record: PurchaseQuantityLike): number {
  return record.confirmedPurchaseQuantity ?? record.purchaseQuantity;
}

export function isInventoryRecord(record: PurchaseRecord): boolean {
  return record.isConfirmed || record.status !== 'pending' || record.confirmedPurchaseQuantity !== null;
}

export function logisticsCbmFor(record: PurchaseRecord): number {
  return record.logisticsTotalCbm ?? record.totalCbm ?? 0;
}

export function logisticsText(value: number | null, digits?: number): string {
  if (value === null || value === undefined) return '待物流商回传';
  return digits === undefined ? String(value) : value.toFixed(digits);
}

export function withRecalculatedPurchase(record: PurchaseRecord): PurchaseRecord {
  const quantity = effectivePurchaseQuantity(record);
  return {
    ...record,
    totalAmount: round(quantity * record.purchasePrice, 2),
    totalCbm: record.totalCbm || round(quantity * record.unitCbm, 4),
  };
}
