import { useEffect, useState } from 'react';
import type { CalculationRow } from '../types';
import { exportResults } from '../utils/exporters';

type Props = {
  rows: CalculationRow[];
  fileName: string;
  onQuantityChange: (rowId: string, quantity: number | null) => void;
  onTotalCbmChange: (rowId: string, totalCbm: number | null) => void;
  onDeleteRow: (rowId: string) => void;
  onClearRows: () => void;
  onRecalculate: (changes: { quantities: Record<string, number | null>; totalCbms: Record<string, number | null> }) => void;
  onSyncSkuData: () => void;
};

function parseQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const quantity = Number(trimmed);
  return Number.isFinite(quantity) ? quantity : null;
}

export function ResultsTable({ rows, fileName, onQuantityChange, onTotalCbmChange, onDeleteRow, onClearRows, onRecalculate, onSyncSkuData }: Props) {
  const [draftQuantities, setDraftQuantities] = useState<Record<string, string>>({});
  const [draftTotalCbms, setDraftTotalCbms] = useState<Record<string, string>>({});
  const totalPurchaseAmount = rows.reduce((sum, row) => sum + (row.totalAmount ?? 0), 0);

  useEffect(() => {
    setDraftQuantities((current) => {
      const rowIds = new Set(rows.map((row) => row.rowId));
      const next = Object.fromEntries(Object.entries(current).filter(([rowId]) => rowIds.has(rowId)));
      return next;
    });
    setDraftTotalCbms((current) => {
      const rowIds = new Set(rows.map((row) => row.rowId));
      const next = Object.fromEntries(Object.entries(current).filter(([rowId]) => rowIds.has(rowId)));
      return next;
    });
  }, [rows]);

  function commitQuantity(rowId: string) {
    if (!(rowId in draftQuantities)) return;
    const quantity = parseQuantity(draftQuantities[rowId]);
    setDraftQuantities((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    onQuantityChange(rowId, quantity);
  }

  function commitTotalCbm(rowId: string) {
    if (!(rowId in draftTotalCbms)) return;
    const totalCbm = parseQuantity(draftTotalCbms[rowId]);
    setDraftTotalCbms((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    onTotalCbmChange(rowId, totalCbm);
  }

  function commitAllDrafts() {
    const quantities = Object.fromEntries(
      Object.entries(draftQuantities).map(([rowId, value]) => [rowId, parseQuantity(value)]),
    );
    const totalCbms = Object.fromEntries(
      Object.entries(draftTotalCbms).map(([rowId, value]) => [rowId, parseQuantity(value)]),
    );
    setDraftQuantities({});
    setDraftTotalCbms({});
    onRecalculate({ quantities, totalCbms });
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>计算结果</h2>
          <p>
            {fileName ? `当前报表：${fileName}` : '上传采购报表后自动匹配 SKU 并计算 CBM。'}
            {rows.length > 0 ? ` 采购总金额：${totalPurchaseAmount.toFixed(2)}` : ''}
          </p>
        </div>
        <div className="export-actions">
          <button type="button" onClick={commitAllDrafts} disabled={rows.length === 0}>重新计算</button>
          <button type="button" onClick={onSyncSkuData} disabled={rows.length === 0}>同步 SKU 资料</button>
          <button type="button" onClick={onClearRows} disabled={rows.length === 0}>清空全部</button>
          <button type="button" onClick={() => exportResults(rows, 'xlsx')} disabled={rows.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportResults(rows, 'csv')} disabled={rows.length === 0}>导出 CSV</button>
        </div>
      </div>

      <div className="table-wrap desktop-data-view">
        <table>
          <thead>
            <tr>
              <th>图片</th>
              <th>内部编号</th>
              <th>厂家名</th>
              <th>SKU</th>
              <th>产品名称</th>
              <th>店铺</th>
              <th>采购人</th>
              <th>月销量</th>
              <th>采购数量</th>
              <th>采购单价</th>
              <th>总金额</th>
              <th>单品 CBM</th>
              <th>总 CBM</th>
              <th>异常提示</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowId} className={row.status === 'error' ? 'error-row' : ''}>
                <td>{row.imageUrl ? <img className="sku-thumb" src={row.imageUrl} alt={row.productName || row.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                <td><strong>{row.internalCode || '-'}</strong></td>
                <td>{row.manufacturerName || '-'}</td>
                <td>{row.sku || '-'}</td>
                <td>{row.productName || '-'}</td>
                <td>{row.shopName || '-'}</td>
                <td>{row.buyerName || '-'}</td>
                <td>{row.monthlySales ?? '-'}</td>
                <td>
                  <input
                    className="quantity-input"
                    type="text"
                    inputMode="decimal"
                    min="0"
                    value={draftQuantities[row.rowId] ?? String(row.purchaseQuantity ?? '')}
                    onChange={(event) => {
                      setDraftQuantities((current) => ({ ...current, [row.rowId]: event.target.value }));
                    }}
                    onBlur={() => commitQuantity(row.rowId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </td>
                <td>{row.purchasePrice?.toFixed(2) ?? '-'}</td>
                <td>{row.totalAmount?.toFixed(2) ?? '-'}</td>
                <td>{row.unitCbm?.toFixed(8) ?? '-'}</td>
                <td>
                  <input
                    className="quantity-input"
                    type="text"
                    inputMode="decimal"
                    min="0"
                    value={draftTotalCbms[row.rowId] ?? String(row.totalCbm ?? '')}
                    onChange={(event) => {
                      setDraftTotalCbms((current) => ({ ...current, [row.rowId]: event.target.value }));
                    }}
                    onBlur={() => commitTotalCbm(row.rowId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </td>
                <td>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</td>
                <td><button className="danger" type="button" onClick={() => onDeleteRow(row.rowId)}>删除</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} className="empty">暂无计算结果。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mobile-data-view mobile-card-list mobile-results-list">
        {rows.map((row) => <article className={`mobile-record-card mobile-result-card${row.status === 'error' ? ' error-row' : ''}`} key={row.rowId}>
          <div className="mobile-order-topline"><strong>{row.shopName || '-'}</strong><span className="mobile-status-chip">{row.buyerName || '未分配采购人'}</span></div>
          <div className="mobile-order-identity">
            {row.imageUrl ? <img className="sku-thumb" src={row.imageUrl} alt={row.productName || row.sku || 'SKU'} loading="lazy" /> : <div className="mobile-order-image-placeholder">无图</div>}
            <div><strong>{row.productName || '-'}</strong><span>{row.sku || '-'}</span><small>{row.manufacturerName || '-'}</small></div>
          </div>
          <div className="mobile-record-form mobile-result-inputs">
            <label>采购数量<input className="quantity-input" type="text" inputMode="decimal" min="0" value={draftQuantities[row.rowId] ?? String(row.purchaseQuantity ?? '')} onChange={(event) => setDraftQuantities((current) => ({ ...current, [row.rowId]: event.target.value }))} onBlur={() => commitQuantity(row.rowId)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
            <label>总 CBM<input className="quantity-input" type="text" inputMode="decimal" min="0" value={draftTotalCbms[row.rowId] ?? String(row.totalCbm ?? '')} onChange={(event) => setDraftTotalCbms((current) => ({ ...current, [row.rowId]: event.target.value }))} onBlur={() => commitTotalCbm(row.rowId)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
          </div>
          <dl className="mobile-record-metrics">
            <div><dt>采购单价</dt><dd>{row.purchasePrice?.toFixed(2) ?? '-'}</dd></div><div><dt>总金额</dt><dd>{row.totalAmount?.toFixed(2) ?? '-'}</dd></div>
            <div><dt>单品 CBM</dt><dd>{row.unitCbm?.toFixed(8) ?? '-'}</dd></div><div><dt>月销量</dt><dd>{row.monthlySales ?? '-'}</dd></div>
          </dl>
          <div className="mobile-record-note"><span>内部编号：{row.internalCode || '-'}</span><span>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</span></div>
          <div className="mobile-record-actions"><button className="danger" type="button" onClick={() => onDeleteRow(row.rowId)}>删除</button></div>
        </article>)}
        {rows.length === 0 && <div className="mobile-empty-state">暂无计算结果。</div>}
      </div>
    </section>
  );
}
