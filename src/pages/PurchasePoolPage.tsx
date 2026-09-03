import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AppProfile, LogisticsBatch, PurchasePool, PurchaseRecord, SkuItem } from '../types';
import { exportBatchPurchaseOrder, exportPurchaseRecords } from '../utils/exporters';
import { formatErrorMessage } from '../utils/errors';
import { buildLogisticsBatch } from '../utils/logistics';
import { applyContainerDateToPoolRecords, changePurchasePoolLoadingType, normalizeRecordForPurchasePool, prepareDatedGuantongForInventory } from '../utils/purchasePoolFlows';
import { openPurchaseUrl, purchaseUrlForRecord, skuLookupKey } from '../utils/purchaseLinks';
import { calculatedPurchaseTotalAmount, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  pools: PurchasePool[];
  profile: AppProfile;
  profiles: AppProfile[];
  skuItems: SkuItem[];
  logisticsBatches: LogisticsBatch[];
  onSaveRecords: (records: PurchaseRecord[]) => void | Promise<void>;
  onSavePools: (pools: PurchasePool[]) => void | Promise<void>;
  onSaveLogisticsBatch: (batch: LogisticsBatch) => void | Promise<void>;
  onOpenLogistics?: () => void;
};

type PoolOption = PurchasePool & {
  recordCount: number;
  submittedCount: number;
  isAggregate?: boolean;
};

type EditablePoolField =
  | 'manufacturerName'
  | 'sku'
  | 'productName'
  | 'englishName'
  | 'shopName'
  | 'assignedBuyerName'
  | 'purchaseQuantity'
  | 'cartonCount'
  | 'unitsPerCarton'
  | 'tailQuantity'
  | 'purchasePrice'
  | 'freightCost'
  | 'totalAmount'
  | 'unitCbm'
  | 'totalCbm'
  | 'status'
  | 'loadingType'
  | 'containerDate'
  | 'note';

function poolKey(record: PurchaseRecord): string {
  return record.purchasePoolId || record.purchaseBatchId || `${record.purchasePoolDate || record.purchaseBatchDate}|${record.purchasePoolName || record.purchaseBatchName}`;
}

function poolNameFromRecord(record: PurchaseRecord): string {
  return record.purchasePoolName || record.purchaseBatchName || '未分配采购池';
}

function poolDateFromRecord(record: PurchaseRecord): string {
  return record.purchasePoolDate || record.purchaseBatchDate || record.containerDate || record.purchaseDate;
}

function isPoolPendingRecord(record: PurchaseRecord): boolean {
  return record.status !== 'cancelled' && record.poolStatus !== 'sent_to_inventory';
}

function buildPoolOptions(records: PurchaseRecord[], pools: PurchasePool[]): PoolOption[] {
  const options = new Map<string, PoolOption>();
  for (const pool of pools) {
    const pendingRecords = pool.records.filter(isPoolPendingRecord).map(normalizeRecordForPurchasePool);
    options.set(pool.id, {
      ...pool,
      records: pendingRecords,
      recordCount: pendingRecords.length,
      submittedCount: pendingRecords.length,
    });
  }
  for (const record of records) {
    const key = poolKey(record);
    if (!key) continue;
    if (record.poolStatus !== 'submitted_to_pool') continue;
    const existing = options.get(key);
    if (existing?.records.some((item) => item.id === record.id)) {
      existing.records = existing.records.map((item) => (item.id === record.id ? normalizeRecordForPurchasePool(record) : item));
      continue;
    }
    const option = existing ?? {
      id: key,
      name: poolNameFromRecord(record),
      containerDate: poolDateFromRecord(record),
      status: 'open' as const,
      createdBy: '',
      createdAt: record.createdAt || '',
      sentBy: '',
      sentAt: '',
      note: '',
      records: [],
      recordCount: 0,
      submittedCount: 0,
    };
    option.records.push(normalizeRecordForPurchasePool(record));
    option.recordCount = option.records.length;
    option.submittedCount = option.records.filter(isPoolPendingRecord).length;
    options.set(key, option);
  }
  return Array.from(options.values())
    .filter((pool) => pool.submittedCount > 0)
    .sort((left, right) => (
      (right.createdAt || '').localeCompare(left.createdAt || '')
      || (right.containerDate || '').localeCompare(left.containerDate || '')
      || right.name.localeCompare(left.name, 'zh-Hans-CN')
    ));
}

function buildAggregatePool(options: PoolOption[]): PoolOption | null {
  const recordsById = new Map<string, PurchaseRecord>();
  for (const pool of options) {
    for (const record of pool.records) {
      if (isPoolPendingRecord(record)) recordsById.set(record.id, record);
    }
  }
  const records = Array.from(recordsById.values());
  if (records.length === 0) return null;
  return {
    id: '__all_pending_purchase_pools__',
    name: '全部待发送采购池',
    containerDate: '',
    status: 'open',
    createdBy: '',
    createdAt: '',
    sentBy: '',
    sentAt: '',
    note: '',
    records,
    recordCount: records.length,
    submittedCount: records.length,
    isAggregate: true,
  };
}

function dateGroupId(containerDate: string): string {
  return `__container_date__:${containerDate || 'missing'}`;
}

function buildContainerDateOptions(options: PoolOption[]): PoolOption[] {
  const groups = new Map<string, PoolOption>();
  const seenRecordIdsByGroup = new Map<string, Set<string>>();
  for (const pool of options) {
    for (const record of pool.records) {
      if (!isPoolPendingRecord(record)) continue;
      const containerDate = record.containerDate || pool.containerDate || '';
      const id = dateGroupId(containerDate);
      const existing = groups.get(id) ?? {
        id,
        name: containerDate || '未填装柜日期',
        containerDate,
        status: 'open' as const,
        createdBy: '',
        createdAt: '',
        sentBy: '',
        sentAt: '',
        note: '',
        records: [],
        recordCount: 0,
        submittedCount: 0,
        isAggregate: true,
      };
      const seenRecordIds = seenRecordIdsByGroup.get(id) ?? new Set<string>();
      if (!seenRecordIds.has(record.id)) {
        existing.records.push(record);
        seenRecordIds.add(record.id);
      }
      existing.recordCount = existing.records.length;
      existing.submittedCount = existing.records.filter(isPoolPendingRecord).length;
      groups.set(id, existing);
      seenRecordIdsByGroup.set(id, seenRecordIds);
    }
  }
  return Array.from(groups.values())
    .filter((pool) => pool.submittedCount > 0)
    .sort((left, right) => (
      (right.containerDate || '').localeCompare(left.containerDate || '')
      || right.name.localeCompare(left.name, 'zh-Hans-CN')
    ));
}

export function PurchasePoolPage({
  records,
  pools,
  profile,
  profiles,
  skuItems,
  logisticsBatches,
  onSaveRecords,
  onSavePools,
  onSaveLogisticsBatch,
  onOpenLogistics,
}: Props) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [message, setMessage] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [poolDateDraft, setPoolDateDraft] = useState('');
  const [logisticsUserId, setLogisticsUserId] = useState('');
  const isAdmin = profile.role === 'admin' || profile.role === 'owner';
  const logisticsProfiles = useMemo(() => profiles.filter((item) => item.role === 'logistics'), [profiles]);
  const sourcePoolOptions = useMemo(() => buildPoolOptions(records, pools), [pools, records]);
  const options = useMemo(() => {
    const aggregatePool = buildAggregatePool(sourcePoolOptions);
    const dateOptions = buildContainerDateOptions(sourcePoolOptions);
    return aggregatePool ? [aggregatePool, ...dateOptions] : dateOptions;
  }, [sourcePoolOptions]);
  const activePoolId = selectedPoolId && options.some((pool) => pool.id === selectedPoolId) ? selectedPoolId : options[0]?.id || '';
  const activePool = options.find((pool) => pool.id === activePoolId);
  const poolRecords = activePool?.records.map(withPurchaseTotals) ?? [];
  const submittedRecords = poolRecords.filter((record) => record.status !== 'cancelled');
  const canApplyPoolDate = isAdmin && Boolean(activePool);
  const imageUrlBySku = useMemo(
    () => new Map(skuItems
      .filter((item) => item.sku.trim())
      .map((item) => [skuLookupKey(item.sku), item.imageUrl])),
    [skuItems],
  );
  const skuBySku = useMemo(
    () => new Map(skuItems
      .filter((item) => item.sku.trim())
      .map((item) => [skuLookupKey(item.sku), item])),
    [skuItems],
  );
  const totalQuantity = submittedRecords.reduce((sum, record) => sum + purchaseQuantityForRecordSku(record), 0);
  const totalAmount = submittedRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const totalCbm = submittedRecords.reduce((sum, record) => sum + record.totalCbm, 0);
  const totalPackages = submittedRecords.reduce((sum, record) => sum + packageCountFor(record), 0);

  useEffect(() => {
    setPoolDateDraft(activePool?.containerDate || '');
  }, [activePool?.containerDate, activePool?.id]);

  useEffect(() => {
    setLogisticsUserId((current) => current || logisticsProfiles[0]?.id || '');
  }, [logisticsProfiles]);

  async function applyPoolContainerDate() {
    if (!canApplyPoolDate || !activePool) {
      return;
    }
    const nextDate = poolDateDraft.trim();
    if (!nextDate) {
      setMessage('请先填写本池装柜日期。');
      return;
    }
    const dateResult = applyContainerDateToPoolRecords(submittedRecords, activePool.containerDate, nextDate);
    if (dateResult.updatedCount === 0) {
      setMessage(`本池没有可统一日期的整柜订单；保留 ${dateResult.preservedManualCount} 条人工日期，跳过 ${dateResult.skippedGuantongCount} 条冠通订单。`);
      return;
    }
    const nextRecords = dateResult.records.map((record) => withPurchaseTotals({
      ...record,
      purchasePoolId: activePool.isAggregate ? record.purchasePoolId : activePool.id,
      purchasePoolName: activePool.isAggregate ? record.purchasePoolName : activePool.name,
      purchaseBatchId: activePool.isAggregate ? record.purchaseBatchId : record.purchaseBatchId || activePool.id,
      purchaseBatchName: activePool.isAggregate ? record.purchaseBatchName : activePool.name,
    }));
    const nextRecordsById = new Map(nextRecords.map((record) => [record.id, record]));
    const nextPools: PurchasePool[] = activePool.isAggregate
      ? sourcePoolOptions.flatMap((pool): PurchasePool[] => {
        const hasUpdatedRecord = pool.records.some((record) => nextRecordsById.has(record.id));
        if (!hasUpdatedRecord) return [];
        return [{
          id: pool.id,
          name: pool.name,
          containerDate: nextDate,
          status: pool.status,
          createdBy: pool.createdBy,
          createdAt: pool.createdAt,
          sentBy: pool.sentBy,
          sentAt: pool.sentAt,
          note: pool.note,
          records: pool.records.map((record) => nextRecordsById.get(record.id) ?? record),
        }];
      })
      : [{
        ...activePool,
        containerDate: nextDate,
        records: nextRecords,
      }];
    try {
      if (nextPools.length > 0) await onSavePools(nextPools);
      await onSaveRecords(nextRecords);
      setMessage(`已统一 ${dateResult.updatedCount} 条整柜订单的装柜日期为 ${nextDate}；保留 ${dateResult.preservedManualCount} 条人工日期，跳过 ${dateResult.skippedGuantongCount} 条冠通订单。`);
    } catch (error) {
      console.error(error);
      setMessage(`统一装柜日期失败：${formatErrorMessage(error)}`);
    }
  }

  async function sendDatedGuantongToInventory() {
    if (!isAdmin || !activePool) return;
    const result = prepareDatedGuantongForInventory(submittedRecords);
    if (result.sentRecords.length === 0) {
      setMessage(result.missingDateCount > 0 ? `当前池有 ${result.missingDateCount} 条冠通订单尚未填写装柜日期。` : '当前池没有已填写装柜日期的冠通订单。');
      return;
    }
    const sentIds = new Set(result.sentRecords.map((record) => record.id));
    const affectedPools = sourcePoolOptions
      .filter((pool) => pool.records.some((record) => sentIds.has(record.id)))
      .map((pool) => ({ ...pool, records: pool.records.filter((record) => !sentIds.has(record.id)) }));
    try {
      if (affectedPools.length > 0) await onSavePools(affectedPools);
      await onSaveRecords(result.sentRecords);
      setMessage(`已发送 ${result.sentRecords.length} 条冠通订单到采购 / 在途库存${result.missingDateCount > 0 ? `；另有 ${result.missingDateCount} 条未填日期，继续保留在采购池` : ''}。`);
    } catch (error) {
      console.error(error);
      setMessage(`发送冠通订单失败：${formatErrorMessage(error)}`);
    }
  }

  async function assignLogisticsBatch() {
    if (!isAdmin || !activePool) return;
    const logisticsProfile = logisticsProfiles.find((item) => item.id === logisticsUserId);
    if (!logisticsProfile) {
      setMessage('请先选择物流商账号。');
      return;
    }
    const assignableRecords = submittedRecords.map((record) => withPurchaseTotals({
      ...record,
      containerDate: record.containerDate || poolDateDraft.trim() || activePool.containerDate,
    }));
    const dates = Array.from(new Set(assignableRecords.map((record) => record.containerDate).filter(Boolean)));
    if (dates.length === 0) {
      setMessage('请先填写本池装柜日期，或逐行填写装柜日期。');
      return;
    }
    try {
      let totalItems = 0;
      let batchCount = 0;
      for (const batchDate of dates) {
        const existing = logisticsBatches.find((batch) => batch.containerDate === batchDate && batch.logisticsUserId === logisticsProfile.id);
        const batch = buildLogisticsBatch(assignableRecords, skuItems, profile, batchDate, logisticsProfile, existing);
        if (batch.items.length === 0) continue;
        await onSaveLogisticsBatch(batch);
        totalItems += batch.items.length;
        batchCount += 1;
      }
      if (totalItems === 0) {
        setMessage('当前采购池没有可分配给物流商的装柜记录。');
        return;
      }
      setMessage(`已生成/刷新 ${batchCount} 个物流批次、${totalItems} 条物流装柜确认明细，并分配给 ${logisticsProfile.displayName || logisticsProfile.email}。`);
      onOpenLogistics?.();
    } catch (error) {
      console.error(error);
      setMessage(`分配物流商失败：${formatErrorMessage(error)}`);
    }
  }

  function draftKey(recordId: string, field: EditablePoolField): string {
    return `${recordId}:${field}`;
  }

  function parseNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function valueFor(record: PurchaseRecord, field: EditablePoolField): string {
    const key = draftKey(record.id, field);
    if (key in drafts) return drafts[key];
    const value = record[field];
    return value === null || value === undefined ? '' : String(value);
  }

  function canEditField(field: EditablePoolField): boolean {
    return isAdmin && Boolean(activePool) && (!activePool?.isAggregate || field === 'containerDate' || field === 'loadingType');
  }

  function patchRecord(record: PurchaseRecord, field: EditablePoolField, value: string): PurchaseRecord {
    if (field === 'loadingType') {
      return changePurchasePoolLoadingType(record, value as PurchaseRecord['loadingType']);
    }
    const next: PurchaseRecord = { ...record };
    if (
      field === 'purchaseQuantity'
      || field === 'purchasePrice'
      || field === 'freightCost'
      || field === 'totalAmount'
      || field === 'unitCbm'
      || field === 'totalCbm'
      || field === 'cartonCount'
      || field === 'unitsPerCarton'
      || field === 'tailQuantity'
    ) {
      (next[field] as number | null) = value.trim() === '' && (field === 'cartonCount' || field === 'unitsPerCarton') ? null : parseNumber(value);
    } else {
      (next[field] as string) = value;
    }
    if (
      field === 'purchaseQuantity'
      || field === 'purchasePrice'
      || field === 'freightCost'
      || field === 'cartonCount'
      || field === 'unitsPerCarton'
      || field === 'tailQuantity'
    ) {
      return withPurchaseTotals({ ...next, totalAmount: calculatedPurchaseTotalAmount(next) }, { recalculateAmount: true });
    }
    return withPurchaseTotals(next);
  }

  async function savePoolRecord(record: PurchaseRecord, field: EditablePoolField) {
    const key = draftKey(record.id, field);
    if (!(key in drafts) || !canEditField(field) || !activePool) return;
    await savePoolRecordValue(record, field, drafts[key]);
  }

  async function savePoolRecordValue(record: PurchaseRecord, field: EditablePoolField, value: string) {
    const key = draftKey(record.id, field);
    if (!canEditField(field) || !activePool) return;
    const nextRecord = normalizeRecordForPurchasePool(patchRecord(record, field, value));
    const sourcePool = activePool.isAggregate
      ? sourcePoolOptions.find((pool) => pool.records.some((item) => item.id === record.id))
      : activePool;
    if (!sourcePool) return;
    const nextPool: PurchasePool = {
      ...sourcePool,
      records: sourcePool.records.map((item) => (
        item.id === nextRecord.id ? nextRecord : normalizeRecordForPurchasePool(item)
      )),
    };
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await onSavePools([nextPool]);
      await onSaveRecords([nextRecord]);
      setMessage('已保存采购池订单修改。');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    }
  }

  async function returnToBuyer(record: PurchaseRecord) {
    if (!isAdmin || !activePool) {
      return;
    }
    const sourcePool = activePool.isAggregate
      ? sourcePoolOptions.find((pool) => pool.records.some((item) => item.id === record.id))
      : activePool;
    const nextRecord = withPurchaseTotals({
      ...record,
      isConfirmed: false,
      confirmedPurchaseQuantity: null,
      status: 'pending',
      poolStatus: 'pending_purchase',
    });
    try {
      const remainingRecords = sourcePool
        ? sourcePool.records
          .filter((item) => item.id !== record.id)
          .map(normalizeRecordForPurchasePool)
        : [];
      if (sourcePool) {
        await onSavePools([{
          ...sourcePool,
          records: remainingRecords,
        }]);
      }
      await onSaveRecords([...remainingRecords, nextRecord]);
      setMessage(`已退回 ${record.sku || record.productName} 给采购人。`);
    } catch (error) {
      console.error(error);
      setMessage(`退回失败：${formatErrorMessage(error)}`);
    }
  }

  function editableCell(record: PurchaseRecord, field: EditablePoolField, type = 'text') {
    if (!canEditField(field)) return <span>{valueFor(record, field)}</span>;
    if (field === 'status') {
      return (
        <select
          value={valueFor(record, field)}
          onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
          onBlur={() => void savePoolRecord(record, field)}
        >
          <option value="pending">待采购</option>
          <option value="in_transit">海运在途</option>
          <option value="arrived">已到货</option>
        </select>
      );
    }
    if (field === 'loadingType') {
      return (
        <select
          value={valueFor(record, field) || '整柜'}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: value }));
            void savePoolRecordValue(record, field, value);
          }}
        >
          <option value="整柜">整柜</option>
          <option value="冠通">冠通</option>
        </select>
      );
    }
    if (type === 'date') {
      return (
        <input
          type="date"
          value={valueFor(record, field)}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: value }));
            void savePoolRecordValue(record, field, value);
          }}
        />
      );
    }
    return (
      <input
        type={type}
        value={valueFor(record, field)}
        onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
        onBlur={() => void savePoolRecord(record, field)}
      />
    );
  }

  function mixedChildRows(record: PurchaseRecord) {
    const mainSku = record.sku.trim().toUpperCase();
    return record.mixedGroups.flatMap((group) => group.lines
      .filter((line) => line.sku.trim().toUpperCase() && line.sku.trim().toUpperCase() !== mainSku)
      .map((line) => ({ group, line })));
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>采购订单池</h2>
          <p>buyer 提交后的订单先进入这里；分配物流商确认装柜，admin 审核通过后才进入采购 / 在途库存。</p>
        </div>
        <div className="export-actions">
          <button type="button" onClick={() => exportPurchaseRecords(submittedRecords, 'xlsx', '采购订单池')} disabled={submittedRecords.length === 0}>导出池中订单</button>
          <button type="button" onClick={() => exportBatchPurchaseOrder(submittedRecords, 'xlsx')} disabled={submittedRecords.length === 0}>导出本池订货表</button>
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}

      <div className="filter-grid">
        <label>装柜日期<select value={activePoolId} onChange={(event) => setSelectedPoolId(event.target.value)} disabled={options.length === 0}>
          {options.length === 0 && <option value="">暂无待发送装柜日期</option>}
          {options.map((pool) => {
            const label = pool.id === '__all_pending_purchase_pools__'
              ? '全部装柜日期'
              : pool.containerDate || '未填装柜日期';
            return <option key={pool.id} value={pool.id}>{label}（池中 {pool.submittedCount}）</option>;
          })}
        </select></label>
        <label>本池装柜日期<input type="date" value={poolDateDraft} onChange={(event) => setPoolDateDraft(event.target.value)} disabled={!canApplyPoolDate} /></label>
        {isAdmin && (
          <label>物流商账号
            <select value={logisticsUserId} onChange={(event) => setLogisticsUserId(event.target.value)} disabled={logisticsProfiles.length === 0}>
              {logisticsProfiles.length === 0 && <option value="">暂无物流商账号</option>}
              {logisticsProfiles.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.email}</option>)}
            </select>
          </label>
        )}
        {isAdmin && (
          <div className="form-actions">
            <button type="button" onClick={() => void applyPoolContainerDate()} disabled={!canApplyPoolDate || !poolDateDraft}>统一本池装柜日期</button>
            <button type="button" onClick={() => void sendDatedGuantongToInventory()} disabled={!activePool || submittedRecords.length === 0}>发送已填日期的冠通到在途库存</button>
            <button type="button" className="primary" onClick={() => void assignLogisticsBatch()} disabled={!activePool || submittedRecords.length === 0 || logisticsProfiles.length === 0}>生成/刷新物流批次</button>
          </div>
        )}
      </div>

      <div className="summary-grid inventory-summary">
        <div className="metric"><span>池中待发送</span><strong>{submittedRecords.length}</strong></div>
        <div className="metric"><span>池中总件数</span><strong>{totalPackages}</strong></div>
        <div className="metric"><span>池中采购数量</span><strong>{totalQuantity}</strong></div>
        <div className="metric"><span>池中总金额</span><strong>{totalAmount.toFixed(2)}</strong></div>
        <div className="metric"><span>池中总 CBM</span><strong>{totalCbm.toFixed(4)}</strong></div>
      </div>

      <div className="table-wrap purchase-pool-table-wrap">
        <table className="inventory-table">
          <thead>
            <tr>
              <th className="image-sticky-col">图片</th><th>厂家名</th><th>内部编号</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>装柜日期</th><th>计划采购数量</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th>采购单价</th><th>运费</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>装货方式</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {submittedRecords.map((record) => {
              const imageUrl = record.imageUrl || imageUrlBySku.get(skuLookupKey(record.sku)) || '';
              const purchaseUrl = purchaseUrlForRecord(record, skuBySku);
              const childRows = mixedChildRows(record);
              return (
                <Fragment key={record.id}>
                  <tr className={record.note.trim() ? 'has-note-row' : undefined}>
                    <td className="image-sticky-col">{imageUrl ? <img className="sku-thumb" src={imageUrl} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                    <td>{editableCell(record, 'manufacturerName')}</td>
                    <td><strong>{record.internalCode || '-'}</strong></td>
                    <td>{editableCell(record, 'sku')}</td>
                    <td>{editableCell(record, 'productName')}</td>
                    <td>{editableCell(record, 'englishName')}</td>
                    <td>{editableCell(record, 'shopName')}</td>
                    <td>{editableCell(record, 'assignedBuyerName')}</td>
                    <td>{editableCell(record, 'containerDate', 'date')}</td>
                    <td>{record.purchaseQuantity}</td>
                    <td>{editableCell(record, 'cartonCount', 'number')}</td>
                    <td>{editableCell(record, 'unitsPerCarton', 'number')}</td>
                    <td>{editableCell(record, 'tailQuantity', 'number')}</td>
                    <td>{packageCountFor(record)}</td>
                    <td>{purchaseQuantityForRecordSku(record)}</td>
                    <td>{record.isMixed ? '是' : '否'}</td>
                    <td>{editableCell(record, 'purchasePrice', 'number')}</td>
                    <td>{editableCell(record, 'freightCost', 'number')}</td>
                    <td>{editableCell(record, 'totalAmount', 'number')}</td>
                    <td>{editableCell(record, 'unitCbm', 'number')}</td>
                    <td>{editableCell(record, 'totalCbm', 'number')}</td>
                    <td>{editableCell(record, 'status')}</td>
                    <td>{editableCell(record, 'loadingType')}</td>
                    <td>{editableCell(record, 'note')}</td>
                    <td className="row-actions">
                      {purchaseUrl ? (
                        <button type="button" onClick={() => openPurchaseUrl(purchaseUrl)}>1688下单</button>
                      ) : (
                        <span className="muted-action">无采购链接</span>
                      )}
                      {isAdmin && <button type="button" onClick={() => void returnToBuyer(record)}>退回采购人</button>}
                    </td>
                  </tr>
                  {childRows.map(({ group, line }) => {
                    const childImageUrl = imageUrlBySku.get(skuLookupKey(line.sku)) || '';
                    return (
                      <tr className="mixed-child-row" key={`${record.id}:${group.id}:${line.id}`}>
                        <td className="image-sticky-col">{childImageUrl ? <img className="sku-thumb" src={childImageUrl} alt={line.productName || line.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                        <td>{record.manufacturerName}</td>
                        <td>{record.internalCode || '-'}</td>
                        <td><strong>{line.sku}</strong></td>
                        <td><strong>{line.productName}</strong></td>
                        <td />
                        <td>{record.shopName}</td>
                        <td>{record.assignedBuyerName}</td>
                        <td>{record.containerDate || record.purchaseBatchDate || '-'}</td>
                        <td />
                        <td />
                        <td />
                        <td />
                        <td>{group.cartonCount}</td>
                        <td>{line.quantity}</td>
                        <td>混装子行</td>
                        <td>{line.purchasePrice}</td>
                        <td />
                        <td>{line.totalAmount.toFixed(2)}</td>
                        <td>{line.unitCbm.toFixed(8)}</td>
                        <td>{line.totalCbm.toFixed(4)}</td>
                        <td>{record.status}</td>
                        <td>{record.loadingType || '整柜'}</td>
                        <td>{`${group.groupName} ${group.cartonCount}件，与 ${record.sku || record.productName || '主商品'} 混装`}</td>
                        <td />
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {submittedRecords.length === 0 && <tr><td className="empty" colSpan={25}>暂无待发送采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
