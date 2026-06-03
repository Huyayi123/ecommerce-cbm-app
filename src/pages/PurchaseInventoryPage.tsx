import { useEffect, useMemo, useState } from 'react';
import type { AuditLog, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { exportAuditLogs, exportInspectionChecklist, exportPurchaseRecords } from '../utils/exporters';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, isInventoryRecord, logisticsCbmFor, logisticsText, mixedGroupsSummary, packageCountFor, purchaseQuantityWithMixed, withPurchaseTotals } from '../utils/purchaseRecords';

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
  pending: '待采购',
  in_transit: '海运在途',
  arrived: '已到货',
  cancelled: '已取消',
};

const emptyDraft: DraftRecord = {
  id: '',
  manufacturerName: '',
  sku: '',
  productName: '',
  englishName: '',
  imageUrl: '',
  shopName: '',
  buyerName: '',
  assignedBuyerName: '',
  assignedBuyerEmail: '',
  isConfirmed: true,
  purchaseQuantity: 0,
  confirmedPurchaseQuantity: null,
  purchasePrice: 0,
  purchaseDate: new Date().toISOString().slice(0, 10),
  estimatedArrivalDate: '',
  status: 'pending',
  unitCbm: 0,
  totalCbm: 0,
  loadingType: '整柜',
  containerDate: '',
  totalWeightKg: null,
  cartonCount: null,
  unitsPerCarton: null,
  tailQuantity: 0,
  isMixed: false,
  mixedGroups: [],
  logisticsTotalCbm: null,
  note: '',
};

const PAGE_SIZE = 100;

function recentMonthOptions(count = 3): string[] {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

function withTotalAmount(record: DraftRecord): PurchaseRecord {
  return withPurchaseTotals({
    ...record,
    isConfirmed: true,
    totalAmount: round(effectivePurchaseQuantity(record) * record.purchasePrice, 2),
    totalCbm: record.totalCbm || round(effectivePurchaseQuantity(record) * record.unitCbm, 4),
  });
}

function uniqueValues(records: PurchaseRecord[], field: keyof PurchaseRecord): string[] {
  return Array.from(new Set(records.map((record) => String(record[field] ?? '')).filter(Boolean))).sort();
}

function calcRecordCbm(item: SkuItem | undefined, quantity: number): number {
  if (!item || quantity <= 0) return 0;
  if (item.unitCbm > 0) {
    return round(quantity * item.unitCbm, 4);
  }
  return 0;
}

function needsLogisticsMetrics(record: Pick<PurchaseRecord, 'loadingType'>): boolean {
  return record.loadingType === '冠通';
}

export function PurchaseInventoryPage({ records, skuItems, auditLogs = [], onChange, canEditData = true, canDeleteData = true }: Props) {
  const [draft, setDraft] = useState<DraftRecord>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    manufacturerName: '',
    shopName: '',
    buyerName: '',
    status: 'all' as PurchaseStatus | 'all',
    search: '',
    purchaseMonth: 'recent',
    purchaseDateFrom: '',
    purchaseDateTo: '',
  });

  const inventoryRecords = useMemo(() => records.filter(isInventoryRecord), [records]);
  const recentMonths = useMemo(() => recentMonthOptions(3), []);
  const purchaseMonthOptions = useMemo(() => {
    const months = Array.from(new Set(inventoryRecords.map((record) => record.purchaseDate.slice(0, 7)).filter(Boolean))).sort().reverse();
    return months.filter((month) => !recentMonths.includes(month));
  }, [inventoryRecords, recentMonths]);

  const filteredRecords = useMemo(
    () =>
      inventoryRecords.filter((record) => {
        if (filters.status !== 'all' && record.status !== filters.status) return false;
        if (filters.manufacturerName && record.manufacturerName !== filters.manufacturerName) return false;
        if (filters.shopName && record.shopName !== filters.shopName) return false;
        if (filters.buyerName && record.buyerName !== filters.buyerName) return false;
        const recordMonth = record.purchaseDate.slice(0, 7);
        if (filters.purchaseMonth === 'recent') {
          if (!recentMonths.includes(recordMonth)) return false;
        } else if (filters.purchaseMonth && recordMonth !== filters.purchaseMonth) {
          return false;
        }
        const search = filters.search.trim().toLowerCase();
        if (search) {
          const searchable = [
            record.sku,
            record.productName,
            needsLogisticsMetrics(record) && record.totalWeightKg !== null ? String(record.totalWeightKg) : '',
          ].join(' ').toLowerCase();
          if (!searchable.includes(search)) return false;
        }
        if (filters.purchaseDateFrom && record.purchaseDate < filters.purchaseDateFrom) return false;
        if (filters.purchaseDateTo && record.purchaseDate > filters.purchaseDateTo) return false;
        return true;
      }),
    [filters, inventoryRecords, recentMonths],
  );
  const totalPages = Math.max(Math.ceil(filteredRecords.length / PAGE_SIZE), 1);
  const pagedRecords = filteredRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const inTransitRecords = inventoryRecords.filter((record) => record.status === 'in_transit');
  const inTransitSkuCount = new Set(inTransitRecords.map((record) => record.sku)).size;
  const inTransitQuantity = inTransitRecords.reduce((sum, record) => sum + purchaseQuantityWithMixed(withPurchaseTotals(record)), 0);
  const inTransitAmount = inTransitRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const inTransitCbm = inTransitRecords.reduce((sum, record) => sum + logisticsCbmFor(record), 0);
  const loadingBatchCount = new Set(inTransitRecords.map((record) => record.containerDate).filter(Boolean)).size;
  const selectedRecords = inventoryRecords.filter((record) => selectedIds.has(record.id));
  const imageUrlBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item.imageUrl])),
    [skuItems],
  );

  function imageUrlFor(record: PurchaseRecord): string {
    return record.imageUrl || imageUrlBySku.get(record.sku.trim().toUpperCase()) || '';
  }

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
      imageUrl: item?.imageUrl ?? current.imageUrl,
      shopName: item?.shopName ?? current.shopName,
      buyerName: item?.buyerName ?? current.buyerName,
      assignedBuyerName: item?.buyerName ?? current.assignedBuyerName,
      englishName: item?.englishName ?? current.englishName,
      totalCbm: calcRecordCbm(item, effectivePurchaseQuantity(current)) || current.totalCbm,
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
      englishName: record.englishName,
      imageUrl: record.imageUrl,
      shopName: record.shopName,
      buyerName: record.buyerName,
      assignedBuyerName: record.assignedBuyerName,
      assignedBuyerEmail: record.assignedBuyerEmail,
      isConfirmed: true,
      purchaseQuantity: record.purchaseQuantity,
      confirmedPurchaseQuantity: record.confirmedPurchaseQuantity,
      purchasePrice: record.purchasePrice,
      purchaseDate: record.purchaseDate,
      estimatedArrivalDate: record.estimatedArrivalDate,
      status: record.status,
      unitCbm: record.unitCbm,
      totalCbm: record.totalCbm,
      loadingType: record.loadingType,
      containerDate: record.containerDate,
      totalWeightKg: record.totalWeightKg,
      cartonCount: record.cartonCount,
      unitsPerCarton: record.unitsPerCarton,
      tailQuantity: record.tailQuantity,
      isMixed: record.isMixed,
      mixedGroups: record.mixedGroups,
      logisticsTotalCbm: record.logisticsTotalCbm,
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
        <div className="metric"><span>装柜批次数</span><strong>{loadingBatchCount}</strong></div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>采购 / 海运在途库存</h2>
          <p>只显示采购人已确认回传的数据；物流商字段为空时显示待回传，不影响采购确认。</p>
          </div>
          <div className="export-actions">
            <button type="button" onClick={() => exportPurchaseRecords(filteredRecords, 'xlsx')} disabled={filteredRecords.length === 0}>导出 Excel</button>
            <button type="button" onClick={() => exportPurchaseRecords(filteredRecords, 'csv')} disabled={filteredRecords.length === 0}>导出 CSV</button>
            <button type="button" onClick={() => exportInspectionChecklist(selectedRecords, 'xlsx')} disabled={selectedRecords.length === 0}>导出验货单（已选 {selectedRecords.length}）</button>
            <button type="button" onClick={() => setSelectedIds(new Set())} disabled={selectedRecords.length === 0}>清空勾选</button>
            {canEditData && <button type="button" onClick={markSelectedArrived} disabled={selectedIds.size === 0}>批量标记已到货</button>}
          </div>
        </div>

        <div className="filter-grid inventory-filter-grid">
          <label>采购月份<select value={filters.purchaseMonth} onChange={(event) => setFilters({ ...filters, purchaseMonth: event.target.value })}><option value="recent">最近 3 个月</option><option value="">全部月份</option>{purchaseMonthOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>厂家名<select value={filters.manufacturerName} onChange={(event) => setFilters({ ...filters, manufacturerName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'manufacturerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>店铺<select value={filters.shopName} onChange={(event) => setFilters({ ...filters, shopName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'shopName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>采购人<select value={filters.buyerName} onChange={(event) => setFilters({ ...filters, buyerName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'buyerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as PurchaseStatus | 'all' })}><option value="pending">待采购</option><option value="in_transit">海运在途</option><option value="arrived">已到货</option><option value="cancelled">已取消</option><option value="all">全部历史</option></select></label>
          <label>采购日期起<input type="date" value={filters.purchaseDateFrom} onChange={(event) => setFilters({ ...filters, purchaseDateFrom: event.target.value })} /></label>
          <label>采购日期止<input type="date" value={filters.purchaseDateTo} onChange={(event) => setFilters({ ...filters, purchaseDateTo: event.target.value })} /></label>
        </div>

        <div className="inventory-search-bar">
          <input
            value={searchDraft}
            placeholder="搜索 SKU、中文名称、总重量"
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setFilters((current) => ({ ...current, search: searchDraft }));
            }}
          />
          <button type="button" onClick={() => setFilters((current) => ({ ...current, search: searchDraft }))}>搜索</button>
        </div>

        {canEditData && <div className="record-form">
          <label>厂家名<input value={draft.manufacturerName} onChange={(event) => patchDraft('manufacturerName', event.target.value)} /></label>
          <label>SKU<input value={draft.sku} onChange={(event) => fillFromSku(event.target.value)} /></label>
          <label>产品名称<input value={draft.productName} onChange={(event) => patchDraft('productName', event.target.value)} /></label>
          <label>英文名称<input value={draft.englishName} onChange={(event) => patchDraft('englishName', event.target.value)} /></label>
          <label>图片链接<input value={draft.imageUrl} onChange={(event) => patchDraft('imageUrl', event.target.value)} /></label>
          <label>店铺<input value={draft.shopName} onChange={(event) => patchDraft('shopName', event.target.value)} /></label>
          <label>采购人<input value={draft.assignedBuyerName || draft.buyerName} onChange={(event) => {
            patchDraft('buyerName', event.target.value);
            patchDraft('assignedBuyerName', event.target.value);
          }} /></label>
          <label>采购数量<input type="number" min="0" value={draft.confirmedPurchaseQuantity ?? ''} onChange={(event) => patchDraft('confirmedPurchaseQuantity', event.target.value === '' ? null : Number(event.target.value))} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={(event) => patchDraft('purchasePrice', Number(event.target.value))} /></label>
          <label>总金额<input value={round(effectivePurchaseQuantity(draft) * draft.purchasePrice, 2)} readOnly /></label>
          <label>采购日期<input type="date" value={draft.purchaseDate} onChange={(event) => patchDraft('purchaseDate', event.target.value)} /></label>
          <label>单品CBM<input type="number" min="0" step="0.00000001" value={draft.unitCbm} onChange={(event) => patchDraft('unitCbm', Number(event.target.value))} /></label>
          <label>总CBM<input type="number" min="0" step="0.0001" value={draft.totalCbm} onChange={(event) => patchDraft('totalCbm', Number(event.target.value))} /></label>
          <label>装货方式<select value={draft.loadingType || '整柜'} onChange={(event) => patchDraft('loadingType', event.target.value as PurchaseRecord['loadingType'])}><option value="整柜">整柜</option><option value="冠通">冠通</option></select></label>
          <label>装柜日期<input type="date" value={draft.containerDate} onChange={(event) => patchDraft('containerDate', event.target.value)} /></label>
          <label>整箱件数<input type="number" min="0" value={draft.cartonCount ?? ''} onChange={(event) => patchDraft('cartonCount', event.target.value === '' ? null : Number(event.target.value))} /></label>
          <label>每箱数量<input type="number" min="0" value={draft.unitsPerCarton ?? ''} onChange={(event) => patchDraft('unitsPerCarton', event.target.value === '' ? null : Number(event.target.value))} /></label>
          <label>尾箱数量<input type="number" min="0" value={draft.tailQuantity} onChange={(event) => patchDraft('tailQuantity', Number(event.target.value))} /></label>
          {needsLogisticsMetrics(draft) && <>
            <label>总重量kg<input type="number" min="0" step="0.01" value={draft.totalWeightKg ?? ''} onChange={(event) => patchDraft('totalWeightKg', event.target.value === '' ? null : Number(event.target.value))} /></label>
            <label>物流总CBM<input type="number" min="0" step="0.0001" value={draft.logisticsTotalCbm ?? ''} onChange={(event) => patchDraft('logisticsTotalCbm', event.target.value === '' ? null : Number(event.target.value))} /></label>
          </>}
          <label>状态<select value={draft.status} onChange={(event) => patchDraft('status', event.target.value as PurchaseStatus)}><option value="pending">待采购</option><option value="in_transit">海运在途</option><option value="arrived">已到货</option><option value="cancelled">已取消</option></select></label>
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
                <th>选择</th><th className="pin-col pin-image">图片</th><th className="pin-col pin-manufacturer">厂家名</th><th className="pin-col pin-sku">SKU</th><th className="pin-col pin-product">产品名称</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>件数</th><th>是否混装</th><th>混装组</th><th>总重量kg</th><th>物流总CBM</th><th>店铺</th><th>采购人</th><th>采购数量</th><th>采购单价</th><th>总金额</th><th>采购日期</th><th>状态</th><th>装货方式</th><th>装柜日期</th><th>单品CBM</th><th>备注</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedRecords.map((record) => {
                const normalized = withPurchaseTotals(record);
                return <tr key={record.id}>
                  <td><input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => toggleSelection(record.id)} /></td>
                  <td className="pin-col pin-image">{imageUrlFor(record) ? <img className="sku-thumb" src={imageUrlFor(record)} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                  <td className="pin-col pin-manufacturer">{record.manufacturerName}</td>
                  <td className="pin-col pin-sku">{record.sku}</td>
                  <td className="pin-col pin-product">{record.productName}</td>
                  <td>{record.cartonCount ?? ''}</td>
                  <td>{record.unitsPerCarton ?? ''}</td>
                  <td>{record.tailQuantity}</td>
                  <td>{packageCountFor(normalized) || logisticsText(record.cartonCount)}</td>
                  <td>{normalized.isMixed ? '是' : '否'}</td>
                  <td>{mixedGroupsSummary(normalized)}</td>
                  <td>{needsLogisticsMetrics(record) ? logisticsText(record.totalWeightKg, 2) : ''}</td>
                  <td>{needsLogisticsMetrics(record) ? logisticsText(record.logisticsTotalCbm, 4) : ''}</td>
                  <td>{record.shopName}</td>
                  <td>{record.assignedBuyerName || record.buyerName}</td>
                  <td>{purchaseQuantityWithMixed(normalized)}</td>
                  <td>{record.purchasePrice}</td>
                  <td>{normalized.totalAmount.toFixed(2)}</td>
                  <td>{record.purchaseDate}</td>
                  <td>{statusLabels[record.status]}</td>
                  <td>{record.loadingType || '整柜'}</td>
                  <td>{record.containerDate || '-'}</td>
                  <td>{record.unitCbm.toFixed(8)}</td>
                  <td>{record.note}</td>
                  <td className="row-actions">
                    {canEditData && <button type="button" onClick={() => editRecord(record)}>编辑</button>}
                    {canDeleteData && <button className="danger" type="button" onClick={() => deleteRecord(record.id)}>删除</button>}
                  </td>
                </tr>;
              })}
              {filteredRecords.length === 0 && <tr><td colSpan={25} className="empty">暂无已确认采购记录。待采购任务请在“我的采购订单”中确认后再进入这里。</td></tr>}
            </tbody>
          </table>
        </div>
        {filteredRecords.length > 0 && (
          <div className="pagination-bar">
            <span>共 {filteredRecords.length} 条，每页 {PAGE_SIZE} 条，第 {page} / {totalPages} 页</span>
            <button type="button" onClick={() => setPage(1)} disabled={page === 1}>首页</button>
            <button type="button" onClick={() => setPage((current) => Math.max(current - 1, 1))} disabled={page === 1}>上一页</button>
            <button type="button" onClick={() => setPage((current) => Math.min(current + 1, totalPages))} disabled={page === totalPages}>下一页</button>
            <button type="button" onClick={() => setPage(totalPages)} disabled={page === totalPages}>末页</button>
          </div>
        )}
      </section>

      <details className="panel audit-panel">
        <summary>操作记录（默认隐藏）</summary>
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
      </details>
    </>
  );
}
