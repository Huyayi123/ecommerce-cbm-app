import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { PurchaseRecord, PurchaseRow, SalesSuggestionRow, SkuItem } from '../types';
import { parseSalesFile } from '../utils/fileParsers';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, isInventoryRecord } from '../utils/purchaseRecords';
import { fetchTakealotInventory, type TakealotInventoryRow } from '../utils/takealot';

type Props = {
  skuItems: SkuItem[];
  purchaseRecords: PurchaseRecord[];
  onSendToCalculator: (rows: PurchaseRow[], fileName: string) => void;
  canEditData?: boolean;
  onSuggestionsSave?: (rows: SalesSuggestionRow[]) => void;
};

const DEFAULT_STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];
const STORE_NAME_MAP = new Map(DEFAULT_STORES.map((store) => [store.toLowerCase(), store]));

function canonicalStoreName(value: string): string {
  return STORE_NAME_MAP.get(value.trim().toLowerCase()) ?? '';
}

export function SalesSuggestionPage({ skuItems, purchaseRecords, onSendToCalculator, canEditData = true, onSuggestionsSave }: Props) {
  const [salesRows, setSalesRows] = useState<PurchaseRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [stockMonths, setStockMonths] = useState(2);
  const [selectedStore, setSelectedStore] = useState('');
  const [inventoryRows, setInventoryRows] = useState<TakealotInventoryRow[]>([]);
  const [syncMessage, setSyncMessage] = useState('');

  const storeOptions = useMemo(() => {
    const extraNames = skuItems
      .map((item) => canonicalStoreName(item.shopName))
      .filter(Boolean);
    return Array.from(new Set([...DEFAULT_STORES, ...extraNames]));
  }, [skuItems]);

  useEffect(() => {
    if (!selectedStore && storeOptions.length > 0) setSelectedStore(storeOptions[0]);
  }, [selectedStore, storeOptions]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const rows = await parseSalesFile(file);
    setSalesRows(rows);
    setFileName(file.name);
    event.target.value = '';
  }

  async function syncTakealotInventory() {
    if (!selectedStore) {
      setSyncMessage('请先选择店铺。');
      return;
    }
    try {
      setSyncMessage('正在同步 Takealot 库存...');
      const rows = await fetchTakealotInventory(selectedStore, salesRows.map((row) => row.sku));
      setInventoryRows(rows);
      setSyncMessage(`已同步 ${rows.length} 条 Takealot 库存。`);
    } catch (error) {
      console.error(error);
      setSyncMessage(error instanceof Error ? error.message : 'Takealot 库存同步失败');
    }
  }

  const suggestions = useMemo<SalesSuggestionRow[]>(() => {
    const scopedSkuItems = selectedStore ? skuItems.filter((item) => canonicalStoreName(item.shopName) === selectedStore) : skuItems;
    const skuMap = new Map(scopedSkuItems.map((item) => [item.sku.trim().toUpperCase(), item]));
    const inventoryMap = new Map(inventoryRows.map((item) => [item.sku.trim().toUpperCase(), item]));
    const inTransitBySku = new Map<string, number>();

    for (const record of purchaseRecords) {
      if (!isInventoryRecord(record)) continue;
      if (record.status !== 'in_transit') continue;
      if (selectedStore && canonicalStoreName(record.shopName) !== selectedStore) continue;
      const key = record.sku.trim().toUpperCase();
      inTransitBySku.set(key, (inTransitBySku.get(key) ?? 0) + effectivePurchaseQuantity(record));
    }

    return salesRows.map((row) => {
      const key = row.sku.trim().toUpperCase();
      const skuItem = skuMap.get(key);
      const inventory = inventoryMap.get(key);
      const monthlySales = row.purchaseQuantity ?? 0;
      const targetQuantity = round(monthlySales * stockMonths, 2);
      const localStockQuantity = inventory?.localStockQuantity ?? 0;
      const takealotStockQuantity = inventory?.takealotStockQuantity ?? 0;
      const stockOnWayQuantity = inventory?.stockOnWayQuantity ?? 0;
      const inTransitQuantity = inTransitBySku.get(key) ?? 0;
      const suggestedQuantity = Math.max(round(targetQuantity - localStockQuantity - takealotStockQuantity - stockOnWayQuantity - inTransitQuantity, 2), 0);
      const estimatedCartons =
        skuItem && skuItem.unitsPerCarton > 0 ? round(suggestedQuantity / skuItem.unitsPerCarton, 2) : null;
      const estimatedCbm =
        skuItem && estimatedCartons !== null && skuItem.cartonCbm > 0
          ? round(estimatedCartons * skuItem.cartonCbm, 4)
          : skuItem && skuItem.unitCbm > 0
            ? round(suggestedQuantity * skuItem.unitCbm, 4)
            : null;
      const messages: string[] = [];

      if (!row.sku.trim()) messages.push('SKU 为空');
      if (!skuItem && row.sku.trim()) messages.push('未录入 SKU 资料');

      return {
        rowId: row.rowId,
        sku: row.sku,
        productName: skuItem?.productName ?? '',
        shopName: skuItem?.shopName ?? '',
        manufacturerName: skuItem?.manufacturerName ?? '',
        buyerName: skuItem?.buyerName ?? '',
        monthlySales,
        stockMonths,
        targetQuantity,
        localStockQuantity,
        takealotStockQuantity,
        stockOnWayQuantity,
        inTransitQuantity,
        suggestedQuantity,
        unitsPerCarton: skuItem?.unitsPerCarton ?? null,
        estimatedCartons,
        estimatedCbm,
        messages,
      };
    });
  }, [inventoryRows, purchaseRecords, salesRows, selectedStore, skuItems, stockMonths]);

  useEffect(() => {
    if (salesRows.length > 0) onSuggestionsSave?.(suggestions);
  }, [onSuggestionsSave, salesRows.length, suggestions]);

  function sendToCalculator() {
    const rows = suggestions
      .filter((row) => row.suggestedQuantity > 0 && row.messages.length === 0)
      .map((row, index) => ({
        rowId: `${Date.now()}-suggestion-${index}`,
        rowNumber: index + 2,
        sku: row.sku,
        productName: row.productName,
        englishName: '',
        manufacturerName: row.manufacturerName,
        purchaseQuantity: row.suggestedQuantity,
        raw: { source: 'sales-suggestion', monthlySales: row.monthlySales, stockMonths: row.stockMonths },
      }));

    if (canEditData && rows.length > 0) onSendToCalculator(rows, fileName ? `采购建议：${fileName}` : '采购建议');
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>月销量生成采购建议</h2>
          <p>根据月销量、备货月数和当前海运在途库存计算建议采购数量。</p>
        </div>
        <div className="export-actions">
          <label className="file-button">
            上传月销量
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} />
          </label>
          <button className="primary" type="button" onClick={sendToCalculator} disabled={!canEditData || suggestions.every((row) => row.suggestedQuantity <= 0 || row.messages.length > 0)}>
            发送到装柜计算
          </button>
        </div>
      </div>

      <div className="suggestion-controls">
        <label>
          店铺
          <select value={selectedStore} onChange={(event) => {
            setSelectedStore(event.target.value);
            setInventoryRows([]);
          }}>
            {storeOptions.map((store) => <option key={store} value={store}>{store}</option>)}
          </select>
        </label>
        <label>
          备货月数
          <input type="number" min="0" step="0.5" value={stockMonths} onChange={(event) => setStockMonths(Number(event.target.value))} />
        </label>
        <button type="button" onClick={() => void syncTakealotInventory()} disabled={!selectedStore || salesRows.length === 0}>同步 Takealot 库存</button>
        <span>{fileName ? `当前文件：${fileName}` : '表头支持 SKU、月销量、销售数量、销量、salesQuantity'}</span>
      </div>
      {syncMessage && <div className="inline-notice">{syncMessage}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th><th>产品名称</th><th>店铺</th><th>厂家名</th><th>采购人</th><th>月销量</th><th>备货月数</th><th>目标备货数量</th><th>南非本地库存</th><th>官方仓库存</th><th>送仓路上库存</th><th>海运在途数量</th><th>建议采购数量</th><th>每箱数量</th><th>预计箱数</th><th>预计 CBM</th><th>状态/备注</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((row) => (
              <tr key={row.rowId} className={row.messages.length > 0 ? 'error-row' : ''}>
                <td>{row.sku || '-'}</td>
                <td>{row.productName || '-'}</td>
                <td>{row.shopName || '-'}</td>
                <td>{row.manufacturerName || '-'}</td>
                <td>{row.buyerName || '-'}</td>
                <td>{row.monthlySales}</td>
                <td>{row.stockMonths}</td>
                <td>{row.targetQuantity}</td>
                <td>{row.localStockQuantity}</td>
                <td>{row.takealotStockQuantity}</td>
                <td>{row.stockOnWayQuantity}</td>
                <td>{row.inTransitQuantity}</td>
                <td>{row.suggestedQuantity}</td>
                <td>{row.unitsPerCarton ?? '-'}</td>
                <td>{row.estimatedCartons ?? '-'}</td>
                <td>{row.estimatedCbm?.toFixed(4) ?? '-'}</td>
                <td>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</td>
              </tr>
            ))}
            {suggestions.length === 0 && <tr><td colSpan={17} className="empty">上传月销量表后生成采购建议。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
