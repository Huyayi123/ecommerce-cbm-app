import { useMemo, useState } from 'react';
import type { AppProfile, PurchasePool, PurchaseRecord, SkuItem } from '../types';
import { exportBatchPurchaseOrder, exportPurchaseRecords } from '../utils/exporters';
import { formatErrorMessage } from '../utils/errors';
import { packageCountFor, purchaseQuantityWithMixed, withPurchaseTotals } from '../utils/purchaseRecords';

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
    options.set(pool.id, { ...pool, recordCount: 0, submittedCount: 0 });
  }
  for (const record of records) {
    const key = poolKey(record);
    if (!key) continue;
    const existing = options.get(key);
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

function recordMatchesPool(record: PurchaseRecord, selectedPoolId: string): boolean {
  return poolKey(record) === selectedPoolId;
}

export function PurchasePoolPage({ records, pools, profile, skuItems, onSaveRecords, onSavePools }: Props) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [message, setMessage] = useState('');
  const isAdmin = profile.role === 'admin';
  const options = useMemo(() => buildPoolOptions(records, pools), [pools, records]);
  const activePoolId = selectedPoolId && options.some((pool) => pool.id === selectedPoolId) ? selectedPoolId : options[0]?.id || '';
  const activePool = options.find((pool) => pool.id === activePoolId);
  const poolRecords = records
    .filter((record) => (
      activePoolId
      && recordMatchesPool(record, activePoolId)
      && record.status !== 'cancelled'
      && record.poolStatus !== 'pending_purchase'
    ))
    .map(withPurchaseTotals);
  const submittedRecords = poolRecords.filter((record) => record.poolStatus === 'submitted_to_pool');
  const sentRecords = poolRecords.filter((record) => record.poolStatus === 'sent_to_inventory');
  const pendingRecords = poolRecords.filter((record) => record.poolStatus === 'pending_purchase');
  const totalQuantity = submittedRecords.reduce((sum, record) => sum + purchaseQuantityWithMixed(record), 0);
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
        <div className="metric"><span>待采购</span><strong>{pendingRecords.length}</strong></div>
        <div className="metric"><span>已发送</span><strong>{sentRecords.length}</strong></div>
        <div className="metric"><span>池中总件数</span><strong>{totalPackages}</strong></div>
        <div className="metric"><span>池中采购数量</span><strong>{totalQuantity}</strong></div>
        <div className="metric"><span>池中总金额</span><strong>{totalAmount.toFixed(2)}</strong></div>
        <div className="metric"><span>池中总 CBM</span><strong>{totalCbm.toFixed(4)}</strong></div>
      </div>

      <div className="table-wrap inventory-table-wrap">
        <table className="inventory-table">
          <thead>
            <tr>
              <th>图片</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>采购数量</th><th>采购单价</th><th>运费</th><th>总金额</th><th>总CBM</th><th>总件数</th><th>池状态</th><th>备注</th>
            </tr>
          </thead>
          <tbody>
            {poolRecords.map((record) => {
              const imageUrl = record.imageUrl || skuItems.find((item) => item.sku.trim() && item.sku.trim().toUpperCase() === record.sku.trim().toUpperCase())?.imageUrl || '';
              return (
                <tr key={record.id} className={record.note.trim() ? 'has-note-row' : undefined}>
                  <td>{imageUrl ? <img className="sku-thumb" src={imageUrl} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                  <td><span className="cell-ellipsis" title={record.manufacturerName}>{record.manufacturerName}</span></td>
                  <td>{record.sku}</td>
                  <td><span className="cell-ellipsis" title={record.productName}>{record.productName}</span></td>
                  <td><span className="cell-ellipsis" title={record.englishName}>{record.englishName}</span></td>
                  <td>{record.shopName}</td>
                  <td>{record.assignedBuyerName || record.buyerName}</td>
                  <td>{purchaseQuantityWithMixed(record)}</td>
                  <td>{record.purchasePrice}</td>
                  <td>{record.freightCost}</td>
                  <td>{record.totalAmount.toFixed(2)}</td>
                  <td>{record.totalCbm.toFixed(4)}</td>
                  <td>{packageCountFor(record)}</td>
                  <td>{record.poolStatus === 'submitted_to_pool' ? '池中待发送' : record.poolStatus === 'sent_to_inventory' ? '已发送在途' : '待采购'}</td>
                  <td><span className="cell-ellipsis note-cell" title={record.note}>{record.note}</span></td>
                </tr>
              );
            })}
            {poolRecords.length === 0 && <tr><td className="empty" colSpan={15}>暂无采购订单池数据。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
