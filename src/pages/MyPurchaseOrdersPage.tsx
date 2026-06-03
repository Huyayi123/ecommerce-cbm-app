import { Fragment, useMemo, useState } from 'react';
import type { AppProfile, MixedCartonGroup, MixedCartonLine, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { getSkuMatchKey, hydrateSku } from '../utils/calculations';
import { formatErrorMessage } from '../utils/errors';
import { exportPurchaseRecords } from '../utils/exporters';
import { parsePurchaseRecordsFile } from '../utils/fileParsers';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, mixedQuantityForOtherSkus, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  profile: AppProfile;
  onChange: (records: PurchaseRecord[]) => void | Promise<void>;
  onSkuChange: (items: SkuItem[]) => void | Promise<void>;
};

type NewOrderDraft = {
  manufacturerName: string;
  sku: string;
  productName: string;
  englishName: string;
  imageUrl: string;
  shopName: string;
  cartonCount: string;
  unitsPerCarton: string;
  tailQuantity: string;
  purchasePrice: string;
  unitCbm: string;
  status: PurchaseStatus;
  note: string;
};

const statusLabels: Record<PurchaseStatus, string> = {
  pending: '待采购',
  in_transit: '海运在途',
  arrived: '已到货',
  cancelled: '已取消',
};

const statusFilterOptions: Array<{ value: PurchaseStatus | 'all'; label: string }> = [
  { value: 'pending', label: '待采购' },
  { value: 'in_transit', label: '海运在途' },
  { value: 'arrived', label: '已到货' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部' },
];

const editableFields = [
  'manufacturerName',
  'sku',
  'productName',
  'englishName',
  'imageUrl',
  'shopName',
  'assignedBuyerName',
  'assignedBuyerEmail',
  'purchaseQuantity',
  'confirmedPurchaseQuantity',
  'cartonCount',
  'unitsPerCarton',
  'tailQuantity',
  'purchasePrice',
  'unitCbm',
  'status',
  'note',
] as const;

type EditableField = (typeof editableFields)[number];
type MixedLineField = 'sku' | 'productName' | 'quantity' | 'purchasePrice' | 'unitCbm';

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function createEmptyDraft(): NewOrderDraft {
  return {
    manufacturerName: '',
    sku: 'NEW',
    productName: '',
    englishName: '',
    imageUrl: '',
    shopName: '',
    cartonCount: '',
    unitsPerCarton: '',
    tailQuantity: '0',
    purchasePrice: '',
    unitCbm: '',
    status: 'pending',
    note: '',
  };
}

function isNewSkuValue(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return !normalized || normalized === 'NEW';
}

function recalcMixedLine(line: MixedCartonLine): MixedCartonLine {
  return {
    ...line,
    totalAmount: round(line.quantity * line.purchasePrice, 2),
    totalCbm: round(line.quantity * line.unitCbm, 4),
  };
}

function createMixedLine(): MixedCartonLine {
  return {
    id: crypto.randomUUID(),
    sku: '',
    productName: '',
    quantity: 0,
    purchasePrice: 0,
    unitCbm: 0,
    totalAmount: 0,
    totalCbm: 0,
  };
}

function createMixedGroup(index: number): MixedCartonGroup {
  return {
    id: crypto.randomUUID(),
    groupName: `混装${index + 1}`,
    cartonCount: 1,
    lines: [createMixedLine()],
  };
}

export function MyPurchaseOrdersPage({ records, skuItems, profile, onChange, onSkuChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mixedDrafts, setMixedDrafts] = useState<Record<string, string>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [newOrder, setNewOrder] = useState<NewOrderDraft>(() => createEmptyDraft());
  const [message, setMessage] = useState('');
  const [statusFilter, setStatusFilter] = useState<PurchaseStatus | 'all'>('pending');
  const isAdmin = profile.role === 'admin';
  const isViewer = profile.role === 'viewer';
  const assignedRecords = useMemo(
    () => records.filter((record) => record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()),
    [profile.email, records],
  );
  const visibleRecords = useMemo(
    () => statusFilter === 'all' ? assignedRecords : assignedRecords.filter((record) => record.status === statusFilter),
    [assignedRecords, statusFilter],
  );
  const imageUrlBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item.imageUrl])),
    [skuItems],
  );
  const skuBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item])),
    [skuItems],
  );
  const unconfirmedVisibleCount = visibleRecords.filter((record) => !record.isConfirmed && record.status === 'pending').length;

  const newCartonCount = parseNumber(newOrder.cartonCount);
  const newUnitsPerCarton = parseNumber(newOrder.unitsPerCarton);
  const newTailQuantity = parseNumber(newOrder.tailQuantity);
  const newQuantity = newCartonCount * newUnitsPerCarton + newTailQuantity;
  const newPrice = parseNumber(newOrder.purchasePrice);
  const newUnitCbm = parseNumber(newOrder.unitCbm);
  const newTotalAmount = round(newQuantity * newPrice, 2);
  const newTotalCbm = round(newQuantity * newUnitCbm, 4);

  function imageUrlFor(record: PurchaseRecord): string {
    return record.imageUrl || imageUrlBySku.get(record.sku.trim().toUpperCase()) || '';
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

  function draftKey(recordId: string, field: EditableField): string {
    return `${recordId}:${field}`;
  }

  function mixedKey(recordId: string, groupId: string, lineId: string, field: MixedLineField): string {
    return `${recordId}:${groupId}:${lineId}:${field}`;
  }

  function groupKey(recordId: string, groupId: string, field: 'groupName' | 'cartonCount'): string {
    return `${recordId}:${groupId}:${field}`;
  }

  function valueFor(record: PurchaseRecord, field: EditableField): string {
    const key = draftKey(record.id, field);
    if (key in drafts) return drafts[key];
    return String(record[field] ?? '');
  }

  function mixedValueFor(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField): string {
    const key = mixedKey(record.id, group.id, line.id, field);
    if (key in mixedDrafts) return mixedDrafts[key];
    return String(line[field] ?? '');
  }

  function groupValueFor(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount'): string {
    const key = groupKey(record.id, group.id, field);
    if (key in mixedDrafts) return mixedDrafts[key];
    return String(group[field] ?? '');
  }

  function patchNewOrder<K extends keyof NewOrderDraft>(field: K, value: NewOrderDraft[K]) {
    setNewOrder((current) => ({ ...current, [field]: value }));
  }

  function buildSkuFromNewRecord(record: PurchaseRecord): SkuItem {
    return hydrateSku({
      id: crypto.randomUUID(),
      manufacturerName: record.manufacturerName,
      sku: isNewSkuValue(record.sku) ? '' : record.sku,
      productName: record.productName,
      englishName: record.englishName,
      imageUrl: record.imageUrl,
      purchasePrice: record.purchasePrice,
      manualUnitCbm: record.unitCbm,
      totalCbm: 0,
      totalQuantity: 0,
      shopName: record.shopName,
      buyerName: record.assignedBuyerName,
      isSeasonal: false,
      cartonLengthCm: 0,
      cartonWidthCm: 0,
      cartonHeightCm: 0,
      unitsPerCarton: record.unitsPerCarton ?? 0,
      notes: record.note,
      cbmSource: 'missing',
      updatedAt: new Date().toISOString(),
    });
  }

  async function syncNewSkus(recordsToSync: PurchaseRecord[]): Promise<number> {
    const nextItemsByKey = new Map(skuItems.map((item) => [getSkuMatchKey(item) || item.id, item]));
    let changedCount = 0;

    for (const record of recordsToSync) {
      if (!isNewSkuValue(record.sku)) continue;
      const skuItem = buildSkuFromNewRecord(record);
      const matchKey = getSkuMatchKey(skuItem);
      if (!matchKey) continue;
      const existing = nextItemsByKey.get(matchKey);
      nextItemsByKey.set(matchKey, existing ? { ...skuItem, id: existing.id, updatedAt: new Date().toISOString() } : skuItem);
      changedCount += 1;
    }

    if (changedCount > 0) await onSkuChange(Array.from(nextItemsByKey.values()));
    return changedCount;
  }

  async function saveRecord(nextRecord: PurchaseRecord) {
    const normalized = withPurchaseTotals(nextRecord);
    await onChange(records.map((item) => (item.id === normalized.id ? normalized : item)));
  }

  async function addNewOrder() {
    if (isViewer) return;
    if (!profile.buyerName.trim()) {
      setMessage('请先在“账号采购人绑定”里填写采购人，再新增个人采购订单。');
      return;
    }

    const sku = newOrder.sku.trim() || 'NEW';
    if (isNewSkuValue(sku) && !newOrder.productName.trim() && !newOrder.englishName.trim()) {
      setMessage('新品 NEW 至少需要填写产品名称或英文名称。');
      return;
    }

    const record: PurchaseRecord = withPurchaseTotals({
      id: crypto.randomUUID(),
      manufacturerName: newOrder.manufacturerName.trim(),
      sku,
      productName: newOrder.productName.trim(),
      englishName: newOrder.englishName.trim(),
      imageUrl: newOrder.imageUrl.trim(),
      shopName: newOrder.shopName.trim(),
      buyerName: profile.buyerName.trim(),
      assignedBuyerName: profile.buyerName.trim(),
      assignedBuyerEmail: profile.email.trim(),
      isConfirmed: false,
      purchaseQuantity: newQuantity,
      confirmedPurchaseQuantity: null,
      purchasePrice: newPrice,
      totalAmount: newTotalAmount,
      purchaseDate: today(),
      estimatedArrivalDate: '',
      status: newOrder.status,
      unitCbm: newUnitCbm,
      totalCbm: newTotalCbm,
      loadingType: '整柜',
      containerDate: '',
      totalWeightKg: null,
      cartonCount: newOrder.cartonCount.trim() ? newCartonCount : null,
      unitsPerCarton: newOrder.unitsPerCarton.trim() ? newUnitsPerCarton : null,
      tailQuantity: newTailQuantity,
      isMixed: false,
      mixedGroups: [],
      logisticsTotalCbm: null,
      note: newOrder.note.trim(),
    });

    try {
      await onChange([record, ...records]);
      const syncedCount = await syncNewSkus([record]);
      setNewOrder(createEmptyDraft());
      setMessage(syncedCount > 0 ? '已新增采购订单，并同步新品到 SKU 资料库。' : '已新增采购订单。');
    } catch (error) {
      console.error(error);
      setMessage(`新增失败：${formatErrorMessage(error)}`);
    }
  }

  async function importOrders(file: File | undefined) {
    if (!file || isViewer) return;
    try {
      const imported = (await parsePurchaseRecordsFile(file, profile)).map(withPurchaseTotals);
      if (imported.length === 0) {
        setMessage('没有识别到可导入的采购订单。');
        return;
      }
      await onChange([...imported, ...records]);
      const syncedCount = await syncNewSkus(imported);
      setMessage(`已导入 ${imported.length} 条采购订单${syncedCount > 0 ? `，并同步 ${syncedCount} 条新品到 SKU 资料库` : ''}。`);
    } catch (error) {
      console.error(error);
      setMessage(`导入失败：${formatErrorMessage(error)}`);
    }
  }

  function patchRecord(record: PurchaseRecord, field: EditableField, value: string): PurchaseRecord {
    const next: PurchaseRecord = { ...record };
    if (field === 'purchaseQuantity' || field === 'confirmedPurchaseQuantity' || field === 'purchasePrice' || field === 'unitCbm' || field === 'cartonCount' || field === 'unitsPerCarton' || field === 'tailQuantity') {
      next[field] = parseNumber(value);
    } else if (field === 'status') {
      next.status = value as PurchaseStatus;
    } else {
      next[field] = value;
    }
    return withPurchaseTotals(next);
  }

  async function commit(record: PurchaseRecord, field: EditableField) {
    const key = draftKey(record.id, field);
    if (!(key in drafts)) return;
    const nextRecord = patchRecord(record, field, drafts[key]);
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await saveRecord(nextRecord);
      setMessage('已保存');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    }
  }

  function confirmedRecord(record: PurchaseRecord): PurchaseRecord {
    const normalized = withPurchaseTotals(recordWithSkuDefaults(record));
    return {
      ...normalized,
      isConfirmed: true,
      confirmedPurchaseQuantity: effectivePurchaseQuantity(normalized),
      status: normalized.status === 'pending' ? 'in_transit' : normalized.status,
    };
  }

  async function confirmVisiblePurchases() {
    if (isViewer) return;
    const visibleIds = new Set(visibleRecords.filter((record) => !record.isConfirmed && record.status === 'pending').map((record) => record.id));
    if (visibleIds.size === 0) return;
    try {
      await onChange(records.map((item) => (visibleIds.has(item.id) ? confirmedRecord(item) : item)));
      setMessage(`已确认 ${visibleIds.size} 条采购订单，采购 / 在途库存将按回传数据统计。`);
    } catch (error) {
      console.error(error);
      setMessage(`确认失败：${formatErrorMessage(error)}`);
    }
  }

  async function deleteRecord(recordId: string) {
    if (isViewer) return;
    try {
      await onChange(records.filter((record) => record.id !== recordId));
      setMessage('已删除采购订单。');
    } catch (error) {
      console.error(error);
      setMessage(`删除失败：${formatErrorMessage(error)}`);
    }
  }

  async function addMixedGroup(record: PurchaseRecord) {
    if (isViewer) return;
    const nextRecord = {
      ...record,
      isMixed: true,
      mixedGroups: [...record.mixedGroups, createMixedGroup(record.mixedGroups.length)],
    };
    await saveRecord(nextRecord);
    setExpandedRows((current) => new Set(current).add(record.id));
  }

  async function deleteMixedGroup(record: PurchaseRecord, groupId: string) {
    if (isViewer) return;
    const mixedGroups = record.mixedGroups.filter((group) => group.id !== groupId);
    await saveRecord({ ...record, mixedGroups, isMixed: mixedGroups.length > 0 });
  }

  async function addMixedLine(record: PurchaseRecord, groupId: string) {
    if (isViewer) return;
    await saveRecord({
      ...record,
      isMixed: true,
      mixedGroups: record.mixedGroups.map((group) => group.id === groupId ? { ...group, lines: [...group.lines, createMixedLine()] } : group),
    });
  }

  async function deleteMixedLine(record: PurchaseRecord, groupId: string, lineId: string) {
    if (isViewer) return;
    await saveRecord({
      ...record,
      mixedGroups: record.mixedGroups.map((group) => group.id === groupId ? { ...group, lines: group.lines.filter((line) => line.id !== lineId) } : group),
    });
  }

  async function commitGroup(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount') {
    const key = groupKey(record.id, group.id, field);
    if (!(key in mixedDrafts)) return;
    const value = mixedDrafts[key];
    const nextGroup = { ...group, [field]: field === 'cartonCount' ? parseNumber(value) : value };
    setMixedDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    await saveRecord({ ...record, mixedGroups: record.mixedGroups.map((item) => item.id === group.id ? nextGroup : item) });
  }

  async function commitLine(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField) {
    const key = mixedKey(record.id, group.id, line.id, field);
    if (!(key in mixedDrafts)) return;
    const value = mixedDrafts[key];
    let nextLine: MixedCartonLine = { ...line };
    if (field === 'quantity' || field === 'purchasePrice' || field === 'unitCbm') nextLine[field] = parseNumber(value);
    else nextLine[field] = value;
    if (field === 'sku') {
      const skuItem = skuBySku.get(value.trim().toUpperCase());
      if (skuItem) {
        nextLine = { ...nextLine, productName: skuItem.productName, purchasePrice: skuItem.purchasePrice, unitCbm: skuItem.unitCbm };
      }
    }
    nextLine = recalcMixedLine(nextLine);
    setMixedDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    await saveRecord({
      ...record,
      mixedGroups: record.mixedGroups.map((item) => item.id === group.id ? { ...group, lines: group.lines.map((current) => current.id === line.id ? nextLine : current) } : item),
    });
  }

  function toggleExpanded(recordId: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }

  function canEditField(field: EditableField): boolean {
    if (isViewer) return false;
    if (isAdmin) return true;
    return field !== 'sku' && field !== 'assignedBuyerName' && field !== 'assignedBuyerEmail';
  }

  function input(record: PurchaseRecord, field: EditableField, type = 'text') {
    if (!canEditField(field)) return <span>{String(record[field] ?? '')}</span>;
    if (field === 'status') {
      return (
        <select
          value={valueFor(record, field)}
          onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
          onBlur={() => void commit(record, field)}
        >
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      );
    }
    return (
      <input
        type={type}
        value={valueFor(record, field)}
        onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
        onBlur={() => void commit(record, field)}
      />
    );
  }

  function groupInput(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount', type = 'text') {
    if (isViewer) return <span>{String(group[field])}</span>;
    return (
      <input
        type={type}
        value={groupValueFor(record, group, field)}
        onChange={(event) => setMixedDrafts((current) => ({ ...current, [groupKey(record.id, group.id, field)]: event.target.value }))}
        onBlur={() => void commitGroup(record, group, field)}
      />
    );
  }

  function lineInput(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField, type = 'text') {
    if (isViewer) return <span>{String(line[field] ?? '')}</span>;
    return (
      <input
        type={type}
        value={mixedValueFor(record, group, line, field)}
        onChange={(event) => setMixedDrafts((current) => ({ ...current, [mixedKey(record.id, group.id, line.id, field)]: event.target.value }))}
        onBlur={() => void commitLine(record, group, line, field)}
      />
    );
  }

  function renderMixedPanel(record: PurchaseRecord) {
    const normalized = withPurchaseTotals(record);
    return (
      <tr className="packing-detail-row">
        <td colSpan={20}>
          <div className="packing-panel">
            <div className="packing-summary">
              <strong>主SKU数量：{purchaseQuantityForRecordSku(normalized)}</strong>
              <strong>其他SKU混装数量：{mixedQuantityForOtherSkus(normalized)}</strong>
              <strong>总件数：{packageCountFor(normalized)}</strong>
              {!isViewer && <button type="button" onClick={() => void addMixedGroup(normalized)}>新增混装组</button>}
            </div>
            {normalized.mixedGroups.length === 0 && <div className="empty">普通整箱不用填写这里；只有混装时新增混装组。</div>}
            {normalized.mixedGroups.map((group) => (
              <div className="mixed-group-card" key={group.id}>
                <div className="packing-summary">
                  <label>混装组{groupInput(normalized, group, 'groupName')}</label>
                  <label>件数{groupInput(normalized, group, 'cartonCount', 'number')}</label>
                  {!isViewer && <button type="button" onClick={() => void addMixedLine(normalized, group.id)}>添加SKU行</button>}
                  {!isViewer && <button className="danger" type="button" onClick={() => void deleteMixedGroup(normalized, group.id)}>删除混装组</button>}
                </div>
                <table className="packing-table">
                  <thead>
                    <tr><th>SKU</th><th>产品名称</th><th>数量</th><th>采购单价</th><th>单品CBM</th><th>金额</th><th>CBM</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {group.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{lineInput(normalized, group, line, 'sku')}</td>
                        <td>{lineInput(normalized, group, line, 'productName')}</td>
                        <td>{lineInput(normalized, group, line, 'quantity', 'number')}</td>
                        <td>{lineInput(normalized, group, line, 'purchasePrice', 'number')}</td>
                        <td>{lineInput(normalized, group, line, 'unitCbm', 'number')}</td>
                        <td>{line.totalAmount.toFixed(2)}</td>
                        <td>{line.totalCbm.toFixed(4)}</td>
                        <td>{!isViewer && <button className="danger" type="button" onClick={() => void deleteMixedLine(normalized, group.id, line.id)}>删除</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>我的采购订单</h2>
          <p>普通整箱只填整箱件数、每箱数量和尾箱数量；混装商品再单独新增混装组。</p>
        </div>
        <div className="export-actions">
          {!isViewer && (
            <label className="secondary-file-button">
              导入订单
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => {
                  void importOrders(event.target.files?.[0]);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          )}
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'xlsx', '我的采购订单')} disabled={visibleRecords.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'csv', '我的采购订单')} disabled={visibleRecords.length === 0}>导出 CSV</button>
          {!isViewer && <button className="primary" type="button" onClick={() => void confirmVisiblePurchases()} disabled={unconfirmedVisibleCount === 0}>确认采购</button>}
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}

      <div className="order-filter-bar">
        <label>
          状态筛选
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as PurchaseStatus | 'all')}>
            {statusFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span>当前 {visibleRecords.length} 条 / 我的订单 {assignedRecords.length} 条</span>
      </div>

      {!isViewer && (
        <div className="record-form">
          <label>厂家名<input value={newOrder.manufacturerName} onChange={(event) => patchNewOrder('manufacturerName', event.target.value)} /></label>
          <label>SKU<input value={newOrder.sku} onChange={(event) => patchNewOrder('sku', event.target.value)} /></label>
          <label>产品名称<input value={newOrder.productName} onChange={(event) => patchNewOrder('productName', event.target.value)} /></label>
          <label>英文名称<input value={newOrder.englishName} onChange={(event) => patchNewOrder('englishName', event.target.value)} /></label>
          <label>图片链接<input value={newOrder.imageUrl} onChange={(event) => patchNewOrder('imageUrl', event.target.value)} /></label>
          <label>店铺<input value={newOrder.shopName} onChange={(event) => patchNewOrder('shopName', event.target.value)} /></label>
          <label>采购人<input value={profile.buyerName} readOnly /></label>
          <label>整箱件数<input type="number" min="0" value={newOrder.cartonCount} onChange={(event) => patchNewOrder('cartonCount', event.target.value)} /></label>
          <label>每箱数量<input type="number" min="0" value={newOrder.unitsPerCarton} onChange={(event) => patchNewOrder('unitsPerCarton', event.target.value)} /></label>
          <label>尾箱数量<input type="number" min="0" value={newOrder.tailQuantity} onChange={(event) => patchNewOrder('tailQuantity', event.target.value)} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={newOrder.purchasePrice} onChange={(event) => patchNewOrder('purchasePrice', event.target.value)} /></label>
          <label>实际数量<input value={newQuantity} readOnly /></label>
          <label>总金额<input value={newTotalAmount.toFixed(2)} readOnly /></label>
          <label>单品CBM<input type="number" min="0" step="0.00000001" value={newOrder.unitCbm} onChange={(event) => patchNewOrder('unitCbm', event.target.value)} /></label>
          <label>总CBM<input value={newTotalCbm.toFixed(4)} readOnly /></label>
          <label>状态<select value={newOrder.status} onChange={(event) => patchNewOrder('status', event.target.value as PurchaseStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide">备注<input value={newOrder.note} onChange={(event) => patchNewOrder('note', event.target.value)} /></label>
          <div className="form-actions">
            <button className="primary" type="button" onClick={() => void addNewOrder()}>新增采购订单</button>
            <button type="button" onClick={() => setNewOrder(createEmptyDraft())}>清空</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>图片</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>计划采购数量</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th>采购单价</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.map((record) => {
              const normalized = withPurchaseTotals(recordWithSkuDefaults(record));
              return (
                <Fragment key={record.id}>
                  <tr>
                    <td>{imageUrlFor(record) ? <img className="sku-thumb" src={imageUrlFor(record)} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                    <td>{input(normalized, 'manufacturerName')}</td>
                    <td>{isAdmin ? input(normalized, 'sku') : normalized.sku}</td>
                    <td>{input(normalized, 'productName')}</td>
                    <td>{input(normalized, 'englishName')}</td>
                    <td>{input(normalized, 'shopName')}</td>
                    <td>{isAdmin ? input(normalized, 'assignedBuyerName') : normalized.assignedBuyerName}</td>
                    <td>{input(normalized, 'purchaseQuantity', 'number')}</td>
                    <td>{input(normalized, 'cartonCount', 'number')}</td>
                    <td>{input(normalized, 'unitsPerCarton', 'number')}</td>
                    <td>{input(normalized, 'tailQuantity', 'number')}</td>
                    <td>{packageCountFor(normalized)}</td>
                    <td>{purchaseQuantityForRecordSku(normalized)}</td>
                    <td>{normalized.isMixed ? '是' : '否'}</td>
                    <td>{input(normalized, 'purchasePrice', 'number')}</td>
                    <td>{normalized.totalAmount.toFixed(2)}</td>
                    <td>{input(normalized, 'unitCbm', 'number')}</td>
                    <td>{normalized.totalCbm.toFixed(4)}</td>
                    <td>{input(normalized, 'status')}</td>
                    <td>{input(normalized, 'note')}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => toggleExpanded(record.id)}>{expandedRows.has(record.id) ? '收起混装' : '混装'}</button>
                      {!isViewer && <button className="danger" type="button" onClick={() => void deleteRecord(record.id)}>删除</button>}
                    </td>
                  </tr>
                  {expandedRows.has(record.id) && renderMixedPanel(normalized)}
                </Fragment>
              );
            })}
            {visibleRecords.length === 0 && <tr><td className="empty" colSpan={21}>暂无分配给你的采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
