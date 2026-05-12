import type { ChangeEvent } from 'react';
import { useMemo, useState } from 'react';
import type { SkuItem } from '../types';
import { hydrateSku } from '../utils/calculations';
import { exportSkuItems } from '../utils/exporters';
import { parseSkuFile } from '../utils/fileParsers';

type DraftSku = Omit<SkuItem, 'cartonCbm' | 'unitCbm'>;

type Props = {
  items: SkuItem[];
  onChange: (items: SkuItem[]) => void;
  canEditData?: boolean;
  canDeleteData?: boolean;
};

const emptyDraft: DraftSku = {
  id: '',
  sku: '',
  productName: '',
  englishName: '',
  manufacturerName: '',
  shopName: '',
  buyerName: '',
  purchasePrice: 0,
  cartonLengthCm: 0,
  cartonWidthCm: 0,
  cartonHeightCm: 0,
  unitsPerCarton: 1,
  totalQuantity: 0,
  totalCbm: 0,
  note: '',
};

function toDraft(item: SkuItem): DraftSku {
  return {
    id: item.id,
    sku: item.sku,
    productName: item.productName,
    englishName: item.englishName,
    manufacturerName: item.manufacturerName,
    shopName: item.shopName,
    buyerName: item.buyerName,
    purchasePrice: item.purchasePrice,
    cartonLengthCm: item.cartonLengthCm,
    cartonWidthCm: item.cartonWidthCm,
    cartonHeightCm: item.cartonHeightCm,
    unitsPerCarton: item.unitsPerCarton,
    totalQuantity: item.totalQuantity,
    totalCbm: item.totalCbm,
    note: item.note,
  };
}

export function SkuManager({ items, onChange, canEditData = true, canDeleteData = true }: Props) {
  const [draft, setDraft] = useState<DraftSku>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState('');
  const calculated = useMemo(() => hydrateSku({ ...draft, id: draft.id || 'preview' }), [draft]);

  function updateField<K extends keyof DraftSku>(field: K, value: DraftSku[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function resetForm() {
    setDraft(emptyDraft);
    setEditingId(null);
  }

  function saveItem() {
    if (!canEditData || !draft.sku.trim()) return;
    const item = hydrateSku({
      ...draft,
      id: editingId ?? crypto.randomUUID(),
      sku: draft.sku.trim(),
    });

    if (editingId) {
      onChange(items.map((existing) => (existing.id === editingId ? item : existing)));
    } else {
      onChange([item, ...items]);
    }
    resetForm();
  }

  function editItem(item: SkuItem) {
    setDraft(toDraft(item));
    setEditingId(item.id);
  }

  function deleteItem(id: string) {
    if (!canDeleteData) return;
    onChange(items.filter((item) => item.id !== id));
    if (editingId === id) resetForm();
  }

  async function importSkuItems(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !canEditData) return;

    const importedItems = await parseSkuFile(file);
    const existingBySku = new Map(items.map((item) => [item.sku.trim().toUpperCase(), item]));
    let updatedCount = 0;
    let createdCount = 0;

    const mergedBySku = new Map(items.map((item) => [item.sku.trim().toUpperCase(), item]));
    for (const importedItem of importedItems) {
      const key = importedItem.sku.trim().toUpperCase();
      const existing = existingBySku.get(key);
      if (existing) {
        updatedCount += 1;
        mergedBySku.set(key, { ...importedItem, id: existing.id });
      } else {
        createdCount += 1;
        mergedBySku.set(key, importedItem);
      }
    }

    onChange(Array.from(mergedBySku.values()));
    setImportMessage(`已导入 ${importedItems.length} 条，新增 ${createdCount} 条，覆盖 ${updatedCount} 条`);
    event.target.value = '';
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>SKU 体积资料库</h2>
          <p>数据保存在 Supabase 云端，单箱体积和单品体积自动计算。</p>
        </div>
        <div className="export-actions">
          {canEditData && <label className="secondary-file-button">
            导入资料库
            <input type="file" accept=".xlsx,.xls,.csv" onChange={importSkuItems} />
          </label>}
          <button type="button" onClick={() => exportSkuItems(items, 'xlsx')} disabled={items.length === 0}>导出资料库 Excel</button>
          <button type="button" onClick={() => exportSkuItems(items, 'csv')} disabled={items.length === 0}>导出资料库 CSV</button>
        </div>
      </div>
      {importMessage && <div className="inline-notice">{importMessage}</div>}

      <div className="sku-form">
        <label>
          SKU
          <input value={draft.sku} onChange={(event) => updateField('sku', event.target.value)} placeholder="例如 SKU-1001" />
        </label>
        <label>
          产品名称
          <input value={draft.productName} onChange={(event) => updateField('productName', event.target.value)} />
        </label>
        <label>
          英文名
          <input value={draft.englishName} onChange={(event) => updateField('englishName', event.target.value)} />
        </label>
        <label>
          厂家名
          <input value={draft.manufacturerName} onChange={(event) => updateField('manufacturerName', event.target.value)} />
        </label>
        <label>
          店铺
          <input value={draft.shopName} onChange={(event) => updateField('shopName', event.target.value)} />
        </label>
        <label>
          采购人
          <input value={draft.buyerName} onChange={(event) => updateField('buyerName', event.target.value)} />
        </label>
        <label>
          采购单价
          <input type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={(event) => updateField('purchasePrice', Number(event.target.value))} />
        </label>
        <label>
          长 cm
          <input type="number" min="0" value={draft.cartonLengthCm} onChange={(event) => updateField('cartonLengthCm', Number(event.target.value))} />
        </label>
        <label>
          宽 cm
          <input type="number" min="0" value={draft.cartonWidthCm} onChange={(event) => updateField('cartonWidthCm', Number(event.target.value))} />
        </label>
        <label>
          高 cm
          <input type="number" min="0" value={draft.cartonHeightCm} onChange={(event) => updateField('cartonHeightCm', Number(event.target.value))} />
        </label>
        <label>
          每箱数量
          <input type="number" min="0" value={draft.unitsPerCarton} onChange={(event) => updateField('unitsPerCarton', Number(event.target.value))} />
        </label>
        <label>
          总数量
          <input type="number" min="0" value={draft.totalQuantity} onChange={(event) => updateField('totalQuantity', Number(event.target.value))} />
        </label>
        <label>
          总立方 CBM
          <input type="number" min="0" step="0.0001" value={draft.totalCbm} onChange={(event) => updateField('totalCbm', Number(event.target.value))} />
        </label>
        <label className="wide">
          备注
          <input value={draft.note} onChange={(event) => updateField('note', event.target.value)} />
        </label>
        <div className="computed wide">
          <span>单箱体积：{calculated.cartonCbm.toFixed(6)} CBM</span>
          <span>单个产品体积：{calculated.unitCbm.toFixed(8)} CBM</span>
        </div>
        {canEditData && <div className="form-actions">
          <button className="primary" type="button" onClick={saveItem} disabled={!draft.sku.trim()}>
            {editingId ? '保存修改' : '新增 SKU'}
          </button>
          <button type="button" onClick={resetForm}>清空</button>
        </div>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>厂家名</th>
              <th>SKU</th>
              <th>产品名称</th>
              <th>英文名</th>
              <th>店铺</th>
              <th>采购人</th>
              <th>采购单价</th>
              <th>尺寸 cm</th>
              <th>每箱数量</th>
              <th>总数量</th>
              <th>总立方</th>
              <th>单箱 CBM</th>
              <th>单品 CBM</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.manufacturerName}</td>
                <td>{item.sku}</td>
                <td>{item.productName}</td>
                <td>{item.englishName}</td>
                <td>{item.shopName}</td>
                <td>{item.buyerName}</td>
                <td>{item.purchasePrice}</td>
                <td>{item.cartonLengthCm} x {item.cartonWidthCm} x {item.cartonHeightCm}</td>
                <td>{item.unitsPerCarton}</td>
                <td>{item.totalQuantity || '-'}</td>
                <td>{item.totalCbm ? item.totalCbm.toFixed(4) : '-'}</td>
                <td>{item.cartonCbm.toFixed(6)}</td>
                <td>{item.unitCbm.toFixed(8)}</td>
                <td>{item.note}</td>
                <td className="row-actions">
                  {canEditData && <button type="button" onClick={() => editItem(item)}>编辑</button>}
                  {canDeleteData && <button type="button" className="danger" onClick={() => deleteItem(item.id)}>删除</button>}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={15} className="empty">暂无 SKU 资料，请先新增或载入示例数据。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
