import { useEffect, useMemo, useRef, useState } from 'react';
import { PurchaseUploader } from '../components/PurchaseUploader';
import { ResultsTable } from '../components/ResultsTable';
import { SummaryCards } from '../components/SummaryCards';
import type { CalculationRow, PurchaseRecord, PurchaseRow, SkuItem } from '../types';
import { calculateRows, findMatchingSkuItem, getSkuMatchKey, summarize } from '../utils/calculations';
import { round } from '../utils/number';

type Props = {
  skuItems: SkuItem[];
  purchaseRows: PurchaseRow[];
  fileName: string;
  onRowsChange: (rows: PurchaseRow[]) => void;
  onFileNameChange: (fileName: string) => void;
  onRecordsCreate: (records: PurchaseRecord[]) => Promise<void>;
  canEditData?: boolean;
};

function createPurchaseBatch() {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  const time = today.toTimeString().slice(0, 8).replace(/:/g, '');
  return {
    id: `${date}-${time}-${crypto.randomUUID().slice(0, 8)}`,
    name: `${date} 批次 ${time}`,
    date,
  };
}

function toPurchaseRecords(rows: CalculationRow[]): PurchaseRecord[] {
  const today = new Date();
  const batch = createPurchaseBatch();
  return rows
    .filter((row) => row.status !== 'error' && (row.sku || row.productName || row.englishName) && row.purchaseQuantity && row.purchaseQuantity > 0)
    .map((row) => ({
      id: crypto.randomUUID(),
      internalCode: row.internalCode,
      manufacturerName: row.manufacturerName,
      sku: row.sku,
      productName: row.productName,
      englishName: row.englishName,
      imageUrl: row.imageUrl,
      shopName: row.shopName,
      buyerName: row.buyerName,
      assignedBuyerName: row.buyerName,
      assignedBuyerEmail: '',
      isConfirmed: false,
      purchaseQuantity: row.purchaseQuantity ?? 0,
      confirmedPurchaseQuantity: null,
      purchasePrice: row.purchasePrice ?? 0,
      freightCost: 0,
      totalAmount: round((row.purchaseQuantity ?? 0) * (row.purchasePrice ?? 0), 2),
      purchaseDate: today.toISOString().slice(0, 10),
      purchasePoolId: batch.id,
      purchasePoolName: batch.name,
      purchasePoolDate: batch.date,
      poolStatus: 'pending_purchase',
      purchaseBatchId: batch.id,
      purchaseBatchName: batch.name,
      purchaseBatchDate: batch.date,
      estimatedArrivalDate: '',
      status: 'pending',
      unitCbm: row.unitCbm ?? 0,
      totalCbm: row.totalCbm ?? 0,
      loadingType: '整柜',
      containerDate: '',
      totalWeightKg: null,
      cartonCount: null,
      unitsPerCarton: null,
      tailQuantity: 0,
      isMixed: false,
      mixedGroups: [],
      logisticsTotalCbm: null,
      logisticsBatchId: '',
      logisticsConfirmationStatus: 'unassigned',
      logisticsLoadedCartonCount: null,
      logisticsLoadedTailQuantity: 0,
      logisticsLeftCartonCount: null,
      logisticsLeftTailQuantity: 0,
      logisticsSourceRecordId: '',
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
  const [syncMessage, setSyncMessage] = useState('');
  const [createMessage, setCreateMessage] = useState('');
  const [isCreatingTasks, setIsCreatingTasks] = useState(false);
  const isCreatingTasksRef = useRef(false);
  const [workingRows, setWorkingRows] = useState<PurchaseRow[]>(purchaseRows);
  const calculationRows = useMemo(() => calculateRows(workingRows, skuItems), [workingRows, skuItems]);
  const summary = useMemo(() => summarize(calculationRows), [calculationRows]);
  const errorCount = calculationRows.filter((row) => row.status === 'error').length;
  const savableCount = calculationRows.filter((row) => row.status !== 'error' && row.purchaseQuantity && row.purchaseQuantity > 0).length;

  useEffect(() => {
    setWorkingRows(purchaseRows);
  }, [purchaseRows]);

  function updatePurchaseQuantity(rowId: string, quantity: number | null) {
    setWorkingRows((current) => {
      const next = current.map((row) => (row.rowId === rowId ? { ...row, purchaseQuantity: quantity } : row));
      onRowsChange(next);
      return next;
    });
  }

  function updateTotalCbm(rowId: string, totalCbm: number | null) {
    setWorkingRows((current) => {
      const next = current.map((row) => (row.rowId === rowId ? { ...row, manualTotalCbm: totalCbm, raw: { ...row.raw, manualTotalCbm: totalCbm } } : row));
      onRowsChange(next);
      return next;
    });
  }

  function deleteWorkingRow(rowId: string) {
    setWorkingRows((current) => {
      const next = current.filter((row) => row.rowId !== rowId).map((row, index) => ({ ...row, rowNumber: index + 2 }));
      onRowsChange(next);
      return next;
    });
  }

  function clearWorkingRows() {
    setWorkingRows([]);
    onRowsChange([]);
    onFileNameChange('');
    setDuplicateMessage('');
    setSyncMessage('');
    setCreateMessage('');
  }

  function syncSkuDataToWorkingRows() {
    setWorkingRows((current) => {
      let updatedCount = 0;
      const next = current.map((row) => {
        const shopKey = String(row.shopName ?? row.raw.shopName ?? '').trim().toLowerCase();
        const scopedSkuItems = shopKey
          ? skuItems.filter((item) => item.shopName.trim().toLowerCase() === shopKey)
          : skuItems;
        const skuItem = findMatchingSkuItem(row, scopedSkuItems) ?? findMatchingSkuItem(row, skuItems);
        if (!skuItem) return row;

        updatedCount += 1;
        return {
          ...row,
          sku: skuItem.sku || row.sku,
          productName: skuItem.productName || row.productName,
          englishName: skuItem.englishName || row.englishName,
          imageUrl: skuItem.imageUrl || row.imageUrl,
          manufacturerName: skuItem.manufacturerName || row.manufacturerName,
          shopName: skuItem.shopName || row.shopName,
          raw: {
            ...row.raw,
            sku: skuItem.sku || row.sku,
            productName: skuItem.productName || row.productName,
            englishName: skuItem.englishName || row.englishName,
            imageUrl: skuItem.imageUrl || row.imageUrl,
            manufacturerName: skuItem.manufacturerName || row.manufacturerName,
            shopName: skuItem.shopName || row.shopName,
          },
        };
      });
      setSyncMessage(updatedCount > 0 ? `已同步 ${updatedCount} 条 SKU 资料到当前装柜计算。` : '没有找到可同步的 SKU 资料。');
      setCreateMessage('');
      onRowsChange(next);
      return next;
    });
  }

  function recalculateDrafts(changes: { quantities: Record<string, number | null>; totalCbms: Record<string, number | null> }) {
    setWorkingRows((current) => {
      const next = current.map((row) => {
        const quantityChanged = row.rowId in changes.quantities;
        const totalCbmChanged = row.rowId in changes.totalCbms;
        if (!quantityChanged && !totalCbmChanged) return row;
        const manualTotalCbm = totalCbmChanged ? changes.totalCbms[row.rowId] : row.manualTotalCbm;
        return {
          ...row,
          purchaseQuantity: quantityChanged ? changes.quantities[row.rowId] : row.purchaseQuantity,
          manualTotalCbm,
          raw: { ...row.raw, manualTotalCbm },
        };
      });
      onRowsChange(next);
      return next;
    });
  }

  function normalizeRows(rows: PurchaseRow[]): { rows: PurchaseRow[]; conflicts: string[] } {
    const merged = new Map<string, PurchaseRow>();
    const passthrough: PurchaseRow[] = [];

    for (const row of rows) {
      const shopKey = String(row.shopName ?? row.raw.shopName ?? '').trim().toLowerCase();
      const key = [shopKey, getSkuMatchKey(row)].filter(Boolean).join('|');
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

  async function createPurchaseTasks() {
    if (!canEditData || isCreatingTasksRef.current) return;
    const records = toPurchaseRecords(calculationRows);
    if (records.length === 0) {
      setCreateMessage('没有可生成的采购任务，请确认采购数量、SKU 匹配和异常提示。');
      return;
    }
    const missing = records.filter((record) => !record.assignedBuyerName.trim()).map((record) => record.sku || record.productName).filter(Boolean);
    if (missing.length > 0) {
      const ok = window.confirm(`以下 SKU 未分配采购人，保存后无法自动分配到个人采购订单中：\n${missing.join('\n')}\n\n是否继续保存？`);
      if (!ok) return;
    }
    try {
      isCreatingTasksRef.current = true;
      setIsCreatingTasks(true);
      setCreateMessage(`正在生成 ${records.length} 条采购任务...`);
      await onRecordsCreate(records);
      setCreateMessage(`已生成 ${records.length} 条采购任务。`);
    } catch (error) {
      console.error(error);
      setCreateMessage(error instanceof Error ? error.message : '生成采购任务失败，请稍后重试。');
    } finally {
      isCreatingTasksRef.current = false;
      setIsCreatingTasks(false);
    }
  }

  return (
    <>
      <SummaryCards summary={summary} errorCount={errorCount} />

      <PurchaseUploader
        onLoaded={(rows, name) => {
          const normalized = normalizeRows(rows);
          setDuplicateMessage(rows.length !== normalized.rows.length ? '已自动合并重复 SKU 的采购数量' : '');
          setSyncMessage('');
          setCreateMessage('');
          setWorkingRows(normalized.rows);
          onRowsChange(normalized.rows);
          onFileNameChange(name);
        }}
      />

      {duplicateMessage && <div className="inline-notice">{duplicateMessage}</div>}
      {syncMessage && <div className="inline-notice">{syncMessage}</div>}
      {createMessage && <div className="inline-notice">{createMessage}</div>}

      <section className="panel compact-panel">
        <div className="section-heading">
          <div>
            <h2>装柜采购单</h2>
            <p>确认计划数量、单价和 CBM 后，生成采购任务并分配给采购人；这里不直接形成在途库存。</p>
          </div>
          <button className="primary" type="button" onClick={() => void createPurchaseTasks()} disabled={!canEditData || savableCount === 0 || isCreatingTasks}>
            {isCreatingTasks ? '生成中...' : '生成采购任务'}
          </button>
        </div>
      </section>

      <ResultsTable
        rows={calculationRows}
        fileName={fileName}
        onQuantityChange={updatePurchaseQuantity}
        onTotalCbmChange={updateTotalCbm}
        onDeleteRow={deleteWorkingRow}
        onClearRows={clearWorkingRows}
        onRecalculate={recalculateDrafts}
        onSyncSkuData={syncSkuDataToWorkingRows}
      />
    </>
  );
}
