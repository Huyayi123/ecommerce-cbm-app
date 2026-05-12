import { useMemo, useState } from 'react';
import { PurchaseUploader } from '../components/PurchaseUploader';
import { ResultsTable } from '../components/ResultsTable';
import { SummaryCards } from '../components/SummaryCards';
import type { CalculationRow, PurchaseRecord, PurchaseRow, SkuItem } from '../types';
import { calculateRows, summarize } from '../utils/calculations';
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
    .filter((row) => row.status !== 'error' && row.sku && row.purchaseQuantity && row.purchaseQuantity > 0)
    .map((row) => ({
      id: crypto.randomUUID(),
      manufacturerName: row.manufacturerName,
      sku: row.sku,
      productName: row.productName,
      shopName: row.shopName,
      buyerName: row.buyerName,
      purchaseQuantity: row.purchaseQuantity ?? 0,
      purchasePrice: row.purchasePrice ?? 0,
      totalAmount: round((row.purchaseQuantity ?? 0) * (row.purchasePrice ?? 0), 2),
      purchaseDate: today.toISOString().slice(0, 10),
      estimatedArrivalDate: addDays(today, 30),
      status: 'in_transit',
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
  const calculationRows = useMemo(() => calculateRows(purchaseRows, skuItems), [purchaseRows, skuItems]);
  const summary = useMemo(() => summarize(calculationRows), [calculationRows]);
  const errorCount = calculationRows.filter((row) => row.status === 'error').length;
  const savableCount = calculationRows.filter((row) => row.status !== 'error' && row.purchaseQuantity && row.purchaseQuantity > 0).length;

  function updatePurchaseQuantity(rowId: string, quantity: number | null) {
    onRowsChange(purchaseRows.map((row) => (row.rowId === rowId ? { ...row, purchaseQuantity: quantity } : row)));
  }

  function normalizeRows(rows: PurchaseRow[]): { rows: PurchaseRow[]; conflicts: string[] } {
    const merged = new Map<string, PurchaseRow>();

    for (const row of rows) {
      const skuKey = row.sku.trim().toUpperCase();
      if (!skuKey) continue;

      const existing = merged.get(skuKey);
      if (!existing) {
        merged.set(skuKey, { ...row });
        continue;
      }
      existing.purchaseQuantity = (existing.purchaseQuantity ?? 0) + (row.purchaseQuantity ?? 0);
      existing.raw = { ...existing.raw, mergedRows: true };
    }

    return {
      rows: Array.from(merged.values()).map((row, index) => ({ ...row, rowNumber: index + 2 })),
      conflicts: [],
    };
  }

  function saveAsPurchaseRecords() {
    if (!canEditData) return;
    const records = toPurchaseRecords(calculationRows);
    if (records.length > 0) onRecordsCreate(records);
  }

  return (
    <>
      <SummaryCards summary={summary} errorCount={errorCount} />

      <PurchaseUploader
        onLoaded={(rows, name) => {
          const normalized = normalizeRows(rows);
          setDuplicateMessage(rows.length !== normalized.rows.length ? '已自动合并重复 SKU 的采购数量' : '');
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
      />
    </>
  );
}
