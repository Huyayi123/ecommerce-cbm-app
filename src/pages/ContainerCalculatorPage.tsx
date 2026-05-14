import { useEffect, useMemo, useState } from 'react';
import { PurchaseUploader } from '../components/PurchaseUploader';
import { ResultsTable } from '../components/ResultsTable';
import { SummaryCards } from '../components/SummaryCards';
import type { CalculationRow, PurchaseRecord, PurchaseRow, SkuItem } from '../types';
import { calculateRows, getSkuMatchKey, summarize } from '../utils/calculations';
import { round } from '../utils/number';

type Props = {
  skuItems: SkuItem[];
  purchaseRows: PurchaseRow[];
  fileName: string;
  onRowsChange: (rows: PurchaseRow[]) => void;
  onFileNameChange: (fileName: string) => void;
  onRecordsCreate: (records: PurchaseRecord[]) => void;
  canEditData?: boolean;
};

function addDays(date: Date, days: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function toPurchaseRecords(rows: CalculationRow[]): PurchaseRecord[] {
  const today = new Date();
  return rows
    .filter((row) => row.status !== 'error' && (row.sku || row.productName || row.englishName) && row.purchaseQuantity && row.purchaseQuantity > 0)
    .map((row) => ({
      id: crypto.randomUUID(),
      manufacturerName: row.manufacturerName,
      sku: row.sku,
      productName: row.productName,
      englishName: row.englishName,
      shopName: row.shopName,
      buyerName: row.buyerName,
      assignedBuyerName: row.buyerName,
      assignedBuyerEmail: '',
      purchaseQuantity: row.purchaseQuantity ?? 0,
      purchasePrice: row.purchasePrice ?? 0,
      totalAmount: round((row.purchaseQuantity ?? 0) * (row.purchasePrice ?? 0), 2),
      purchaseDate: today.toISOString().slice(0, 10),
      estimatedArrivalDate: addDays(today, 30),
      status: 'pending',
      unitCbm: row.unitCbm ?? 0,
      totalCbm: row.totalCbm ?? 0,
      note: '',
    }));
}

export function ContainerCalculatorPage({
  skuItems,
  purchaseRows,
  fileName,
  onRowsChange,
  onFileNameChange,
  onRecordsCreate,
  canEditData = true,
}: Props) {
  const [duplicateMessage, setDuplicateMessage] = useState('');
  const [workingRows, setWorkingRows] = useState<PurchaseRow[]>(purchaseRows);
  const calculationRows = useMemo(() => calculateRows(workingRows, skuItems), [workingRows, skuItems]);
  const summary = useMemo(() => summarize(calculationRows), [calculationRows]);
  const errorCount = calculationRows.filter((row) => row.status === 'error').length;
  const savableCount = calculationRows.filter((row) => row.status !== 'error' && row.purchaseQuantity && row.purchaseQuantity > 0).length;

  useEffect(() => {
    setWorkingRows(purchaseRows);
  }, [purchaseRows]);

  function updatePurchaseQuantity(rowId: string, quantity: number | null) {
    setWorkingRows((current) => current.map((row) => (row.rowId === rowId ? { ...row, purchaseQuantity: quantity } : row)));
  }

  function recalculateQuantities(changes: Record<string, number | null>) {
    setWorkingRows((current) =>
      current.map((row) => (row.rowId in changes ? { ...row, purchaseQuantity: changes[row.rowId] } : row)),
    );
  }

  function normalizeRows(rows: PurchaseRow[]): { rows: PurchaseRow[]; conflicts: string[] } {
    const merged = new Map<string, PurchaseRow>();
    const passthrough: PurchaseRow[] = [];

    for (const row of rows) {
      const key = getSkuMatchKey(row);
      if (!key) {
        passthrough.push(row);
        continue;
      }

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...row });
        continue;
      }
      existing.purchaseQuantity = (existing.purchaseQuantity ?? 0) + (row.purchaseQuantity ?? 0);
      existing.raw = { ...existing.raw, mergedRows: true };
    }

    return {
      rows: [...Array.from(merged.values()), ...passthrough].map((row, index) => ({ ...row, rowNumber: index + 2 })),
      conflicts: [],
    };
  }

  function saveAsPurchaseRecords() {
    if (!canEditData) return;
    const records = toPurchaseRecords(calculationRows);
    const missing = records.filter((record) => !record.assignedBuyerName.trim()).map((record) => record.sku || record.productName).filter(Boolean);
    if (missing.length > 0) {
      const ok = window.confirm(`以下 SKU 未分配采购人，保存后无法自动分配到个人采购订单中：\n${missing.join('\n')}\n\n是否继续保存？`);
      if (!ok) return;
    }
    if (records.length > 0) onRecordsCreate(records);
  }

  return (
    <>
      <SummaryCards summary={summary} errorCount={errorCount} />

      <PurchaseUploader
        onLoaded={(rows, name) => {
          const normalized = normalizeRows(rows);
          setDuplicateMessage(rows.length !== normalized.rows.length ? '已自动合并重复 SKU 的采购数量' : '');
          setWorkingRows(normalized.rows);
          onRowsChange(normalized.rows);
          onFileNameChange(name);
        }}
      />

      {duplicateMessage && <div className="inline-notice">{duplicateMessage}</div>}

      <section className="panel compact-panel">
        <div className="section-heading">
          <div>
            <h2>装柜采购单</h2>
            <p>确认数量、单价和 CBM 后，可保存为海运在途采购记录。</p>
          </div>
          <button className="primary" type="button" onClick={saveAsPurchaseRecords} disabled={!canEditData || savableCount === 0}>
            保存为采购记录
          </button>
        </div>
      </section>

      <ResultsTable
        rows={calculationRows}
        fileName={fileName}
        onQuantityChange={updatePurchaseQuantity}
        onRecalculate={recalculateQuantities}
      />
    </>
  );
}
