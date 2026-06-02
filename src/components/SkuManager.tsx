import { Fragment, type ChangeEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { SkuImportPreview, SkuItem } from '../types';
import { findMatchingSkuItem, getSkuMatchKey, hydrateSku } from '../utils/calculations';
import { formatErrorMessage } from '../utils/errors';
import { exportSkuImportTemplate, exportSkuItems } from '../utils/exporters';
import { previewSkuFile } from '../utils/fileParsers';

type DraftSku = Omit<SkuItem, 'cartonCbm' | 'unitCbm'>;
type ColumnKey =
  | 'imageUrl'
  | 'manufacturerName'
  | 'sku'
  | 'productName'
  | 'englishName'
  | 'purchasePrice'
  | 'unitCbm'
  | 'totalCbm'
  | 'totalQuantity'
  | 'shopName'
  | 'buyerName'
  | 'isSeasonal'
  | 'cartonLengthCm'
  | 'cartonWidthCm'
  | 'cartonHeightCm'
  | 'unitsPerCarton';

type Props = {
  items: SkuItem[];
  onChange: (items: SkuItem[]) => void | Promise<void>;
  canEditData?: boolean;
  canDeleteData?: boolean;
};

const columnOptions: Array<{ key: ColumnKey; label: string }> = [
  { key: 'imageUrl', label: '图片' },
  { key: 'manufacturerName', label: '厂家名' },
  { key: 'sku', label: 'SKU' },
  { key: 'productName', label: '产品名称' },
  { key: 'englishName', label: '英文名称' },
  { key: 'purchasePrice', label: '采购单价' },
  { key: 'unitCbm', label: '单品CBM' },
  { key: 'totalCbm', label: '总CBM' },
  { key: 'totalQuantity', label: '总数量' },
  { key: 'shopName', label: '店铺' },
  { key: 'buyerName', label: '采购人' },
  { key: 'isSeasonal', label: '季节性产品' },
  { key: 'cartonLengthCm', label: '长cm' },
  { key: 'cartonWidthCm', label: '宽cm' },
  { key: 'cartonHeightCm', label: '高cm' },
  { key: 'unitsPerCarton', label: '每箱数量' },
];

const defaultVisibleColumns = new Set<ColumnKey>([
  'imageUrl',
  'manufacturerName',
  'sku',
  'productName',
  'purchasePrice',
  'unitCbm',
  'shopName',
  'buyerName',
  'isSeasonal',
]);

const SKU_PAGE_SIZE_OPTIONS = [50, 100, 200];

const emptyDraft: DraftSku = {
  id: '',
  sku: '',
  productName: '',
  englishName: '',
  imageUrl: '',
  manufacturerName: '',
  shopName: '',
  buyerName: '',
  isSeasonal: false,
  purchasePrice: 0,
  cartonLengthCm: 0,
  cartonWidthCm: 0,
  cartonHeightCm: 0,
  unitsPerCarton: 1,
  totalQuantity: 0,
  totalCbm: 0,
  manualUnitCbm: 0,
  notes: '',
  cbmSource: 'missing',
  updatedAt: '',
};

function toDraft(item: SkuItem): DraftSku {
  return {
    id: item.id,
    sku: item.sku,
    productName: item.productName,
    englishName: item.englishName,
    imageUrl: item.imageUrl,
    manufacturerName: item.manufacturerName,
    shopName: item.shopName,
    buyerName: item.buyerName,
    isSeasonal: item.isSeasonal,
    purchasePrice: item.purchasePrice,
    cartonLengthCm: item.cartonLengthCm,
    cartonWidthCm: item.cartonWidthCm,
    cartonHeightCm: item.cartonHeightCm,
    unitsPerCarton: item.unitsPerCarton,
    totalQuantity: item.totalQuantity,
    totalCbm: item.totalCbm,
    manualUnitCbm: item.manualUnitCbm,
    notes: item.notes,
    cbmSource: item.cbmSource,
    updatedAt: item.updatedAt,
  };
}

function sourceLabel(source: SkuItem['cbmSource']): string {
  return source === 'imported' ? '导入单品CBM' : source === 'total' ? '总CBM/总数量' : source === 'carton' ? '长宽高计算' : '缺失';
}

export function SkuManager({ items, onChange, canEditData = true, canDeleteData = true }: Props) {
  const [draft, setDraft] = useState<DraftSku>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState('');
  const [importPreview, setImportPreview] = useState<SkuImportPreview | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(defaultVisibleColumns);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const calculated = useMemo(() => hydrateSku({ ...draft, id: draft.id || 'preview' }), [draft]);
  const shopOptions = useMemo(
    () => Array.from(new Set(items.map((item) => item.shopName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const filteredItems = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    const shopMatchedItems = shopFilter ? items.filter((item) => item.shopName === shopFilter) : items;
    if (!keyword) return shopMatchedItems;
    return shopMatchedItems.filter((item) =>
      [item.manufacturerName, item.sku, item.productName, item.englishName, item.shopName, item.buyerName, item.isSeasonal ? '季节性产品' : '']
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [items, searchText, shopFilter]);
  const totalPages = Math.max(Math.ceil(filteredItems.length / pageSize), 1);
  const pagedItems = useMemo(
    () => filteredItems.slice((page - 1) * pageSize, page * pageSize),
    [filteredItems, page, pageSize],
  );

  useEffect(() => {
    setPage(1);
  }, [searchText, shopFilter, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function updateField<K extends keyof DraftSku>(field: K, value: DraftSku[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function resetForm() {
    setDraft(emptyDraft);
    setEditingId(null);
  }

  async function saveItem() {
    if (!canEditData || (!draft.sku.trim() && !draft.productName.trim() && !draft.englishName.trim())) return;
    const item = hydrateSku({
      ...draft,
      id: editingId ?? crypto.randomUUID(),
      sku: draft.sku.trim(),
      updatedAt: new Date().toISOString(),
    });

    try {
      if (editingId) {
        await onChange(items.map((existing) => (existing.id === editingId ? item : existing)));
      } else {
        const existing = findMatchingSkuItem(item, items);
        await onChange(existing
          ? items.map((current) => (current.id === existing.id ? { ...item, id: existing.id } : current))
          : [item, ...items]);
      }
      setImportMessage(editingId ? 'SKU 已保存' : 'SKU 已新增');
      resetForm();
    } catch (error) {
      console.error(error);
      setImportMessage(`保存失败：${formatErrorMessage(error)}`);
    }
  }

  function editItem(item: SkuItem) {
    setDraft(toDraft(item));
    setEditingId(item.id);
  }

  async function deleteItem(id: string) {
    if (!canDeleteData) return;
    try {
      await onChange(items.filter((item) => item.id !== id));
      if (editingId === id) resetForm();
      setImportMessage('SKU 已删除');
    } catch (error) {
      console.error(error);
      setImportMessage(`删除失败：${formatErrorMessage(error)}`);
    }
  }

  async function previewImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !canEditData) return;
    setImportPreview(await previewSkuFile(file, items));
    event.target.value = '';
  }

  async function confirmImport() {
    if (!importPreview) return;
    const mergedByKey = new Map(items.map((item) => [getSkuMatchKey(item) || item.id, item]));
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    for (const row of importPreview.rows) {
      if (!row.item) {
        failedCount += 1;
        continue;
      }
      const existing = findMatchingSkuItem(row.item, Array.from(mergedByKey.values()));
      const key = getSkuMatchKey(row.item) || row.item.id;
      if (existing) {
        updatedCount += 1;
        const existingKey = getSkuMatchKey(existing) || existing.id;
        mergedByKey.delete(existingKey);
        mergedByKey.set(key, { ...row.item, id: existing.id, updatedAt: new Date().toISOString() });
      } else {
        createdCount += 1;
        mergedByKey.set(key, { ...row.item, updatedAt: new Date().toISOString() });
      }
    }

    try {
      await onChange(Array.from(mergedByKey.values()));
      setImportMessage(`导入完成：新增 ${createdCount} 条，更新 ${updatedCount} 条，失败 ${failedCount} 条`);
      setImportPreview(null);
    } catch (error) {
      console.error(error);
      setImportMessage(`导入失败：${formatErrorMessage(error)}`);
    }
  }

  function toggleColumn(key: ColumnKey) {
    setVisibleColumns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>SKU 体积资料库</h2>
          <p>导入按表头名称匹配字段，表头顺序可任意变化。</p>
        </div>
        <div className="export-actions">
          {canEditData && <label className="secondary-file-button">
            导入资料库
            <input type="file" accept=".xlsx,.xls,.csv" onChange={previewImport} />
          </label>}
          <button type="button" onClick={exportSkuImportTemplate}>下载导入模板</button>
          <button type="button" onClick={() => exportSkuItems(items, 'xlsx')} disabled={items.length === 0}>导出资料库 Excel</button>
          <button type="button" onClick={() => exportSkuItems(items, 'csv')} disabled={items.length === 0}>导出资料库 CSV</button>
        </div>
      </div>

      {importMessage && <div className="inline-notice">{importMessage}</div>}

      {importPreview && (
        <div className="import-preview">
          <div className="section-heading">
            <div>
              <h2>导入预览：{importPreview.fileName}</h2>
              <p>请确认识别字段和失败原因，确认后才会写入 SKU 资料库。</p>
            </div>
            <div className="export-actions">
              <button className="primary" type="button" onClick={confirmImport} disabled={importPreview.missingRequiredFields.length > 0}>确认导入</button>
              <button type="button" onClick={() => setImportPreview(null)}>取消</button>
            </div>
          </div>
          <div className="preview-grid">
            <div><strong>识别字段</strong><p>{importPreview.recognizedFields.map((item) => `${item.field}=${item.header}`).join('；') || '-'}</p></div>
            <div><strong>未识别字段</strong><p>{importPreview.unrecognizedHeaders.join('；') || '-'}</p></div>
            <div><strong>缺少字段</strong><p>{importPreview.missingRequiredFields.join('；') || '-'}</p></div>
            <div><strong>导入结果</strong><p>新增 {importPreview.rows.filter((row) => row.action === 'create').length}，更新 {importPreview.rows.filter((row) => row.action === 'update').length}，失败 {importPreview.rows.filter((row) => row.action === 'fail').length}</p></div>
          </div>
          <div className="table-wrap small-table">
            <table>
              <thead><tr><th>行号</th><th>动作</th><th>SKU</th><th>产品名称</th><th>单品CBM</th><th>失败原因</th></tr></thead>
              <tbody>
                {importPreview.rows.slice(0, 80).map((row) => (
                  <tr key={row.rowNumber} className={row.action === 'fail' ? 'error-row' : ''}>
                    <td>{row.rowNumber}</td>
                    <td>{row.action === 'create' ? '新增' : row.action === 'update' ? '更新' : '失败'}</td>
                    <td>{row.item?.sku ?? '-'}</td>
                    <td>{row.item?.productName ?? '-'}</td>
                    <td>{row.item?.unitCbm.toFixed(8) ?? '-'}</td>
                    <td>{row.errors.join('；') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="sku-form">
        <label>SKU<input value={draft.sku} onChange={(event) => updateField('sku', event.target.value)} placeholder="例如 SKU-1001" /></label>
        <label>产品名称<input value={draft.productName} onChange={(event) => updateField('productName', event.target.value)} /></label>
        <label>英文名称<input value={draft.englishName} onChange={(event) => updateField('englishName', event.target.value)} /></label>
        <label>图片链接<input value={draft.imageUrl} onChange={(event) => updateField('imageUrl', event.target.value)} /></label>
        <label>厂家名<input value={draft.manufacturerName} onChange={(event) => updateField('manufacturerName', event.target.value)} /></label>
        <label>采购单价<input type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={(event) => updateField('purchasePrice', Number(event.target.value))} /></label>
        <label>单品CBM<input type="number" min="0" step="0.00000001" value={draft.manualUnitCbm} onChange={(event) => updateField('manualUnitCbm', Number(event.target.value))} /></label>
        <label>总CBM<input type="number" min="0" step="0.0001" value={draft.totalCbm} onChange={(event) => updateField('totalCbm', Number(event.target.value))} /></label>
        <label>总数量<input type="number" min="0" value={draft.totalQuantity} onChange={(event) => updateField('totalQuantity', Number(event.target.value))} /></label>
        <label>店铺<input value={draft.shopName} onChange={(event) => updateField('shopName', event.target.value)} /></label>
        <label>采购人<input value={draft.buyerName} onChange={(event) => updateField('buyerName', event.target.value)} /></label>
        <label className="checkbox-field"><input type="checkbox" checked={draft.isSeasonal} onChange={(event) => updateField('isSeasonal', event.target.checked)} />季节性产品</label>
        <label>长cm<input type="number" min="0" value={draft.cartonLengthCm} onChange={(event) => updateField('cartonLengthCm', Number(event.target.value))} /></label>
        <label>宽cm<input type="number" min="0" value={draft.cartonWidthCm} onChange={(event) => updateField('cartonWidthCm', Number(event.target.value))} /></label>
        <label>高cm<input type="number" min="0" value={draft.cartonHeightCm} onChange={(event) => updateField('cartonHeightCm', Number(event.target.value))} /></label>
        <label>每箱数量<input type="number" min="0" value={draft.unitsPerCarton} onChange={(event) => updateField('unitsPerCarton', Number(event.target.value))} /></label>
        <div className="computed wide">
          <span>长宽高CBM：{calculated.cartonCbm.toFixed(8)} CBM</span>
          <span>单品体积：{calculated.unitCbm.toFixed(8)} CBM</span>
          <span>来源：{sourceLabel(calculated.cbmSource)}</span>
        </div>
        {canEditData && <div className="form-actions">
          <button className="primary" type="button" onClick={saveItem} disabled={!draft.sku.trim() && !draft.productName.trim() && !draft.englishName.trim()}>{editingId ? '保存修改' : '新增 SKU'}</button>
          <button type="button" onClick={resetForm}>清空</button>
        </div>}
      </div>

      <div className="column-settings">
        <strong>列显示设置</strong>
        {columnOptions.map((column) => (
          <label key={column.key}>
            <input type="checkbox" checked={visibleColumns.has(column.key)} onChange={() => toggleColumn(column.key)} />
            {column.label}
          </label>
        ))}
      </div>

      <div className="sku-search">
        <label>
          店铺筛选
          <select value={shopFilter} onChange={(event) => setShopFilter(event.target.value)}>
            <option value="">全部店铺</option>
            {shopOptions.map((shop) => <option key={shop} value={shop}>{shop}</option>)}
          </select>
        </label>
        <label>
          搜索资料库
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索 SKU、产品名称、英文名称、厂家名、店铺、采购人"
          />
        </label>
        <label>
          每页
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {SKU_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}
          </select>
        </label>
        <span>共 {filteredItems.length} / {items.length} 条，第 {page} / {totalPages} 页</span>
        <div className="pagination-actions">
          <button type="button" onClick={() => setPage((current) => Math.max(current - 1, 1))} disabled={page <= 1}>上一页</button>
          <button type="button" onClick={() => setPage((current) => Math.min(current + 1, totalPages))} disabled={page >= totalPages}>下一页</button>
        </div>
      </div>

      <div className="table-wrap sku-table-wrap">
        <table className="sku-table">
          <thead>
            <tr>
              {visibleColumns.has('imageUrl') && <th className="sticky-col sticky-col-1">图片</th>}
              {visibleColumns.has('manufacturerName') && <th className="sticky-col sticky-col-2">厂家名</th>}
              {visibleColumns.has('sku') && <th className="sticky-col sticky-col-3">SKU</th>}
              {visibleColumns.has('productName') && <th className="sticky-col sticky-col-4">产品名称</th>}
              {visibleColumns.has('englishName') && <th>英文名称</th>}
              {visibleColumns.has('purchasePrice') && <th>采购单价</th>}
              {visibleColumns.has('unitCbm') && <th>单品CBM</th>}
              {visibleColumns.has('totalCbm') && <th>总CBM</th>}
              {visibleColumns.has('totalQuantity') && <th>总数量</th>}
              {visibleColumns.has('shopName') && <th>店铺</th>}
              {visibleColumns.has('buyerName') && <th>采购人</th>}
              {visibleColumns.has('isSeasonal') && <th>季节性产品</th>}
              {visibleColumns.has('cartonLengthCm') && <th>长cm</th>}
              {visibleColumns.has('cartonWidthCm') && <th>宽cm</th>}
              {visibleColumns.has('cartonHeightCm') && <th>高cm</th>}
              {visibleColumns.has('unitsPerCarton') && <th>每箱数量</th>}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pagedItems.map((item) => (
              <Fragment key={item.id}>
                <tr>
                  {visibleColumns.has('imageUrl') && <td className="sticky-col sticky-col-1">{item.imageUrl ? <img className="sku-thumb" src={item.imageUrl} alt={item.productName || item.sku || 'SKU'} loading="lazy" /> : '-'}</td>}
                  {visibleColumns.has('manufacturerName') && <td className="sticky-col sticky-col-2">{item.manufacturerName}</td>}
                  {visibleColumns.has('sku') && <td className="sticky-col sticky-col-3">{item.sku}</td>}
                  {visibleColumns.has('productName') && <td className="sticky-col sticky-col-4">{item.productName}</td>}
                  {visibleColumns.has('englishName') && <td>{item.englishName}</td>}
                  {visibleColumns.has('purchasePrice') && <td>{item.purchasePrice}</td>}
                  {visibleColumns.has('unitCbm') && <td>{item.unitCbm.toFixed(8)}</td>}
                  {visibleColumns.has('totalCbm') && <td>{item.totalCbm || '-'}</td>}
                  {visibleColumns.has('totalQuantity') && <td>{item.totalQuantity || '-'}</td>}
                  {visibleColumns.has('shopName') && <td>{item.shopName}</td>}
                  {visibleColumns.has('buyerName') && <td>{item.buyerName}</td>}
                  {visibleColumns.has('isSeasonal') && <td>{item.isSeasonal ? '是' : '-'}</td>}
                  {visibleColumns.has('cartonLengthCm') && <td>{item.cartonLengthCm || '-'}</td>}
                  {visibleColumns.has('cartonWidthCm') && <td>{item.cartonWidthCm || '-'}</td>}
                  {visibleColumns.has('cartonHeightCm') && <td>{item.cartonHeightCm || '-'}</td>}
                  {visibleColumns.has('unitsPerCarton') && <td>{item.unitsPerCarton}</td>}
                  <td className="row-actions">
                    <button type="button" onClick={() => toggleExpanded(item.id)}>{expandedIds.has(item.id) ? '收起' : '展开详情'}</button>
                    {canEditData && <button type="button" onClick={() => editItem(item)}>编辑</button>}
                    {canDeleteData && <button type="button" className="danger" onClick={() => deleteItem(item.id)}>删除</button>}
                  </td>
                </tr>
                {expandedIds.has(item.id) && (
                  <tr key={`${item.id}-detail`}>
                    <td colSpan={16} className="detail-row">
                      <div className="detail-grid">
                        <span>英文名称：{item.englishName || '-'}</span>
                        <span>图片链接：{item.imageUrl || '-'}</span>
                        <span>总CBM：{item.totalCbm || '-'}</span>
                        <span>总数量：{item.totalQuantity || '-'}</span>
                        <span>长宽高：{item.cartonLengthCm} x {item.cartonWidthCm} x {item.cartonHeightCm}</span>
                        <span>每箱数量：{item.unitsPerCarton}</span>
                        <span>长宽高CBM：{item.cartonCbm.toFixed(8)}</span>
                        <span>季节性产品：{item.isSeasonal ? '是' : '否'}</span>
                        <span>更新时间：{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '-'}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filteredItems.length === 0 && <tr><td colSpan={16} className="empty">暂无匹配的 SKU 资料。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
