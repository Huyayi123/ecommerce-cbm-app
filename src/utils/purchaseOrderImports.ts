import type { PurchaseRecord } from '../types';
import { withPurchaseTotals } from './purchaseRecords';

type ImportMergeResult = {
  records: PurchaseRecord[];
  updatedCount: number;
  createdCount: number;
};

function normalizedSku(value: string): string {
  return value.trim().toUpperCase();
}

function normalizedShop(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isMatchableSku(value: string): boolean {
  const sku = normalizedSku(value);
  return Boolean(sku) && sku !== 'NEW';
}

function importKey(record: PurchaseRecord): string {
  return `${normalizedShop(record.shopName) || '*'}|${normalizedSku(record.sku)}`;
}

function createdTime(record: PurchaseRecord): number {
  const parsed = Date.parse(record.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestRecord(records: PurchaseRecord[]): PurchaseRecord | undefined {
  return records.reduce<PurchaseRecord | undefined>((latest, record) => {
    if (!latest) return record;
    return createdTime(record) > createdTime(latest) ? record : latest;
  }, undefined);
}

function mergeImportedRecord(current: PurchaseRecord, imported: PurchaseRecord): PurchaseRecord {
  return withPurchaseTotals({
    ...current,
    ...imported,
    id: current.id,
    buyerName: current.buyerName,
    assignedBuyerName: current.assignedBuyerName,
    assignedBuyerEmail: current.assignedBuyerEmail,
    isConfirmed: current.isConfirmed,
    purchasePoolId: current.purchasePoolId,
    purchasePoolName: current.purchasePoolName,
    purchasePoolDate: current.purchasePoolDate,
    poolStatus: current.poolStatus,
    purchaseBatchId: current.purchaseBatchId,
    purchaseBatchName: current.purchaseBatchName,
    purchaseBatchDate: current.purchaseBatchDate,
    estimatedArrivalDate: current.estimatedArrivalDate,
    status: current.status,
    containerDate: current.containerDate,
    logisticsBatchId: current.logisticsBatchId,
    logisticsConfirmationStatus: current.logisticsConfirmationStatus,
    logisticsLoadedCartonCount: current.logisticsLoadedCartonCount,
    logisticsLoadedTailQuantity: current.logisticsLoadedTailQuantity,
    logisticsLeftCartonCount: current.logisticsLeftCartonCount,
    logisticsLeftTailQuantity: current.logisticsLeftTailQuantity,
    logisticsSourceRecordId: current.logisticsSourceRecordId,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
}

export function mergeImportedPurchaseOrders(
  existingRecords: PurchaseRecord[],
  importedRecords: PurchaseRecord[],
  buyerEmail: string,
): ImportMergeResult {
  const normalizedEmail = buyerEmail.trim().toLowerCase();
  const eligible = existingRecords.filter((record) => (
    record.status === 'pending'
    && record.poolStatus === 'pending_purchase'
    && record.assignedBuyerEmail.trim().toLowerCase() === normalizedEmail
    && isMatchableSku(record.sku)
  ));
  const changedById = new Map<string, PurchaseRecord>();
  const changedOrder: string[] = [];
  const updatedIds = new Set<string>();
  const createdIds = new Set<string>();
  const createdByKey = new Map<string, string>();

  const put = (record: PurchaseRecord) => {
    if (!changedById.has(record.id)) changedOrder.push(record.id);
    changedById.set(record.id, record);
  };

  for (const imported of importedRecords) {
    if (!isMatchableSku(imported.sku)) {
      put(imported);
      createdIds.add(imported.id);
      continue;
    }

    const sku = normalizedSku(imported.sku);
    const shop = normalizedShop(imported.shopName);
    const matched = newestRecord(eligible.filter((record) => (
      normalizedSku(record.sku) === sku
      && (!shop || normalizedShop(record.shopName) === shop)
    )));

    if (matched) {
      put(mergeImportedRecord(changedById.get(matched.id) ?? matched, imported));
      updatedIds.add(matched.id);
      continue;
    }

    const key = importKey(imported);
    const createdId = createdByKey.get(key);
    if (createdId) {
      const current = changedById.get(createdId);
      if (current) put(mergeImportedRecord(current, imported));
      continue;
    }

    put(imported);
    createdByKey.set(key, imported.id);
    createdIds.add(imported.id);
  }

  return {
    records: changedOrder.map((id) => changedById.get(id)).filter((record): record is PurchaseRecord => Boolean(record)),
    updatedCount: updatedIds.size,
    createdCount: createdIds.size,
  };
}
