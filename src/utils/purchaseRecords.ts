import type { MixedCartonGroup, MixedCartonLine, PurchaseRecord } from '../types';
import { round } from './number';

type PurchaseQuantityLike = Pick<PurchaseRecord, 'purchaseQuantity' | 'confirmedPurchaseQuantity' | 'cartonCount' | 'unitsPerCarton' | 'tailQuantity'>;

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeMixedGroups(value: unknown): MixedCartonGroup[] {
  if (!Array.isArray(value)) return [];
  return value.map((group, groupIndex) => {
    const payload = group && typeof group === 'object' ? group as Record<string, unknown> : {};
    const linesValue = Array.isArray(payload.lines) ? payload.lines : [];
    const lines: MixedCartonLine[] = linesValue.map((line) => {
      const linePayload = line && typeof line === 'object' ? line as Record<string, unknown> : {};
      const quantity = numberOrZero(linePayload.quantity);
      const purchasePrice = numberOrZero(linePayload.purchasePrice ?? linePayload.purchase_price);
      const unitCbm = numberOrZero(linePayload.unitCbm ?? linePayload.unit_cbm);
      return {
        id: String(linePayload.id ?? crypto.randomUUID()),
        sku: String(linePayload.sku ?? ''),
        productName: String(linePayload.productName ?? linePayload.product_name ?? ''),
        englishName: String(linePayload.englishName ?? linePayload.english_name ?? ''),
        quantity,
        purchasePrice,
        unitCbm,
        totalAmount: round(quantity * purchasePrice, 2),
        totalCbm: round(quantity * unitCbm, 4),
      };
    });

    return {
      id: String(payload.id ?? crypto.randomUUID()),
      groupName: String(payload.groupName ?? payload.group_name ?? `混装${groupIndex + 1}`),
      cartonCount: Math.max(1, Math.floor(numberOrZero(payload.cartonCount ?? payload.carton_count) || 1)),
      lines,
    };
  });
}

export function effectivePurchaseQuantity(record: PurchaseQuantityLike): number {
  const cartonCount = record.cartonCount ?? null;
  const unitsPerCarton = record.unitsPerCarton ?? null;
  const tailQuantity = record.tailQuantity ?? 0;
  if (cartonCount !== null && ((unitsPerCarton !== null && unitsPerCarton > 0) || tailQuantity > 0)) {
    return cartonCount * Math.max(0, unitsPerCarton ?? 0) + tailQuantity;
  }
  if (record.confirmedPurchaseQuantity !== null && record.confirmedPurchaseQuantity !== undefined) {
    return record.confirmedPurchaseQuantity;
  }
  return record.purchaseQuantity ?? 0;
}

export function isInventoryRecord(record: PurchaseRecord): boolean {
  return record.status === 'pending' || record.status === 'in_transit' || record.status === 'arrived';
}

export function logisticsCbmFor(record: PurchaseRecord): number {
  return record.logisticsTotalCbm ?? record.totalCbm ?? 0;
}

export function logisticsText(value: number | null, digits?: number): string {
  if (value === null || value === undefined) return '待物流商回传';
  return digits === undefined ? String(value) : value.toFixed(digits);
}

export function mixedQuantityFor(record: PurchaseRecord): number {
  return record.mixedGroups.reduce((sum, group) => sum + group.lines.reduce((lineSum, line) => lineSum + line.quantity, 0), 0);
}

export function purchaseQuantityWithMixed(record: PurchaseRecord): number {
  return effectivePurchaseQuantity(record) + mixedQuantityFor(record);
}

export function packageCountFor(record: PurchaseRecord): number {
  const tailCartons = (record.tailQuantity ?? 0) > 0 ? 1 : 0;
  return (record.cartonCount ?? 0) + tailCartons;
}

export function mixedAmountFor(record: PurchaseRecord): number {
  return round(record.mixedGroups.reduce((sum, group) => (
    sum + group.lines.reduce((lineSum, line) => lineSum + line.quantity * line.purchasePrice, 0)
  ), 0), 2);
}

export function mixedCbmFor(record: PurchaseRecord): number {
  return round(record.mixedGroups.reduce((sum, group) => (
    sum + group.lines.reduce((lineSum, line) => lineSum + line.quantity * line.unitCbm, 0)
  ), 0), 4);
}

export function mixedGroupsSummary(record: PurchaseRecord): string {
  if (record.mixedGroups.length === 0) return '';
  return record.mixedGroups.map((group) => {
    const lines = group.lines.map((line) => `${line.sku || line.productName || '未填SKU'}=${line.quantity}`).join('，');
    return `${group.groupName} ${group.cartonCount}件：${lines}`;
  }).join('；');
}

export function calculatedPurchaseTotalAmount(record: PurchaseRecord): number {
  const mixedGroups = normalizeMixedGroups(record.mixedGroups);
  const normalizedRecord = { ...record, mixedGroups };
  return round(effectivePurchaseQuantity(record) * record.purchasePrice + record.freightCost + mixedAmountFor(normalizedRecord), 2);
}

function mixedAmountInputs(record: Pick<PurchaseRecord, 'mixedGroups'>): Array<Array<[number, number]>> {
  return normalizeMixedGroups(record.mixedGroups).map((group) => group.lines.map((line) => [line.quantity, line.purchasePrice]));
}

export function purchaseAmountInputsChanged(
  previous: Pick<PurchaseRecord, 'purchaseQuantity' | 'confirmedPurchaseQuantity' | 'purchasePrice' | 'freightCost' | 'mixedGroups'>,
  next: Pick<PurchaseRecord, 'purchaseQuantity' | 'confirmedPurchaseQuantity' | 'purchasePrice' | 'freightCost' | 'mixedGroups'>,
): boolean {
  return previous.purchaseQuantity !== next.purchaseQuantity
    || previous.confirmedPurchaseQuantity !== next.confirmedPurchaseQuantity
    || previous.purchasePrice !== next.purchasePrice
    || previous.freightCost !== next.freightCost
    || JSON.stringify(mixedAmountInputs(previous)) !== JSON.stringify(mixedAmountInputs(next));
}

export function calculatedPurchaseTotalCbm(record: PurchaseRecord): number {
  const mixedGroups = normalizeMixedGroups(record.mixedGroups);
  const normalizedRecord = { ...record, mixedGroups };
  return round(effectivePurchaseQuantity(record) * record.unitCbm + mixedCbmFor(normalizedRecord), 4);
}

export function withPurchaseTotals(record: PurchaseRecord, options: { recalculateAmount?: boolean } | number = {}): PurchaseRecord {
  const recalculateAmount = typeof options === 'object' && Boolean(options.recalculateAmount);
  const mixedGroups = normalizeMixedGroups(record.mixedGroups);
  const mainQuantity = effectivePurchaseQuantity(record);
  const mainCbm = round(mainQuantity * record.unitCbm, 4);
  const normalizedRecord = {
    ...record,
    tailQuantity: record.tailQuantity ?? 0,
    mixedGroups,
    isMixed: record.isMixed || mixedGroups.length > 0,
  };

  return {
    ...normalizedRecord,
    confirmedPurchaseQuantity: record.cartonCount !== null && record.unitsPerCarton ? mainQuantity : record.confirmedPurchaseQuantity ?? null,
    totalAmount: recalculateAmount ? calculatedPurchaseTotalAmount(normalizedRecord) : round(Number.isFinite(record.totalAmount) ? record.totalAmount : calculatedPurchaseTotalAmount(normalizedRecord), 2),
    totalCbm: round(mainCbm + mixedCbmFor(normalizedRecord), 4),
  };
}

export const withPackingTotals = withPurchaseTotals;

export function withRecalculatedPurchase(record: PurchaseRecord): PurchaseRecord {
  return withPurchaseTotals(record, { recalculateAmount: true });
}
