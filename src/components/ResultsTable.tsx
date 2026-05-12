import type { CalculationRow } from '../types';
import { exportResults } from '../utils/exporters';

type Props = {
  rows: CalculationRow[];
  fileName: string;
  onQuantityChange: (rowId: string, quantity: number | null) => void;
};

export function ResultsTable({ rows, fileName, onQuantityChange }: Props) {
  const totalPurchaseAmount = rows.reduce((sum, row) => sum + (row.totalAmount ?? 0), 0);

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
          <button type="button" onClick={() => exportResults(rows, 'xlsx')} disabled={rows.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportResults(rows, 'csv')} disabled={rows.length === 0}>导出 CSV</button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>厂家名</th>
              <th>SKU</th>
              <th>产品名称</th>
              <th>店铺</th>
              <th>采购人</th>
              <th>采购数量</th>
              <th>采购单价</th>
              <th>总金额</th>
              <th>单品 CBM</th>
              <th>总 CBM</th>
              <th>异常提示</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowId} className={row.status === 'error' ? 'error-row' : ''}>
                <td>{row.manufacturerName || '-'}</td>
                <td>{row.sku || '-'}</td>
                <td>{row.productName || '-'}</td>
                <td>{row.shopName || '-'}</td>
                <td>{row.buyerName || '-'}</td>
                <td>
                  <input
                    className="quantity-input"
                    type="number"
                    min="0"
                    value={row.purchaseQuantity ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      const quantity = Number(value);
                      onQuantityChange(row.rowId, value === '' || !Number.isFinite(quantity) ? null : quantity);
                    }}
                  />
                </td>
                <td>{row.purchasePrice?.toFixed(2) ?? '-'}</td>
                <td>{row.totalAmount?.toFixed(2) ?? '-'}</td>
                <td>{row.unitCbm?.toFixed(8) ?? '-'}</td>
                <td>{row.totalCbm?.toFixed(4) ?? '-'}</td>
                <td>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="empty">暂无计算结果。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
