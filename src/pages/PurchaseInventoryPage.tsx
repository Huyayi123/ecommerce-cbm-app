import { useMemo, useState } from 'react';
import type { AuditLog, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { exportAuditLogs, exportPurchaseRecords } from '../utils/exporters';
import { round } from '../utils/number';

type Props = {
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  auditLogs?: AuditLog[];
  onChange: (records: PurchaseRecord[]) => void;
  canEditData?: boolean;
  canDeleteData?: boolean;
};

type DraftRecord = Omit<PurchaseRecord, 'totalAmount'>;

const statusLabels: Record<PurchaseStatus, string> = {
  in_transit: '海运在途',
  arrived: '已到货',
  cancelled: '已取消',
};

const emptyDraft: DraftRecord = {
  id: '',
  manufacturerName: '',
  sku: '',
  productName: '',
  shopName: '',
  buyerName: '',
  purchaseQuantity: 0,
  purchasePrice: 0,
  purchaseDate: new Date().toISOString().slice(0, 10),
  estimatedArrivalDate: '',
  status: 'in_transit',
  totalCbm: 0,
  note: '',
};

function withTotalAmount(record: DraftRecord): PurchaseRecord {
  return {
    ...record,
    totalAmount: round(record.purchaseQuantity * record.purchasePrice, 2),
  };
}

function uniqueValues(records: PurchaseRecord[], field: keyof PurchaseRecord): string[] {
  return Array.from(new Set(records.map((record) => String(record[field] ?? '')).filter(Boolean))).sort();
}

function calcRecordCbm(item: SkuItem | undefined, quantity: number): number {
  if (!item || quantity <= 0) return 0;
  if (item.unitsPerCarton > 0 && item.cartonCbm > 0) {
    return round((quantity / item.unitsPerCarton) * item.cartonCbm, 4);
  }
  if (item.unitCbm > 0) {
    return round(quantity * item.unitCbm, 4);
  }
  return 0;
}

export function PurchaseInventoryPage({ records, skuItems, auditLogs = [], onChange, canEditData = true, canDeleteData = true }: Props) {
  const [draft, setDraft] = useState<DraftRecord>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState({
    manufacturerName: '',
    shopName: '',
    buyerName: '',
    status: 'in_transit' as PurchaseStatus | 'all',
    sku: '',
    purchaseDateFrom: '',
    purchaseDateTo: '',
    arrivalDateFrom: '',
    arrivalDateTo: '',
  });

  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        if (filters.status !== 'all' && record.status !== filters.status) return false;
        if (filters.manufacturerName && record.manufacturerName !== filters.manufacturerName) return false;
        if (filters.shopName && record.shopName !== filters.shopName) return false;
        if (filters.buyerName && record.buyerName !== filters.buyerName) return false;
        if (filters.sku && !record.sku.toLowerCase().includes(filters.sku.toLowerCase())) return false;
        if (filters.purchaseDateFrom && record.purchaseDate < filters.purchaseDateFrom) return false;
        if (filters.purchaseDateTo && record.purchaseDate > filters.purchaseDateTo) return false;
        if (filters.arrivalDateFrom && record.estimatedArrivalDate < filters.arrivalDateFrom) return false;
        if (filters.arrivalDateTo && record.estimatedArrivalDate > filters.arrivalDateTo) return false;
        return true;
      }),
    [filters, records],
  );

  const inTransitRecords = records.filter((record) => record.status === 'in_transit');
  const inTransitSkuCount = new Set(inTransitRecords.map((record) => record.sku)).size;
  const inTransitQuantity = inTransitRecords.reduce((sum, record) => sum + record.purchaseQuantity, 0);
  const inTransitAmount = inTransitRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const inTransitCbm = inTransitRecords.reduce((sum, record) => sum + record.totalCbm, 0);
  const arrivalBatchCount = new Set(inTransitRecords.map((record) => record.estimatedArrivalDate).filter(Boolean)).size;

  function patchDraft<K extends keyof DraftRecord>(field: K, value: DraftRecord[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function fillFromSku(sku: string) {
    const item = skuItems.find((candidate) => candidate.sku.trim().toUpperCase() === sku.trim().toUpperCase());
    setDraft((current) => ({
      ...current,
      sku,
      manufacturerName: item?.manufacturerName ?? current.manufacturerName,
      productName: item?.productName ?? current.productName,
      shopName: item?.shopName ?? current.shopName,
      buyerName: item?.buyerName ?? current.buyerName,
      totalCbm: calcRecordCbm(item, current.purchaseQuantity) || current.totalCbm,
    }));
  }

  function updateDraftQuantity(quantity: number) {
    const item = skuItems.find((candidate) => candidate.sku.trim().toUpperCase() === draft.sku.trim().toUpperCase());
    setDraft((current) => ({
      ...current,
      purchaseQuantity: quantity,
      totalCbm: calcRecordCbm(item, quantity) || current.totalCbm,
    }));
  }

  function resetDraft() {
    setDraft(emptyDraft);
    setEditingId(null);
  }

  function saveRecord() {
    if (!canEditData || !draft.sku.trim()) return;
    const record = withTotalAmount({ ...draft, id: editingId ?? crypto.randomUUID(), sku: draft.sku.trim() });
    if (editingId) {
      onChange(records.map((item) => (item.id === editingId ? record : item)));
    } else {
      onChange([record, ...records]);
    }
    resetDraft();
  }

  function editRecord(record: PurchaseRecord) {
    setDraft({
      id: record.id,
      manufacturerName: record.manufacturerName,
      sku: record.sku,
      productName: record.productName,
      shopName: record.shopName,
      buyerName: record.buyerName,
      purchaseQuantity: record.purchaseQuantity,
      purchasePrice: record.purchasePrice,
      purchaseDate: record.purchaseDate,
      estimatedArrivalDate: record.estimatedArrivalDate,
      status: record.status,
      totalCbm: record.totalCbm,
      note: record.note,
    });
    setEditingId(record.id);
  }

  function deleteRecord(id: string) {
    if (!canDeleteData) return;
    onChange(records.filter((record) => record.id !== id));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function markSelectedArrived() {
    if (!canEditData) return;
    onChange(records.map((record) => (selectedIds.has(record.id) ? { ...record, status: 'arrived' } : record)));
    setSelectedIds(new Set());
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <section className="summary-grid inventory-summary" aria-label="在途库存汇总">
        <div className="metric"><span>在途 SKU 数量</span><strong>{inTransitSkuCount}</strong></div>
        <div className="metric"><span>在途总件数</span><strong>{inTransitQuantity}</strong></div>
        <div className="metric"><span>在途总金额</span><strong>{inTransitAmount.toFixed(2)}</strong></div>
        <div className="metric"><span>在途总 CBM</span><strong>{inTransitCbm.toFixed(4)}</strong></div>
        <div className="metric"><span>预计到货批次数</span><strong>{arrivalBatchCount}</strong></div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>采购 / 海运在途库存</h2>
            <p>默认显示海运在途记录，到货和取消会保留历史。</p>
          </div>
          <div className="export-actions">
            <button type="button" onClick={() => exportPurchaseRecords(filteredRecords, 'xlsx')} disabled={filteredRecords.length === 0}>导出 Excel</button>
            <button type="button" onClick={() => exportPurchaseRecords(filteredRecords, 'csv')} disabled={filteredRecords.length === 0}>导出 CSV</button>
            {canEditData && <button type="button" onClick={markSelectedArrived} disabled={selectedIds.size === 0}>批量标记已到货</button>}
          </div>
        </div>

        <div className="filter-grid">
          <label>厂家名<select value={filters.manufacturerName} onChange={(event) => setFilters({ ...filters, manufacturerName: event.target.value })}><option value="">全部</option>{uniqueValues(records, 'manufacturerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>店铺<select value={filters.shopName} onChange={(event) => setFilters({ ...filters, shopName: event.target.value })}><option value="">全部</option>{uniqueValues(records, 'shopName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>采购人<select value={filters.buyerName} onChange={(event) => setFilters({ ...filters, buyerName: event.target.value })}><option value="">全部</option>{uniqueValues(records, 'buyerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as PurchaseStatus | 'all' })}><option value="in_transit">海运在途</option><option value="arrived">已到货</option><option value="cancelled">已取消</option><option value="all">全部历史</option></select></label>
          <label>SKU 搜索<input value={filters.sku} onChange={(event) => setFilters({ ...filters, sku: event.target.value })} /></label>
          <label>采购日期起<input type="date" value={filters.purchaseDateFrom} onChange={(event) => setFilters({ ...filters, purchaseDateFrom: event.target.value })} /></label>
          <label>采购日期止<input type="date" value={filters.purchaseDateTo} onChange={(event) => setFilters({ ...filters, purchaseDateTo: event.target.value })} /></label>
          <label>到货日期起<input type="date" value={filters.arrivalDateFrom} onChange={(event) => setFilters({ ...filters, arrivalDateFrom: event.target.value })} /></label>
          <label>到货日期止<input type="date" value={filters.arrivalDateTo} onChange={(event) => setFilters({ ...filters, arrivalDateTo: event.target.value })} /></label>
        </div>

        {canEditData && <div className="record-form">
          <label>厂家名<input value={draft.manufacturerName} onChange={(event) => patchDraft('manufacturerName', event.target.value)} /></label>
          <label>SKU<input value={draft.sku} onChange={(event) => fillFromSku(event.target.value)} /></label>
          <label>产品名称<input value={draft.productName} onChange={(event) => patchDraft('productName', event.target.value)} /></label>
          <label>店铺<input value={draft.shopName} onChange={(event) => patchDraft('shopName', event.target.value)} /></label>
          <label>采购人<input value={draft.buyerName} onChange={(event) => patchDraft('buyerName', event.target.value)} /></label>
          <label>采购数量<input type="number" min="0" value={draft.purchaseQuantity} onChange={(event) => updateDraftQuantity(Number(event.target.value))} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={(event) => patchDraft('purchasePrice', Number(event.target.value))} /></label>
          <label>总金额<input value={round(draft.purchaseQuantity * draft.purchasePrice, 2)} readOnly /></label>
          <label>采购日期<input type="date" value={draft.purchaseDate} onChange={(event) => patchDraft('purchaseDate', event.target.value)} /></label>
          <label>预计到货日期<input type="date" value={draft.estimatedArrivalDate} onChange={(event) => patchDraft('estimatedArrivalDate', event.target.value)} /></label>
          <label>状态<select value={draft.status} onChange={(event) => patchDraft('status', event.target.value as PurchaseStatus)}><option value="in_transit">海运在途</option><option value="arrived">已到货</option><option value="cancelled">已取消</option></select></label>
          <label className="wide">备注<input value={draft.note} onChange={(event) => patchDraft('note', event.target.value)} /></label>
          <div className="form-actions">
            <button className="primary" type="button" onClick={saveRecord} disabled={!draft.sku.trim()}>{editingId ? '保存修改' : '新增采购记录'}</button>
            <button type="button" onClick={resetDraft}>清空</button>
          </div>
        </div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>选择</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>店铺</th><th>采购人</th><th>采购数量</th><th>采购单价</th><th>总金额</th><th>采购日期</th><th>预计到货日期</th><th>状态</th><th>总 CBM</th><th>备注</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <tr key={record.id}>
                  <td><input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => toggleSelection(record.id)} /></td>
                  <td>{record.manufacturerName}</td>
                  <td>{record.sku}</td>
                  <td>{record.productName}</td>
                  <td>{record.shopName}</td>
                  <td>{record.buyerName}</td>
                  <td>{record.purchaseQuantity}</td>
                  <td>{record.purchasePrice}</td>
                  <td>{record.totalAmount.toFixed(2)}</td>
                  <td>{record.purchaseDate}</td>
                  <td>{record.estimatedArrivalDate}</td>
                  <td>{statusLabels[record.status]}</td>
                  <td>{record.totalCbm.toFixed(4)}</td>
                  <td>{record.note}</td>
                  <td className="row-actions">
                    {canEditData && <button type="button" onClick={() => editRecord(record)}>编辑</button>}
                    {canDeleteData && <button className="danger" type="button" onClick={() => deleteRecord(record.id)}>删除</button>}
                  </td>
                </tr>
              ))}
              {filteredRecords.length === 0 && <tr><td colSpan={15} className="empty">暂无采购记录。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>操作记录</h2>
            <p>记录谁新增了 SKU、谁修改了价格、谁标记到货以及操作时间。</p>
          </div>
          <div className="export-actions">
            <button type="button" onClick={() => exportAuditLogs(auditLogs, 'xlsx')} disabled={auditLogs.length === 0}>导出操作记录 Excel</button>
            <button type="button" onClick={() => exportAuditLogs(auditLogs, 'csv')} disabled={auditLogs.length === 0}>导出操作记录 CSV</button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>操作时间</th>
                <th>操作人</th>
                <th>角色</th>
                <th>操作</th>
                <th>模块</th>
                <th>对象 ID</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td>{new Date(log.createdAt).toLocaleString()}</td>
                  <td>{log.actorEmail}</td>
                  <td>{log.actorRole}</td>
                  <td>{log.action}</td>
                  <td>{log.entityType}</td>
                  <td>{log.entityId}</td>
                  <td>{log.summary}</td>
                </tr>
              ))}
              {auditLogs.length === 0 && <tr><td colSpan={7} className="empty">暂无操作记录。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
