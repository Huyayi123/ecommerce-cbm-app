import type { PurchasePool, PurchaseRecord } from '../types';
import { withPurchaseTotals } from './purchaseRecords';

export function isGuantongLoadingType(record: Pick<PurchaseRecord, 'loadingType'>): boolean {
  return record.loadingType === '冠通';
}

export function normalizeRecordForPurchasePool(record: PurchaseRecord): PurchaseRecord {
  return withPurchaseTotals({
    ...record,
    isConfirmed: true,
    status: record.status === 'cancelled' ? 'cancelled' : 'pending',
    poolStatus: 'submitted_to_pool',
  });
}

export type PoolMembershipRepairResult = {
  records: PurchaseRecord[];
  repairedRecords: PurchaseRecord[];
};

export function repairPurchasePoolMembership(
  records: PurchaseRecord[],
  pools: PurchasePool[],
): PoolMembershipRepairResult {
  const activePoolRecordIds = new Set(pools.filter((pool) => pool.status === 'open').flatMap((pool) => pool.records
    .filter((record) => record.status !== 'cancelled' && record.poolStatus !== 'sent_to_inventory')
    .map((record) => record.id)));
  const repairedRecords: PurchaseRecord[] = [];
  const nextRecords = records.map((record) => {
    if (!activePoolRecordIds.has(record.id) || record.poolStatus !== 'pending_purchase' || record.status === 'cancelled') return record;
    const repaired = normalizeRecordForPurchasePool(record);
    repairedRecords.push(repaired);
    return repaired;
  });
  return { records: nextRecords, repairedRecords };
}

export function isRecordEligibleForLogistics(record: PurchaseRecord, containerDate: string): boolean {
  return record.poolStatus === 'submitted_to_pool'
    && record.status !== 'cancelled'
    && !isGuantongLoadingType(record)
    && record.containerDate === containerDate;
}

export function changePurchasePoolLoadingType(
  record: PurchaseRecord,
  loadingType: PurchaseRecord['loadingType'],
): PurchaseRecord {
  if (record.loadingType === loadingType) return record;
  return withPurchaseTotals({ ...record, loadingType, containerDate: '' });
}

export type PoolDateUpdateResult = {
  records: PurchaseRecord[];
  updatedCount: number;
  preservedManualCount: number;
  skippedGuantongCount: number;
};

export function applyContainerDateToPoolRecords(
  records: PurchaseRecord[],
  previousPoolDate: string,
  nextDate: string,
): PoolDateUpdateResult {
  let updatedCount = 0;
  let preservedManualCount = 0;
  let skippedGuantongCount = 0;
  const nextRecords = records.map((record) => {
    if (isGuantongLoadingType(record)) {
      skippedGuantongCount += 1;
      return record;
    }
    if (record.containerDate && record.containerDate !== previousPoolDate) {
      preservedManualCount += 1;
      return record;
    }
    updatedCount += 1;
    return withPurchaseTotals({
      ...record,
      purchasePoolDate: nextDate,
      purchaseBatchDate: nextDate,
      containerDate: nextDate,
    });
  });
  return { records: nextRecords, updatedCount, preservedManualCount, skippedGuantongCount };
}

export type GuantongInventoryResult = {
  records: PurchaseRecord[];
  sentRecords: PurchaseRecord[];
  missingDateCount: number;
};

export function prepareDatedGuantongForInventory(records: PurchaseRecord[]): GuantongInventoryResult {
  const sentRecords: PurchaseRecord[] = [];
  let missingDateCount = 0;
  const nextRecords = records.map((record) => {
    if (record.poolStatus !== 'submitted_to_pool' || record.status === 'cancelled' || !isGuantongLoadingType(record)) return record;
    if (!record.containerDate.trim()) {
      missingDateCount += 1;
      return record;
    }
    const sent = withPurchaseTotals({
      ...record,
      isConfirmed: true,
      poolStatus: 'sent_to_inventory',
      status: 'in_transit',
    });
    sentRecords.push(sent);
    return sent;
  });
  return { records: nextRecords, sentRecords, missingDateCount };
}
