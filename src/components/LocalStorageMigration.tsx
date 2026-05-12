import { useState } from 'react';
import type { PurchaseRecord, PurchaseRow, SkuItem, UserRole } from '../types';
import { canImport } from '../utils/permissions';
import { loadPurchaseRecords, loadPurchaseRows, loadSkuItems } from '../utils/storage';

type Props = {
  role: UserRole;
  onImport: (payload: { skuItems: SkuItem[]; purchaseRecords: PurchaseRecord[]; purchaseRows: PurchaseRow[] }) => Promise<void>;
};

export function LocalStorageMigration({ role, onImport }: Props) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function migrate() {
    setLoading(true);
    const skuItems = loadSkuItems();
    const purchaseRecords = loadPurchaseRecords();
    const purchaseRows = loadPurchaseRows();
    await onImport({ skuItems, purchaseRecords, purchaseRows });
    setMessage(`已导入本机数据：SKU ${skuItems.length} 条，采购记录 ${purchaseRecords.length} 条，装柜临时行 ${purchaseRows.length} 条`);
    setLoading(false);
  }

  if (!canImport(role)) return null;

  return (
    <section className="panel compact-panel">
      <div className="section-heading">
        <div>
          <h2>本机数据迁移</h2>
          <p>把旧版本保存在 localStorage 的数据导入 Supabase 云端。</p>
        </div>
        <button type="button" onClick={migrate} disabled={loading}>{loading ? '导入中...' : '导入本机旧数据'}</button>
      </div>
      {message && <div className="inline-notice">{message}</div>}
    </section>
  );
}
