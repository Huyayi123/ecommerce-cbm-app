import type { PurchaseRecord, PurchaseRecordImport } from '../types';
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

function mergeImportedRecord(current: PurchaseRecord, imported: PurchaseRecordImport): PurchaseRecord {
  const provided = new Set(imported.providedFields);
  const next = { ...current };
  for (const field of imported.providedFields) {
    next[field] = imported.record[field] as never;
  }
  const amountInputsChanged = provided.has('purchaseQuantity')
    || provided.has('confirmedPurchaseQuantity')
    || provided.has('purchasePrice')
    || provided.has('freightCost')
    || provided.has('mixedGroups');
  return withPurchaseTotals(next, {
    recalculateAmount: amountInputsChanged && !provided.has('totalAmount'),
  });
}

export function mergeImportedPurchaseOrders(
  existingRecords: PurchaseRecord[],
  importedRecords: PurchaseRecordImport[],
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

  for (const importedEntry of importedRecords) {
    const imported = importedEntry.record;
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
      put(mergeImportedRecord(changedById.get(matched.id) ?? matched, importedEntry));
      updatedIds.add(matched.id);
      continue;
    }

    const key = importKey(imported);
    const createdId = createdByKey.get(key);
    if (createdId) {
      const current = changedById.get(createdId);
      if (current) put(mergeImportedRecord(current, importedEntry));
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
