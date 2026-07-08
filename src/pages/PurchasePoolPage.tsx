import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AppProfile, PurchasePool, PurchaseRecord, SkuItem } from '../types';
import { exportBatchPurchaseOrder, exportPurchaseRecords } from '../utils/exporters';
import { formatErrorMessage } from '../utils/errors';
import { calculatedPurchaseTotalAmount, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  pools: PurchasePool[];
  profile: AppProfile;
  skuItems: SkuItem[];
  onSaveRecords: (records: PurchaseRecord[]) => void | Promise<void>;
  onSavePools: (pools: PurchasePool[]) => void | Promise<void>;
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
    const pendingRecords = pool.records.filter(isPoolPendingRecord);
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
    if (existing?.records.some((item) => item.id === record.id)) continue;
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
    option.records.push(record);
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

export function PurchasePoolPage({ records, pools, profile, skuItems, onSaveRecords, onSavePools }: Props) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [message, setMessage] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [poolDateDraft, setPoolDateDraft] = useState('');
  const isAdmin = profile.role === 'admin';
  const poolOptions = useMemo(() => buildPoolOptions(records, pools), [pools, records]);
  const options = useMemo(() => {
    const aggregatePool = buildAggregatePool(poolOptions);
    return aggregatePool ? [aggregatePool, ...poolOptions] : poolOptions;
  }, [poolOptions]);
  const activePoolId = selectedPoolId && options.some((pool) => pool.id === selectedPoolId) ? selectedPoolId : options[0]?.id || '';
  const activePool = options.find((pool) => pool.id === activePoolId);
  const poolRecords = activePool?.records.map(withPurchaseTotals) ?? [];
  const submittedRecords = poolRecords.filter((record) => record.status !== 'cancelled');
  const canEditActivePool = isAdmin && !activePool?.isAggregate;
  const canApplyPoolDate = isAdmin && Boolean(activePool);
  const canSendActivePool = isAdmin && Boolean(activePool);
  const activeContainerDate = poolDateDraft.trim() || activePool?.containerDate || '';
  const imageUrlBySku = useMemo(
    () => new Map(skuItems
      .filter((item) => item.sku.trim())
      .map((item) => [item.sku.trim().toUpperCase(), item.imageUrl])),
    [skuItems],
  );
  const totalQuantity = submittedRecords.reduce((sum, record) => sum + purchaseQuantityForRecordSku(record), 0);
  const totalAmount = submittedRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const totalCbm = submittedRecords.reduce((sum, record) => sum + record.totalCbm, 0);
  const totalPackages = submittedRecords.reduce((sum, record) => sum + packageCountFor(record), 0);

  useEffect(() => {
    setPoolDateDraft(activePool?.containerDate || '');
  }, [activePool?.containerDate, activePool?.id]);

  async function applyPoolContainerDate() {
    if (!canApplyPoolDate || !activePool) {
      return;
    }
    const nextDate = poolDateDraft.trim();
    if (!nextDate) {
      setMessage('请先填写本池装柜日期。');
      return;
    }
    const nextRecords = submittedRecords.map((record) => withPurchaseTotals({
      ...record,
      purchasePoolId: activePool.isAggregate ? record.purchasePoolId : activePool.id,
      purchasePoolName: activePool.isAggregate ? record.purchasePoolName : activePool.name,
      purchasePoolDate: nextDate,
      purchaseBatchId: activePool.isAggregate ? record.purchaseBatchId : record.purchaseBatchId || activePool.id,
      purchaseBatchName: activePool.isAggregate ? record.purchaseBatchName : activePool.name,
      purchaseBatchDate: nextDate,
      containerDate: nextDate,
    }));
    const nextRecordsById = new Map(nextRecords.map((record) => [record.id, record]));
    const nextPools: PurchasePool[] = activePool.isAggregate
      ? poolOptions.flatMap((pool): PurchasePool[] => {
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
      setMessage(`已把本池 ${nextRecords.length} 条订单的装柜日期统一修改为 ${nextDate}。`);
    } catch (error) {
      console.error(error);
      setMessage(`统一装柜日期失败：${formatErrorMessage(error)}`);
    }
  }

  async function sendPoolToInventory() {
    if (!canSendActivePool || !activePool || submittedRecords.length === 0) {
      if (activePool?.isAggregate) setMessage('请先选择一个具体采购池，再发送到采购 / 在途库存。');
      return;
    }
    const nextContainerDate = poolDateDraft.trim() || activePool.containerDate;
    const now = new Date().toISOString();
    const nextRecords = submittedRecords.map((record) => withPurchaseTotals({
      ...record,
      isConfirmed: true,
      poolStatus: 'sent_to_inventory',
      status: 'in_transit',
      purchasePoolId: activePool.isAggregate ? record.purchasePoolId : activePool.id,
      purchasePoolName: activePool.isAggregate ? record.purchasePoolName : activePool.name,
      purchasePoolDate: nextContainerDate || record.containerDate || record.purchasePoolDate || record.purchaseBatchDate || record.purchaseDate,
      purchaseBatchId: activePool.isAggregate ? record.purchaseBatchId : record.purchaseBatchId || activePool.id,
      purchaseBatchName: activePool.isAggregate ? record.purchaseBatchName : activePool.name,
      purchaseBatchDate: nextContainerDate || record.containerDate || record.purchasePoolDate || record.purchaseBatchDate || record.purchaseDate,
      containerDate: nextContainerDate || record.containerDate || record.purchasePoolDate || record.purchaseBatchDate || record.purchaseDate,
    }));
    const sentRecordsById = new Set(nextRecords.map((record) => record.id));
    const existingPoolIds = new Set(pools.map((pool) => pool.id));
    const nextPools: PurchasePool[] = activePool.isAggregate
      ? poolOptions.flatMap((pool): PurchasePool[] => {
        const hasSentRecord = pool.records.some((record) => sentRecordsById.has(record.id));
        if (!hasSentRecord || !existingPoolIds.has(pool.id)) return [];
        const remainingRecords = pool.records.filter((record) => !sentRecordsById.has(record.id));
        return [{
          id: pool.id,
          name: pool.name,
          containerDate: nextContainerDate || pool.containerDate,
          status: remainingRecords.length > 0 ? pool.status : 'sent',
          createdBy: pool.createdBy,
          createdAt: pool.createdAt,
          sentBy: remainingRecords.length > 0 ? pool.sentBy : profile.id,
          sentAt: remainingRecords.length > 0 ? pool.sentAt : now,
          note: pool.note,
          records: remainingRecords,
        }];
      })
      : [{
        ...activePool,
        containerDate: nextContainerDate,
        status: 'sent',
        sentBy: profile.id,
        sentAt: now,
        records: [],
      }];
    try {
      await onSaveRecords(nextRecords);
      if (nextPools.length > 0) await onSavePools(nextPools);
      setMessage(`已发送 ${nextRecords.length} 条采购订单到采购 / 在途库存。`);
    } catch (error) {
      console.error(error);
      setMessage(`发送失败：${formatErrorMessage(error)}`);
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

  function patchRecord(record: PurchaseRecord, field: EditablePoolField, value: string): PurchaseRecord {
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
    if (!(key in drafts) || !canEditActivePool || !activePool) return;
    const nextRecord = patchRecord(record, field, drafts[key]);
    const nextPool: PurchasePool = {
      ...activePool,
      records: activePool.records.map((item) => (item.id === nextRecord.id ? nextRecord : item)),
    };
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await onSavePools([nextPool]);
      setMessage('已保存采购池订单修改。');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    }
  }

  async function returnToBuyer(record: PurchaseRecord) {
    if (!canEditActivePool || !activePool) {
      if (activePool?.isAggregate) setMessage('请先选择一个具体采购池，再退回采购人。');
      return;
    }
    const nextRecord = withPurchaseTotals({
      ...record,
      isConfirmed: false,
      confirmedPurchaseQuantity: null,
      status: 'pending',
      poolStatus: 'pending_purchase',
    });
    try {
      const nextPool: PurchasePool = activePool ? {
        ...activePool,
        records: activePool.records.filter((item) => item.id !== record.id),
      } : {
        id: record.purchasePoolId || record.purchaseBatchId,
        name: record.purchasePoolName || record.purchaseBatchName,
        containerDate: record.purchasePoolDate || record.purchaseBatchDate,
        status: 'open',
        createdBy: '',
        createdAt: '',
        sentBy: '',
        sentAt: '',
        note: '',
        records: [],
      };
      await onSavePools([nextPool]);
      await onSaveRecords([nextRecord]);
      setMessage(`已退回 ${record.sku || record.productName} 给采购人。`);
    } catch (error) {
      console.error(error);
      setMessage(`退回失败：${formatErrorMessage(error)}`);
    }
  }

  function editableCell(record: PurchaseRecord, field: EditablePoolField, type = 'text') {
    if (!canEditActivePool) return <span>{valueFor(record, field)}</span>;
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
          onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
          onBlur={() => void savePoolRecord(record, field)}
        >
          <option value="整柜">整柜</option>
          <option value="冠通">冠通</option>
        </select>
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
          <p>buyer 提交后的订单先进入这里；admin 统一发送后，才进入采购 / 在途库存。</p>
        </div>
        <div className="export-actions">
          <button type="button" onClick={() => exportPurchaseRecords(submittedRecords, 'xlsx', '采购订单池')} disabled={submittedRecords.length === 0}>导出池中订单</button>
          <button type="button" onClick={() => exportBatchPurchaseOrder(submittedRecords, 'xlsx')} disabled={submittedRecords.length === 0}>导出本池订货表</button>
          {isAdmin && <button className="primary" type="button" onClick={() => void sendPoolToInventory()} disabled={submittedRecords.length === 0}>发送到采购 / 在途库存</button>}
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}

      <div className="filter-grid">
        <label>采购订单池<select value={activePoolId} onChange={(event) => setSelectedPoolId(event.target.value)} disabled={options.length === 0}>
          {options.length === 0 && <option value="">暂无待发送采购池</option>}
          {options.map((pool) => <option key={pool.id} value={pool.id}>{pool.containerDate || '未填装柜日期'} {pool.name}（池中 {pool.submittedCount}）</option>)}
        </select></label>
        <label>本池装柜日期<input type="date" value={poolDateDraft} onChange={(event) => setPoolDateDraft(event.target.value)} disabled={!canApplyPoolDate} /></label>
        {isAdmin && (
          <div className="form-actions">
            <button type="button" onClick={() => void applyPoolContainerDate()} disabled={!canApplyPoolDate || !poolDateDraft}>统一本池装柜日期</button>
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
              <th className="image-sticky-col">图片</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>装柜日期</th><th>计划采购数量</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th>采购单价</th><th>运费</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>装货方式</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {submittedRecords.map((record) => {
              const imageUrl = record.imageUrl || skuItems.find((item) => item.sku.trim() && item.sku.trim().toUpperCase() === record.sku.trim().toUpperCase())?.imageUrl || '';
              const childRows = mixedChildRows(record);
              return (
                <Fragment key={record.id}>
                  <tr className={record.note.trim() ? 'has-note-row' : undefined}>
                    <td className="image-sticky-col">{imageUrl ? <img className="sku-thumb" src={imageUrl} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                    <td>{editableCell(record, 'manufacturerName')}</td>
                    <td>{editableCell(record, 'sku')}</td>
                    <td>{editableCell(record, 'productName')}</td>
                    <td>{editableCell(record, 'englishName')}</td>
                    <td>{editableCell(record, 'shopName')}</td>
                    <td>{editableCell(record, 'assignedBuyerName')}</td>
                    <td>{activeContainerDate || record.purchaseBatchDate || '-'}</td>
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
                    <td className="row-actions">{isAdmin && <button type="button" onClick={() => void returnToBuyer(record)}>退回采购人</button>}</td>
                  </tr>
                  {childRows.map(({ group, line }) => {
                    const childImageUrl = imageUrlBySku.get(line.sku.trim().toUpperCase()) || '';
                    return (
                      <tr className="mixed-child-row" key={`${record.id}:${group.id}:${line.id}`}>
                        <td className="image-sticky-col">{childImageUrl ? <img className="sku-thumb" src={childImageUrl} alt={line.productName || line.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                        <td>{record.manufacturerName}</td>
                        <td><strong>{line.sku}</strong></td>
                        <td><strong>{line.productName}</strong></td>
                        <td />
                        <td>{record.shopName}</td>
                        <td>{record.assignedBuyerName}</td>
                        <td>{activeContainerDate || record.purchaseBatchDate || '-'}</td>
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
            {submittedRecords.length === 0 && <tr><td className="empty" colSpan={24}>暂无待发送采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
