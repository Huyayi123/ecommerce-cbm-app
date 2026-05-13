import { useMemo, useState } from 'react';
import type { AppProfile, PurchaseRecord, PurchaseStatus } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { round } from '../utils/number';

type Props = {
  records: PurchaseRecord[];
  profile: AppProfile;
  onChange: (records: PurchaseRecord[]) => void | Promise<void>;
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

export function MyPurchaseOrdersPage({ records, profile, onChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const isAdmin = profile.role === 'admin';
  const isViewer = profile.role === 'viewer';
  const visibleRecords = useMemo(
    () => isAdmin ? records : records.filter((record) => record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()),
    [isAdmin, profile.email, records],
  );

  function draftKey(recordId: string, field: EditableField): string {
    return `${recordId}:${field}`;
  }

  function valueFor(record: PurchaseRecord, field: EditableField): string {
    const key = draftKey(record.id, field);
    if (key in drafts) return drafts[key];
    return String(record[field] ?? '');
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
          <p>{isAdmin ? '管理员可查看全部采购订单。' : '默认只显示分配给当前登录邮箱的采购订单。'}</p>
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}
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
