import { useMemo, useState } from 'react';
import type { AppProfile, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { getSkuMatchKey, hydrateSku } from '../utils/calculations';
import { formatErrorMessage } from '../utils/errors';
import { exportPurchaseRecords } from '../utils/exporters';
import { parsePurchaseRecordsFile } from '../utils/fileParsers';
import { round } from '../utils/number';

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
  shopName: string;
  purchaseQuantity: string;
  purchasePrice: string;
  unitCbm: string;
  status: PurchaseStatus;
  note: string;
};

const statusLabels: Record<PurchaseStatus, string> = {
  pending: '待采购',
  ordered: '已下单',
  in_transit: '海运在途',
  arrived: '已到货',
  cancelled: '已取消',
};

const editableFields = [
  'manufacturerName',
  'sku',
  'productName',
  'englishName',
  'shopName',
  'assignedBuyerName',
  'assignedBuyerEmail',
  'purchaseQuantity',
  'purchasePrice',
  'totalAmount',
  'unitCbm',
  'totalCbm',
  'status',
  'note',
] as const;

type EditableField = (typeof editableFields)[number];

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
    shopName: '',
    purchaseQuantity: '',
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

function patchRecord(record: PurchaseRecord, field: EditableField, value: string): PurchaseRecord {
  const next: PurchaseRecord = { ...record };

  if (field === 'purchaseQuantity' || field === 'purchasePrice' || field === 'unitCbm' || field === 'totalAmount' || field === 'totalCbm') {
    next[field] = parseNumber(value);
  } else if (field === 'status') {
    next.status = value as PurchaseStatus;
  } else {
    next[field] = value;
  }

  if (field === 'purchaseQuantity' || field === 'purchasePrice' || field === 'unitCbm') {
    next.totalAmount = round(next.purchaseQuantity * next.purchasePrice, 2);
    next.totalCbm = round(next.purchaseQuantity * next.unitCbm, 4);
  }

  return next;
}

export function MyPurchaseOrdersPage({ records, skuItems, profile, onChange, onSkuChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newOrder, setNewOrder] = useState<NewOrderDraft>(() => createEmptyDraft());
  const [message, setMessage] = useState('');
  const isAdmin = profile.role === 'admin';
  const isViewer = profile.role === 'viewer';
  const visibleRecords = useMemo(
    () => records.filter((record) => record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()),
    [profile.email, records],
  );

  const newQuantity = parseNumber(newOrder.purchaseQuantity);
  const newPrice = parseNumber(newOrder.purchasePrice);
  const newUnitCbm = parseNumber(newOrder.unitCbm);
  const newTotalAmount = round(newQuantity * newPrice, 2);
  const newTotalCbm = round(newQuantity * newUnitCbm, 4);

  function draftKey(recordId: string, field: EditableField): string {
    return `${recordId}:${field}`;
  }

  function valueFor(record: PurchaseRecord, field: EditableField): string {
    const key = draftKey(record.id, field);
    if (key in drafts) return drafts[key];
    return String(record[field] ?? '');
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
      purchasePrice: record.purchasePrice,
      manualUnitCbm: record.unitCbm,
      totalCbm: 0,
      totalQuantity: 0,
      shopName: record.shopName,
      buyerName: record.assignedBuyerName,
      cartonLengthCm: 0,
      cartonWidthCm: 0,
      cartonHeightCm: 0,
      unitsPerCarton: 0,
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

    if (changedCount > 0) {
      await onSkuChange(Array.from(nextItemsByKey.values()));
    }
    return changedCount;
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

    const record: PurchaseRecord = {
      id: crypto.randomUUID(),
      manufacturerName: newOrder.manufacturerName.trim(),
      sku,
      productName: newOrder.productName.trim(),
      englishName: newOrder.englishName.trim(),
      shopName: newOrder.shopName.trim(),
      buyerName: profile.buyerName.trim(),
      assignedBuyerName: profile.buyerName.trim(),
      assignedBuyerEmail: profile.email.trim(),
      purchaseQuantity: newQuantity,
      purchasePrice: newPrice,
      totalAmount: newTotalAmount,
      purchaseDate: today(),
      estimatedArrivalDate: '',
      status: newOrder.status,
      unitCbm: newUnitCbm,
      totalCbm: newTotalCbm,
      note: newOrder.note.trim(),
    };

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
      const imported = await parsePurchaseRecordsFile(file, profile);
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

  async function commit(record: PurchaseRecord, field: EditableField) {
    const key = draftKey(record.id, field);
    if (!(key in drafts)) return;
    const value = drafts[key];
    const nextRecord = patchRecord(record, field, value);
    const nextRecords = records.map((item) => (item.id === record.id ? nextRecord : item));
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await onChange(nextRecords);
      setMessage('已保存');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    }
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

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>我的采购订单</h2>
          <p>只显示分配给当前登录邮箱的采购订单。</p>
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
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}

      {!isViewer && (
        <div className="record-form">
          <label>厂家名<input value={newOrder.manufacturerName} onChange={(event) => patchNewOrder('manufacturerName', event.target.value)} /></label>
          <label>SKU<input value={newOrder.sku} onChange={(event) => patchNewOrder('sku', event.target.value)} /></label>
          <label>产品名称<input value={newOrder.productName} onChange={(event) => patchNewOrder('productName', event.target.value)} /></label>
          <label>英文名称<input value={newOrder.englishName} onChange={(event) => patchNewOrder('englishName', event.target.value)} /></label>
          <label>店铺<input value={newOrder.shopName} onChange={(event) => patchNewOrder('shopName', event.target.value)} /></label>
          <label>采购人<input value={profile.buyerName} readOnly /></label>
          <label>采购人邮箱<input value={profile.email} readOnly /></label>
          <label>采购数量<input type="number" min="0" value={newOrder.purchaseQuantity} onChange={(event) => patchNewOrder('purchaseQuantity', event.target.value)} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={newOrder.purchasePrice} onChange={(event) => patchNewOrder('purchasePrice', event.target.value)} /></label>
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
              <th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>采购人邮箱</th><th>采购数量</th><th>采购单价</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>备注</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.map((record) => (
              <tr key={record.id}>
                <td>{input(record, 'manufacturerName')}</td>
                <td>{isAdmin ? input(record, 'sku') : record.sku}</td>
                <td>{input(record, 'productName')}</td>
                <td>{input(record, 'englishName')}</td>
                <td>{input(record, 'shopName')}</td>
                <td>{isAdmin ? input(record, 'assignedBuyerName') : record.assignedBuyerName}</td>
                <td>{isAdmin ? input(record, 'assignedBuyerEmail') : record.assignedBuyerEmail}</td>
                <td>{input(record, 'purchaseQuantity', 'number')}</td>
                <td>{input(record, 'purchasePrice', 'number')}</td>
                <td>{input(record, 'totalAmount', 'number')}</td>
                <td>{input(record, 'unitCbm', 'number')}</td>
                <td>{input(record, 'totalCbm', 'number')}</td>
                <td>{input(record, 'status')}</td>
                <td>{input(record, 'note')}</td>
              </tr>
            ))}
            {visibleRecords.length === 0 && <tr><td className="empty" colSpan={14}>暂无分配给你的采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
