import { useMemo, useState } from 'react';
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
};

type EditablePoolField =
  | 'manufacturerName'
  | 'sku'
  | 'productName'
  | 'englishName'
  | 'shopName'
  | 'assignedBuyerName'
  | 'purchaseBatchDate'
  | 'purchaseBatchName'
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

function buildPoolOptions(records: PurchaseRecord[], pools: PurchasePool[]): PoolOption[] {
  const options = new Map<string, PoolOption>();
  for (const pool of pools) {
    options.set(pool.id, { ...pool, recordCount: pool.records.length, submittedCount: pool.records.length });
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
    option.recordCount += 1;
    if (record.poolStatus === 'submitted_to_pool') option.submittedCount += 1;
    options.set(key, option);
  }
  return Array.from(options.values())
    .filter((pool) => pool.submittedCount > 0)
    .sort((left, right) => (
      (right.containerDate || '').localeCompare(left.containerDate || '')
      || right.name.localeCompare(left.name, 'zh-Hans-CN')
    ));
}

export function PurchasePoolPage({ records, pools, profile, skuItems, onSaveRecords, onSavePools }: Props) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [message, setMessage] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const isAdmin = profile.role === 'admin';
  const options = useMemo(() => buildPoolOptions(records, pools), [pools, records]);
  const activePoolId = selectedPoolId && options.some((pool) => pool.id === selectedPoolId) ? selectedPoolId : options[0]?.id || '';
  const activePool = options.find((pool) => pool.id === activePoolId);
  const poolRecords = activePool?.records.map(withPurchaseTotals) ?? [];
  const submittedRecords = poolRecords.filter((record) => record.status !== 'cancelled');
  const totalQuantity = submittedRecords.reduce((sum, record) => sum + purchaseQuantityForRecordSku(record), 0);
  const totalAmount = submittedRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const totalCbm = submittedRecords.reduce((sum, record) => sum + record.totalCbm, 0);
  const totalPackages = submittedRecords.reduce((sum, record) => sum + packageCountFor(record), 0);

  async function sendPoolToInventory() {
    if (!isAdmin || !activePool || submittedRecords.length === 0) return;
    const now = new Date().toISOString();
    const nextRecords = submittedRecords.map((record) => withPurchaseTotals({
      ...record,
      isConfirmed: true,
      poolStatus: 'sent_to_inventory',
      status: 'in_transit',
      purchasePoolId: activePool.id,
      purchasePoolName: activePool.name,
      purchasePoolDate: activePool.containerDate,
      purchaseBatchId: record.purchaseBatchId || activePool.id,
      purchaseBatchName: record.purchaseBatchName || activePool.name,
      purchaseBatchDate: record.purchaseBatchDate || activePool.containerDate,
      containerDate: record.containerDate || activePool.containerDate,
    }));
    const nextPool: PurchasePool = {
      ...activePool,
      status: 'sent',
      sentBy: profile.id,
      sentAt: now,
      records: [],
    };
    try {
      await onSaveRecords(nextRecords);
      await onSavePools([nextPool]);
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
    if (!(key in drafts) || !isAdmin || !activePool) return;
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
    if (!isAdmin || !activePool) return;
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
    if (!isAdmin) return <span>{valueFor(record, field)}</span>;
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
      </div>

      <div className="summary-grid inventory-summary">
        <div className="metric"><span>池中待发送</span><strong>{submittedRecords.length}</strong></div>
        <div className="metric"><span>池中总件数</span><strong>{totalPackages}</strong></div>
        <div className="metric"><span>池中采购数量</span><strong>{totalQuantity}</strong></div>
        <div className="metric"><span>池中总金额</span><strong>{totalAmount.toFixed(2)}</strong></div>
        <div className="metric"><span>池中总 CBM</span><strong>{totalCbm.toFixed(4)}</strong></div>
      </div>

      <div className="table-wrap inventory-table-wrap">
        <table className="inventory-table">
          <thead>
            <tr>
              <th>图片</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>装柜日期</th><th>批次</th><th>计划采购数量</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th>采购单价</th><th>运费</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>装货方式</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {submittedRecords.map((record) => {
              const imageUrl = record.imageUrl || skuItems.find((item) => item.sku.trim() && item.sku.trim().toUpperCase() === record.sku.trim().toUpperCase())?.imageUrl || '';
              return (
                <tr key={record.id} className={record.note.trim() ? 'has-note-row' : undefined}>
                  <td>{imageUrl ? <img className="sku-thumb" src={imageUrl} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                  <td>{editableCell(record, 'manufacturerName')}</td>
                  <td>{editableCell(record, 'sku')}</td>
                  <td>{editableCell(record, 'productName')}</td>
                  <td>{editableCell(record, 'englishName')}</td>
                  <td>{editableCell(record, 'shopName')}</td>
                  <td>{editableCell(record, 'assignedBuyerName')}</td>
                  <td>{editableCell(record, 'purchaseBatchDate', 'date')}</td>
                  <td>{editableCell(record, 'purchaseBatchName')}</td>
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
              );
            })}
            {submittedRecords.length === 0 && <tr><td className="empty" colSpan={25}>暂无待发送采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
