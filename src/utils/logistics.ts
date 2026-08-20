import type { AppProfile, LogisticsBatch, LogisticsBatchItem, PurchaseRecord, SkuItem } from '../types';
import { round } from './number';
import { mixedGroupsSummary, withPurchaseTotals } from './purchaseRecords';

function safeBatchId(containerDate: string, logisticsUserId: string, logisticsEmail: string): string {
  const owner = logisticsUserId || logisticsEmail || 'unassigned';
  return `logistics-${containerDate || 'no-date'}-${owner}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function skuLookup(skuItems: SkuItem[]): Map<string, SkuItem> {
  const map = new Map<string, SkuItem>();
  for (const item of skuItems) {
    const key = item.sku.trim().toUpperCase();
    if (key && !map.has(key)) map.set(key, item);
  }
  return map;
}

function normalizedKey(value: string): string {
  return value.trim().toUpperCase();
}

function skuLookupByField(skuItems: SkuItem[], field: keyof Pick<SkuItem, 'internalCode' | 'sku' | 'productName' | 'englishName'>): Map<string, SkuItem> {
  const map = new Map<string, SkuItem>();
  for (const item of skuItems) {
    const key = normalizedKey(String(item[field] ?? ''));
    if (key && !map.has(key)) map.set(key, item);
  }
  return map;
}

function findSkuForRecord(
  record: PurchaseRecord,
  lookups: {
    byInternalCode: Map<string, SkuItem>;
    bySku: Map<string, SkuItem>;
    byProductName: Map<string, SkuItem>;
    byEnglishName: Map<string, SkuItem>;
  },
): SkuItem | undefined {
  return lookups.byInternalCode.get(normalizedKey(record.internalCode))
    ?? lookups.bySku.get(normalizedKey(record.sku))
    ?? lookups.byProductName.get(normalizedKey(record.productName))
    ?? lookups.byEnglishName.get(normalizedKey(record.englishName));
}

export function logisticsStatusLabel(status: LogisticsBatch['status']): string {
  if (status === 'submitted') return '待审核';
  if (status === 'approved') return '已审核';
  if (status === 'rejected') return '已驳回';
  return '草稿';
}

export function buildLogisticsBatch(
  records: PurchaseRecord[],
  skuItems: SkuItem[],
  profile: AppProfile,
  containerDate: string,
  logisticsProfile: AppProfile | null,
  existingBatch?: LogisticsBatch,
): LogisticsBatch {
  const now = new Date().toISOString();
  const skuLookups = {
    byInternalCode: skuLookupByField(skuItems, 'internalCode'),
    bySku: skuLookup(skuItems),
    byProductName: skuLookupByField(skuItems, 'productName'),
    byEnglishName: skuLookupByField(skuItems, 'englishName'),
  };
  const batchId = existingBatch?.id || safeBatchId(containerDate, logisticsProfile?.id || '', logisticsProfile?.email || '');
  const existingItems = new Map((existingBatch?.items ?? []).map((item) => [item.purchaseRecordId, item]));
  const sourceRecords = records
    .filter((record) => record.poolStatus === 'submitted_to_pool' && record.status !== 'cancelled' && record.containerDate === containerDate)
    .sort((left, right) => (
      (left.internalCode || '').localeCompare(right.internalCode || '', 'zh-Hans-CN', { numeric: true })
      || left.manufacturerName.localeCompare(right.manufacturerName, 'zh-Hans-CN')
      || left.sku.localeCompare(right.sku, 'zh-Hans-CN')
    ));

  const items: LogisticsBatchItem[] = sourceRecords.map((record) => {
    const sku = findSkuForRecord(record, skuLookups);
    const existing = existingItems.get(record.id);
    const cartonCount = record.cartonCount ?? null;
    const tailQuantity = record.tailQuantity ?? 0;
    return {
      id: existing?.id || `${batchId}-${record.id}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
      batchId,
      purchaseRecordId: record.id,
      internalCode: record.internalCode || sku?.internalCode || '',
      manufacturerName: record.manufacturerName,
      sku: record.sku,
      productName: record.productName,
      englishName: record.englishName,
      imageUrl: record.imageUrl || sku?.imageUrl || '',
      shopName: record.shopName,
      containerDate: record.containerDate,
      cartonCount,
      unitsPerCarton: record.unitsPerCarton,
      tailQuantity,
      loadingType: record.loadingType,
      isMixed: record.isMixed,
      mixedGroupsSummary: mixedGroupsSummary(record),
      loadedCartonCount: existing?.loadedCartonCount ?? cartonCount,
      loadedTailQuantity: existing?.loadedTailQuantity ?? tailQuantity,
      leftCartonCount: existing?.leftCartonCount ?? 0,
      leftTailQuantity: existing?.leftTailQuantity ?? 0,
      note: existing?.note || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  });

  return {
    id: batchId,
    containerDate,
    logisticsUserId: logisticsProfile?.id || existingBatch?.logisticsUserId || '',
    logisticsEmail: logisticsProfile?.email || existingBatch?.logisticsEmail || '',
    status: existingBatch?.status === 'submitted' || existingBatch?.status === 'approved' ? existingBatch.status : 'draft',
    createdBy: existingBatch?.createdBy || profile.id,
    createdAt: existingBatch?.createdAt || now,
    submittedAt: existingBatch?.submittedAt || '',
    reviewedBy: existingBatch?.reviewedBy || '',
    reviewedAt: existingBatch?.reviewedAt || '',
    note: existingBatch?.note || '',
    items,
  };
}

export function normalizeLogisticsItemInput(item: LogisticsBatchItem): LogisticsBatchItem {
  const cartonCount = item.cartonCount ?? 0;
  const tailQuantity = item.tailQuantity ?? 0;
  let loadedCartons = Math.max(0, Math.floor(Number(item.loadedCartonCount ?? 0)));
  let loadedTail = Math.max(0, Math.floor(Number(item.loadedTailQuantity ?? 0)));
  let leftCartons = Math.max(0, Math.floor(Number(item.leftCartonCount ?? 0)));
  let leftTail = Math.max(0, Math.floor(Number(item.leftTailQuantity ?? 0)));

  if (item.isMixed && !(loadedCartons === 0 && loadedTail === 0)) {
    loadedCartons = cartonCount;
    loadedTail = tailQuantity;
    leftCartons = 0;
    leftTail = 0;
  }

  return {
    ...item,
    loadedCartonCount: loadedCartons,
    loadedTailQuantity: loadedTail,
    leftCartonCount: leftCartons,
    leftTailQuantity: leftTail,
  };
}

function noteWithLogistics(record: PurchaseRecord, logisticsNote: string, suffix: string): string {
  const pieces = [record.note.trim(), suffix, logisticsNote.trim() ? `物流备注：${logisticsNote.trim()}` : ''].filter(Boolean);
  return Array.from(new Set(pieces)).join('；');
}

function setPacking(record: PurchaseRecord, cartonCount: number, tailQuantity: number): PurchaseRecord {
  return withPurchaseTotals({
    ...record,
    cartonCount,
    tailQuantity,
  }, { recalculateAmount: true });
}

export function applyApprovedLogisticsBatch(
  records: PurchaseRecord[],
  batch: LogisticsBatch,
): PurchaseRecord[] {
  const now = new Date().toISOString();
  const byId = new Map(records.map((record) => [record.id, record]));
  const changed = new Map<string, PurchaseRecord>();
  const created: PurchaseRecord[] = [];

  for (const rawItem of batch.items) {
    const item = normalizeLogisticsItemInput(rawItem);
    const record = byId.get(item.purchaseRecordId);
    if (!record) continue;

    const cartonCount = record.cartonCount ?? 0;
    const tailQuantity = record.tailQuantity ?? 0;
    const loadedCartons = item.loadedCartonCount ?? 0;
    const loadedTail = item.loadedTailQuantity ?? 0;
    const leftCartons = item.leftCartonCount ?? Math.max(0, cartonCount - loadedCartons);
    const leftTail = item.leftTailQuantity ?? Math.max(0, tailQuantity - loadedTail);
    const allLoaded = leftCartons === 0 && leftTail === 0;
    const allLeft = loadedCartons === 0 && loadedTail === 0;

    const common = {
      logisticsBatchId: batch.id,
      logisticsConfirmationStatus: 'approved' as const,
      logisticsLoadedCartonCount: loadedCartons,
      logisticsLoadedTailQuantity: loadedTail,
      logisticsLeftCartonCount: leftCartons,
      logisticsLeftTailQuantity: leftTail,
      updatedAt: now,
    };

    if (allLoaded) {
      changed.set(record.id, withPurchaseTotals({
        ...record,
        ...common,
        isConfirmed: true,
        poolStatus: 'sent_to_inventory',
        status: 'in_transit',
        containerDate: batch.containerDate || record.containerDate,
        purchaseBatchDate: batch.containerDate || record.purchaseBatchDate,
        note: noteWithLogistics(record, item.note, '物流已确认整票装柜'),
      }));
      continue;
    }

    if (allLeft) {
      changed.set(record.id, withPurchaseTotals({
        ...record,
        ...common,
        isConfirmed: true,
        poolStatus: 'submitted_to_pool',
        status: 'pending',
        containerDate: '',
        logisticsLoadedCartonCount: 0,
        logisticsLoadedTailQuantity: 0,
        logisticsLeftCartonCount: leftCartons,
        logisticsLeftTailQuantity: leftTail,
        note: noteWithLogistics(record, item.note, '物流确认本次未装柜，留待后续装柜'),
      }));
      continue;
    }

    const loadedRecord = setPacking({
      ...record,
      ...common,
      isConfirmed: true,
      poolStatus: 'sent_to_inventory',
      status: 'in_transit',
      containerDate: batch.containerDate || record.containerDate,
      purchaseBatchDate: batch.containerDate || record.purchaseBatchDate,
      cartonCount: loadedCartons,
      tailQuantity: loadedTail,
      note: noteWithLogistics(record, item.note, '物流确认部分装柜'),
    }, loadedCartons, loadedTail);

    const leftRecord = setPacking({
      ...record,
      id: crypto.randomUUID(),
      logisticsSourceRecordId: record.id,
      logisticsBatchId: batch.id,
      logisticsConfirmationStatus: 'approved',
      logisticsLoadedCartonCount: 0,
      logisticsLoadedTailQuantity: 0,
      logisticsLeftCartonCount: leftCartons,
      logisticsLeftTailQuantity: leftTail,
      isConfirmed: true,
      poolStatus: 'submitted_to_pool',
      status: 'pending',
      containerDate: '',
      cartonCount: leftCartons,
      tailQuantity: leftTail,
      totalWeightKg: record.totalWeightKg === null ? null : round(record.totalWeightKg * ((leftCartons + (leftTail > 0 ? 1 : 0)) / Math.max(1, cartonCount + (tailQuantity > 0 ? 1 : 0))), 2),
      note: noteWithLogistics(record, item.note, '物流拆分留下部分'),
      createdAt: now,
      updatedAt: now,
    }, leftCartons, leftTail);

    changed.set(record.id, loadedRecord);
    created.push(leftRecord);
  }

  const updated = records.map((record) => changed.get(record.id) ?? record);
  return [...created, ...updated].map((record) => (
    batch.items.some((item) => item.purchaseRecordId === record.id || record.logisticsSourceRecordId === item.purchaseRecordId)
      ? { ...record, internalCode: record.internalCode, updatedAt: record.updatedAt || now }
      : record
  ));
}
