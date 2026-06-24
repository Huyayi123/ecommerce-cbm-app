import { Fragment, useEffect, useMemo, useState } from 'react';
import type { MixedCartonGroup, MixedCartonLine, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { exportBatchPurchaseOrder, exportInspectionChecklist, exportPurchaseRecords } from '../utils/exporters';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, isInventoryRecord, logisticsCbmFor, logisticsText, mixedGroupsSummary, packageCountFor, purchaseAmountForRecordSku, purchaseQuantityForRecordSku, purchaseQuantityWithMixed, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  onChange: (records: PurchaseRecord[]) => void;
  canEditData?: boolean;
  canDeleteData?: boolean;
};

type DraftRecord = Omit<PurchaseRecord, 'totalAmount'>;

type MixedChildRow = {
  group: MixedCartonGroup;
  line: MixedCartonLine;
};

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
  freightCost: 0,
  purchaseDate: new Date().toISOString().slice(0, 10),
  purchaseBatchId: '',
  purchaseBatchName: '',
  purchaseBatchDate: '',
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
const RECENT_UPLOAD_WINDOW_MS = 20 * 60 * 1000;

function timestampMs(value?: string): number {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

function sortDateValue(record: PurchaseRecord): string {
  return record.containerDate || record.purchaseDate || '';
}

function isRecentlyUploaded(record: PurchaseRecord, nowMs: number): boolean {
  const createdAt = timestampMs(record.createdAt);
  return createdAt > 0 && nowMs >= createdAt && nowMs - createdAt <= RECENT_UPLOAD_WINDOW_MS;
}

function compareInventoryRecords(left: PurchaseRecord, right: PurchaseRecord, nowMs: number): number {
  const leftRecent = isRecentlyUploaded(left, nowMs);
  const rightRecent = isRecentlyUploaded(right, nowMs);
  if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;

  const dateDiff = sortDateValue(right).localeCompare(sortDateValue(left));
  if (dateDiff !== 0) return dateDiff;

  const manufacturerDiff = left.manufacturerName.localeCompare(right.manufacturerName, 'zh-Hans-CN');
  if (manufacturerDiff !== 0) return manufacturerDiff;

  const shopDiff = left.shopName.localeCompare(right.shopName, 'zh-Hans-CN');
  if (shopDiff !== 0) return shopDiff;

  const skuDiff = left.sku.localeCompare(right.sku, 'zh-Hans-CN');
  if (skuDiff !== 0) return skuDiff;

  return timestampMs(right.createdAt) - timestampMs(left.createdAt);
}

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
    totalAmount: round(effectivePurchaseQuantity(record) * record.purchasePrice + record.freightCost, 2),
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

function batchKey(record: Pick<PurchaseRecord, 'purchaseBatchId' | 'purchaseBatchDate' | 'purchaseBatchName'>): string {
  return record.purchaseBatchId || `${record.purchaseBatchDate}|${record.purchaseBatchName}`;
}

function batchLabel(record: Pick<PurchaseRecord, 'purchaseBatchDate' | 'purchaseBatchName'>): string {
  const date = record.purchaseBatchDate.trim();
  const name = record.purchaseBatchName.trim();
  if (date && name) return `${date} ${name}`;
  return name || date || '未分配批次';
}

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

export function PurchaseInventoryPage({ records, skuItems, onChange, canEditData = true, canDeleteData = true }: Props) {
  const [draft, setDraft] = useState<DraftRecord>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [sortNowMs, setSortNowMs] = useState(() => Date.now());
  const [filters, setFilters] = useState({
    manufacturerName: '',
    shopName: '',
    buyerName: '',
    status: 'all' as PurchaseStatus | 'all',
    loadingType: 'all' as PurchaseRecord['loadingType'] | 'all',
    purchaseBatchKey: '',
    search: '',
    purchaseMonth: 'recent',
    purchaseDateFrom: '',
    purchaseDateTo: '',
  });

  const inventoryRecords = useMemo(
    () => records.filter((record) => isInventoryRecord(record) && record.status !== 'cancelled'),
    [records],
  );
  const recentMonths = useMemo(() => recentMonthOptions(3), []);
  const purchaseMonthOptions = useMemo(() => {
    const months = Array.from(new Set(inventoryRecords.map((record) => record.purchaseDate.slice(0, 7)).filter(Boolean))).sort().reverse();
    return months.filter((month) => !recentMonths.includes(month));
  }, [inventoryRecords, recentMonths]);
  const batchOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const record of inventoryRecords) {
      const key = batchKey(record);
      if (!key.trim() && !record.purchaseBatchName && !record.purchaseBatchDate) continue;
      options.set(key, batchLabel(record));
    }
    return Array.from(options.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => right.label.localeCompare(left.label, 'zh-Hans-CN'));
  }, [inventoryRecords]);

  const filteredRecords = useMemo(
    () =>
      inventoryRecords.filter((record) => {
        if (filters.status !== 'all' && record.status !== filters.status) return false;
        if (filters.loadingType !== 'all' && (record.loadingType || '整柜') !== filters.loadingType) return false;
        if (filters.purchaseBatchKey && batchKey(record) !== filters.purchaseBatchKey) return false;
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
          const mixedSearchable = record.mixedGroups.flatMap((group) => group.lines.map((line) => `${line.sku} ${line.productName}`)).join(' ');
          const searchable = [
            record.sku,
            record.productName,
            mixedSearchable,
            needsLogisticsMetrics(record) && record.totalWeightKg !== null ? String(record.totalWeightKg) : '',
          ].join(' ').toLowerCase();
          if (!searchable.includes(search)) return false;
        }
        if (filters.purchaseDateFrom && record.purchaseDate < filters.purchaseDateFrom) return false;
        if (filters.purchaseDateTo && record.purchaseDate > filters.purchaseDateTo) return false;
        return true;
      }).sort((left, right) => compareInventoryRecords(left, right, sortNowMs)),
    [filters, inventoryRecords, recentMonths, sortNowMs],
  );
  const totalPages = Math.max(Math.ceil(filteredRecords.length / PAGE_SIZE), 1);
  const pagedRecords = filteredRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  useEffect(() => {
    const timer = window.setInterval(() => setSortNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const inTransitRecords = inventoryRecords.filter((record) => record.status === 'in_transit');
  const inTransitSkuCount = new Set(inTransitRecords.flatMap((record) => {
    const normalized = withPurchaseTotals(record);
    return [normalized.sku, ...mixedChildRows(normalized).map(({ line }) => line.sku)].filter(Boolean);
  })).size;
  const inTransitQuantity = inTransitRecords.reduce((sum, record) => sum + purchaseQuantityWithMixed(withPurchaseTotals(record)), 0);
  const inTransitAmount = inTransitRecords.reduce((sum, record) => sum + withPurchaseTotals(record).totalAmount, 0);
  const inTransitCbm = inTransitRecords.reduce((sum, record) => sum + logisticsCbmFor(record), 0);
  const loadingBatchCount = new Set(inTransitRecords.map((record) => record.containerDate).filter(Boolean)).size;
  const selectedRecords = inventoryRecords.filter((record) => selectedIds.has(record.id));
  const selectedBatchRecords = filters.purchaseBatchKey
    ? inventoryRecords.filter((record) => batchKey(record) === filters.purchaseBatchKey)
    : [];
  const imageUrlBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item.imageUrl])),
    [skuItems],
  );
  const skuBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item])),
    [skuItems],
  );

  function imageUrlFor(record: PurchaseRecord): string {
    return record.imageUrl || imageUrlBySku.get(record.sku.trim().toUpperCase()) || '';
  }

  function imageUrlForMixedLine(line: MixedCartonLine): string {
    return imageUrlBySku.get(line.sku.trim().toUpperCase()) || '';
  }

  function recordWithSkuDefaults(record: PurchaseRecord): PurchaseRecord {
    const skuItem = skuBySku.get(record.sku.trim().toUpperCase());
    if (!skuItem) return record;
    return {
      ...record,
      unitsPerCarton: record.unitsPerCarton ?? (skuItem.unitsPerCarton > 0 ? skuItem.unitsPerCarton : null),
      purchasePrice: record.purchasePrice || skuItem.purchasePrice,
      unitCbm: record.unitCbm || skuItem.unitCbm,
      imageUrl: record.imageUrl || skuItem.imageUrl,
      productName: record.productName || skuItem.productName,
      englishName: record.englishName || skuItem.englishName,
      manufacturerName: record.manufacturerName || skuItem.manufacturerName,
      shopName: record.shopName || skuItem.shopName,
    };
  }

  function mixedChildRows(record: PurchaseRecord): MixedChildRow[] {
    const mainSku = skuKey(record.sku);
    return record.mixedGroups.flatMap((group) => group.lines
      .filter((line) => skuKey(line.sku) && skuKey(line.sku) !== mainSku)
      .map((line) => ({ group, line })));
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
      unitsPerCarton: current.unitsPerCarton ?? (item && item.unitsPerCarton > 0 ? item.unitsPerCarton : null),
      purchasePrice: current.purchasePrice || item?.purchasePrice || 0,
      unitCbm: current.unitCbm || item?.unitCbm || 0,
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
      freightCost: record.freightCost,
      purchaseDate: record.purchaseDate,
      purchaseBatchId: record.purchaseBatchId,
      purchaseBatchName: record.purchaseBatchName,
      purchaseBatchDate: record.purchaseBatchDate,
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

  function exportSelectedInspectionChecklist() {
    if (selectedRecords.length === 0) return;
    exportInspectionChecklist(selectedRecords, 'xlsx', skuItems);
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
            <button type="button" onClick={() => exportBatchPurchaseOrder(selectedBatchRecords, 'xlsx')} disabled={selectedBatchRecords.length === 0}>导出本批次订货表</button>
            <button type="button" onClick={exportSelectedInspectionChecklist} disabled={selectedRecords.length === 0}>导出验货单（已选 {selectedRecords.length}）</button>
            <button type="button" onClick={() => setSelectedIds(new Set())} disabled={selectedRecords.length === 0}>清空勾选</button>
            {canEditData && <button type="button" onClick={markSelectedArrived} disabled={selectedIds.size === 0}>批量标记已到货</button>}
          </div>
        </div>

        <div className="filter-grid inventory-filter-grid">
          <label>采购月份<select value={filters.purchaseMonth} onChange={(event) => setFilters({ ...filters, purchaseMonth: event.target.value })}><option value="recent">最近 3 个月</option><option value="">全部月份</option>{purchaseMonthOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>厂家名<select value={filters.manufacturerName} onChange={(event) => setFilters({ ...filters, manufacturerName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'manufacturerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>店铺<select value={filters.shopName} onChange={(event) => setFilters({ ...filters, shopName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'shopName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>采购人<select value={filters.buyerName} onChange={(event) => setFilters({ ...filters, buyerName: event.target.value })}><option value="">全部</option>{uniqueValues(inventoryRecords, 'buyerName').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>批次<select value={filters.purchaseBatchKey} onChange={(event) => setFilters({ ...filters, purchaseBatchKey: event.target.value })}><option value="">全部批次</option>{batchOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>装货方式<select value={filters.loadingType} onChange={(event) => setFilters({ ...filters, loadingType: event.target.value as PurchaseRecord['loadingType'] | 'all' })}><option value="all">全部</option><option value="整柜">整柜</option><option value="冠通">冠通</option></select></label>
          <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as PurchaseStatus | 'all' })}><option value="pending">待采购</option><option value="in_transit">海运在途</option><option value="arrived">已到货</option><option value="all">全部历史</option></select></label>
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
          <label>运费<input type="number" min="0" step="0.01" value={draft.freightCost} onChange={(event) => patchDraft('freightCost', Number(event.target.value))} /></label>
          <label>总金额<input value={round(effectivePurchaseQuantity(draft) * draft.purchasePrice + draft.freightCost, 2)} readOnly /></label>
          <label>采购日期<input type="date" value={draft.purchaseDate} onChange={(event) => patchDraft('purchaseDate', event.target.value)} /></label>
          <label>批次日期<input type="date" value={draft.purchaseBatchDate} onChange={(event) => patchDraft('purchaseBatchDate', event.target.value)} /></label>
          <label>批次<input value={draft.purchaseBatchName} onChange={(event) => patchDraft('purchaseBatchName', event.target.value)} /></label>
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
          <label>状态<select value={draft.status} onChange={(event) => patchDraft('status', event.target.value as PurchaseStatus)}><option value="pending">待采购</option><option value="in_transit">海运在途</option><option value="arrived">已到货</option></select></label>
          <label className="wide">备注<input value={draft.note} onChange={(event) => patchDraft('note', event.target.value)} /></label>
          <div className="form-actions">
            <button className="primary" type="button" onClick={saveRecord} disabled={!draft.sku.trim()}>{editingId ? '保存修改' : '新增采购记录'}</button>
            <button type="button" onClick={resetDraft}>清空</button>
          </div>
        </div>}

        <div className="table-wrap inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>选择</th><th className="pin-col pin-image">图片</th><th className="pin-col pin-manufacturer">厂家名</th><th className="pin-col pin-sku">SKU</th><th className="pin-col pin-product">产品名称</th><th>批次</th><th>批次日期</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>是否混装</th><th>混装组</th><th>总重量kg</th><th>物流总CBM</th><th>店铺</th><th>采购人</th><th>采购数量</th><th>采购单价</th><th>运费</th><th>总金额</th><th>采购日期</th><th>状态</th><th>装货方式</th><th>装柜日期</th><th>单品CBM</th><th>备注</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedRecords.map((record) => {
                const normalized = withPurchaseTotals(recordWithSkuDefaults(record));
                const childRows = mixedChildRows(normalized);
                return (
                  <Fragment key={record.id}>
                    <tr className={normalized.note.trim() ? 'has-note-row' : undefined}>
                  <td><input type="checkbox" checked={selectedIds.has(normalized.id)} onChange={() => toggleSelection(normalized.id)} /></td>
                  <td className="pin-col pin-image">{imageUrlFor(normalized) ? <img className="sku-thumb" src={imageUrlFor(normalized)} alt={normalized.productName || normalized.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                  <td className="pin-col pin-manufacturer"><span className="cell-ellipsis" title={normalized.manufacturerName}>{normalized.manufacturerName}</span></td>
                  <td className="pin-col pin-sku"><span className="cell-ellipsis" title={normalized.sku}>{normalized.sku}</span></td>
                  <td className="pin-col pin-product"><span className="cell-ellipsis" title={normalized.productName}>{normalized.productName}</span></td>
                  <td>{batchLabel(normalized)}</td>
                  <td>{normalized.purchaseBatchDate || '-'}</td>
                  <td>{normalized.cartonCount ?? ''}</td>
                  <td>{normalized.unitsPerCarton ?? ''}</td>
                  <td>{normalized.tailQuantity}</td>
                  <td>{packageCountFor(normalized) || logisticsText(normalized.cartonCount)}</td>
                  <td>{normalized.isMixed ? '是' : '否'}</td>
                  <td>{mixedGroupsSummary(normalized)}</td>
                  <td>{needsLogisticsMetrics(normalized) ? logisticsText(normalized.totalWeightKg, 2) : ''}</td>
                  <td>{needsLogisticsMetrics(normalized) ? logisticsText(normalized.logisticsTotalCbm, 4) : ''}</td>
                  <td>{normalized.shopName}</td>
                  <td>{normalized.assignedBuyerName || normalized.buyerName}</td>
                  <td>{purchaseQuantityForRecordSku(normalized)}</td>
                  <td>{normalized.purchasePrice}</td>
                  <td>{normalized.freightCost}</td>
                  <td>{purchaseAmountForRecordSku(normalized).toFixed(2)}</td>
                  <td>{normalized.purchaseDate}</td>
                  <td>{statusLabels[normalized.status]}</td>
                  <td>{normalized.loadingType || '整柜'}</td>
                  <td>{normalized.containerDate || '-'}</td>
                  <td>{normalized.unitCbm.toFixed(8)}</td>
                  <td><span className="cell-ellipsis note-cell" title={normalized.note}>{normalized.note}</span></td>
                  <td className="row-actions">
                    {canEditData && <button type="button" onClick={() => editRecord(normalized)}>编辑</button>}
                    {canDeleteData && <button className="danger" type="button" onClick={() => deleteRecord(normalized.id)}>删除</button>}
                  </td>
                    </tr>
                    {childRows.map(({ group, line }) => {
                      const childImageUrl = imageUrlForMixedLine(line);
                      return (
                        <tr className="mixed-child-row" key={`${normalized.id}:${group.id}:${line.id}`}>
                          <td />
                          <td className="pin-col pin-image">{childImageUrl ? <img className="sku-thumb" src={childImageUrl} alt={line.productName || line.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                          <td className="pin-col pin-manufacturer"><span className="cell-ellipsis" title={normalized.manufacturerName}>{normalized.manufacturerName}</span></td>
                          <td className="pin-col pin-sku"><span className="cell-ellipsis" title={line.sku}>{line.sku}</span></td>
                          <td className="pin-col pin-product"><span className="cell-ellipsis" title={line.productName}>{line.productName}</span></td>
                          <td>{batchLabel(normalized)}</td>
                          <td>{normalized.purchaseBatchDate || '-'}</td>
                          <td />
                          <td />
                          <td />
                          <td />
                          <td>混装子行</td>
                          <td>{`${group.groupName} ${group.cartonCount}件`}</td>
                          <td />
                          <td />
                          <td>{normalized.shopName}</td>
                          <td>{normalized.assignedBuyerName || normalized.buyerName}</td>
                          <td>{line.quantity}</td>
                          <td>{line.purchasePrice}</td>
                          <td />
                          <td>{line.totalAmount.toFixed(2)}</td>
                          <td>{normalized.purchaseDate}</td>
                          <td>{statusLabels[normalized.status]}</td>
                          <td>{normalized.loadingType || '整柜'}</td>
                          <td>{normalized.containerDate || '-'}</td>
                          <td>{line.unitCbm.toFixed(8)}</td>
                          <td>{`与 ${normalized.sku || normalized.productName || '主商品'} 混装`}</td>
                          <td />
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
              {filteredRecords.length === 0 && <tr><td colSpan={28} className="empty">暂无已确认采购记录。待采购任务请在“我的采购订单”中确认后再进入这里。</td></tr>}
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

    </>
  );
}
