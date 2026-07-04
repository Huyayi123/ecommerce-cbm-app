import type { ChangeEvent } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PurchaseRecord, PurchaseRow, SalesSuggestionRow, SkuItem } from '../types';
import { parseSalesFile } from '../utils/fileParsers';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, isInventoryRecord, withPurchaseTotals } from '../utils/purchaseRecords';
import { stockMonthsForMonthlySales, stockMonthsRuleDescription } from '../utils/stockMonths';
import { fetchTakealotInventory, type TakealotInventoryRow } from '../utils/takealot';

type Props = {
  skuItems: SkuItem[];
  purchaseRecords: PurchaseRecord[];
  onSendToCalculator: (rows: PurchaseRow[], fileName: string) => void;
  canEditData?: boolean;
  savedSuggestions?: SalesSuggestionRow[];
};

const DEFAULT_STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];
const PURCHASE_POOL_STORAGE_PREFIX = 'sales-suggestion-purchase-pool:v1:';
const SHARED_PURCHASE_POOL_STORAGE_KEY = `${PURCHASE_POOL_STORAGE_PREFIX}shared`;
const STORE_NAME_MAP = new Map(DEFAULT_STORES.map((store) => [store.toLowerCase(), store]));
const NEW_PRODUCT_RULES: Record<string, Array<{ limit: number; multiplier: number }>> = {
  Bestby: [
    { limit: 60, multiplier: 3 },
    { limit: 100, multiplier: 2 },
    { limit: 200, multiplier: 1.5 },
  ],
  Arfast: [
    { limit: 15, multiplier: 3 },
    { limit: 40, multiplier: 1.5 },
  ],
  Aicom: [
    { limit: 25, multiplier: 2 },
  ],
};

function canonicalStoreName(value: string): string {
  return STORE_NAME_MAP.get(value.trim().toLowerCase()) ?? '';
}

function parseStoredPurchasePool(raw: string | null): SalesSuggestionRow[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as SalesSuggestionRow[] : [];
  } catch {
    return [];
  }
}

function mergePurchasePoolRows(rows: SalesSuggestionRow[]): SalesSuggestionRow[] {
  const next = new Map<string, SalesSuggestionRow>();
  for (const row of rows) {
    next.set(`${row.shopName.trim().toLowerCase()}|${row.sku.trim().toUpperCase()}`, row);
  }
  return Array.from(next.values());
}

function loadStoredPurchasePool(): SalesSuggestionRow[] {
  const rows = parseStoredPurchasePool(localStorage.getItem(SHARED_PURCHASE_POOL_STORAGE_KEY));
  const legacyKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(PURCHASE_POOL_STORAGE_PREFIX) || key === SHARED_PURCHASE_POOL_STORAGE_KEY) continue;
    rows.push(...parseStoredPurchasePool(localStorage.getItem(key)));
    legacyKeys.push(key);
  }
  const mergedRows = mergePurchasePoolRows(rows);
  if (legacyKeys.length > 0) {
    localStorage.setItem(SHARED_PURCHASE_POOL_STORAGE_KEY, JSON.stringify(mergedRows));
    legacyKeys.forEach((key) => localStorage.removeItem(key));
  }
  return mergedRows;
}

function clearStoredPurchasePool() {
  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(PURCHASE_POOL_STORAGE_PREFIX)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

function rawField(row: TakealotInventoryRow, keys: string[]): string {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw as Record<string, unknown> : {};
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return '';
}

function applySuggestedQuantityMinimum(monthlySales: number, quantity: number): number {
  if (monthlySales > 5 && quantity > 0 && quantity < 30) return 30;
  return quantity;
}

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

function newProductMultiplierForRank(storeName: string, rank: number): number {
  const rule = NEW_PRODUCT_RULES[storeName]?.find((item) => rank > 0 && rank <= item.limit);
  return rule?.multiplier ?? 1;
}

function aicomDirectTargetQuantity(rank: number, rawMonthlySales: number): { targetQuantity: number; message: string } | null {
  if (rank <= 0 || rank > 15) return null;
  if (rawMonthlySales <= 3) {
    return {
      targetQuantity: 0,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，未超过 3，暂不补订`,
    };
  }
  if (rawMonthlySales <= 5) {
    return {
      targetQuantity: 40,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 40 个`,
    };
  }
  if (rawMonthlySales <= 8) {
    return {
      targetQuantity: 50,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 50 个`,
    };
  }
  return {
    targetQuantity: 60,
    message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，目标补货 60 个`,
  };
}

function forecastMonthlySales(storeName: string, rank: number, rawMonthlySales: number): { monthlySales: number; message: string } {
  if (storeName === 'Aicom' && rank > 0 && rank <= 15) {
    return { monthlySales: rawMonthlySales, message: '' };
  }

  const multiplier = newProductMultiplierForRank(storeName, rank);
  if (multiplier > 1 && rawMonthlySales > 0) {
    return {
      monthlySales: rawMonthlySales * multiplier,
      message: `新品预测：第 ${rank} 新，原始销量 ${rawMonthlySales}，按 ${multiplier} 倍预测`,
    };
  }
  return { monthlySales: rawMonthlySales, message: '' };
}

function buildNewProductRankMap(storeName: string, rows: TakealotInventoryRow[]): Map<string, number> {
  if (!NEW_PRODUCT_RULES[storeName]) return new Map();
  const sortedSkus = rows
    .map((row) => row.sku.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
  const ranks = new Map<string, number>();
  [...sortedSkus].reverse().forEach((sku, index) => {
    ranks.set(skuKey(sku), index + 1);
  });
  return ranks;
}

function hasMissingSkuData(row: SalesSuggestionRow): boolean {
  return row.messages.some((message) => /未录入\s*SKU\s*资料/i.test(message));
}

function hasSeasonalWarning(row: SalesSuggestionRow): boolean {
  return row.messages.some((message) => message.includes('季节性产品'));
}

function sortSuggestionRows(rows: SalesSuggestionRow[]): SalesSuggestionRow[] {
  return [...rows].sort((a, b) => (
    b.suggestedQuantity - a.suggestedQuantity
    || b.monthlySales - a.monthlySales
    || skuKey(a.sku).localeCompare(skuKey(b.sku))
  ));
}

function isInTransitStatus(status: string): boolean {
  return ['in_transit', 'ordered', '海运在途', '已下单'].includes(status);
}

export function SalesSuggestionPage({ skuItems, purchaseRecords, onSendToCalculator, canEditData = true, savedSuggestions = [] }: Props) {
  const [salesRows, setSalesRows] = useState<PurchaseRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [selectedStore, setSelectedStore] = useState('');
  const [inventoryRows, setInventoryRows] = useState<TakealotInventoryRow[]>([]);
  const [purchasePool, setPurchasePool] = useState<SalesSuggestionRow[]>(loadStoredPurchasePool);
  const [syncMessage, setSyncMessage] = useState('');
  const [suggestedQuantityDrafts, setSuggestedQuantityDrafts] = useState<Record<string, string>>({});
  const [suggestedQuantityOverrides, setSuggestedQuantityOverrides] = useState<Record<string, number>>({});
  const [isSyncingTakealot, setIsSyncingTakealot] = useState(false);

  const storeOptions = useMemo(() => {
    const extraNames = skuItems
      .map((item) => canonicalStoreName(item.shopName))
      .filter(Boolean);
    const savedNames = savedSuggestions
      .map((row) => canonicalStoreName(row.shopName))
      .filter(Boolean);
    return Array.from(new Set([...savedNames, ...DEFAULT_STORES, ...extraNames]));
  }, [savedSuggestions, skuItems]);

  useEffect(() => {
    if (selectedStore && !storeOptions.includes(selectedStore)) setSelectedStore('');
  }, [selectedStore, storeOptions]);

  useEffect(() => {
    localStorage.setItem(SHARED_PURCHASE_POOL_STORAGE_KEY, JSON.stringify(purchasePool));
  }, [purchasePool]);

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
      setIsSyncingTakealot(true);
      setSyncMessage(`正在同步 ${selectedStore} Takealot 库存...`);
      const rows = await fetchTakealotInventory(selectedStore, []);
      setInventoryRows(rows);
      setSalesRows([]);
      setSyncMessage(`已同步 ${rows.length} 条 ${selectedStore} Takealot 库存。`);
    } catch (error) {
      console.error(error);
      setSyncMessage(error instanceof Error ? error.message : 'Takealot 库存同步失败');
    } finally {
      setIsSyncingTakealot(false);
    }
  }

  const suggestions = useMemo<SalesSuggestionRow[]>(() => {
    const skuMap = new Map(skuItems.filter((item) => skuKey(item.sku)).map((item) => [skuKey(item.sku), item]));
    const inventoryMap = new Map(inventoryRows.map((item) => [item.sku.trim().toUpperCase(), item]));
    const newProductRankMap = buildNewProductRankMap(selectedStore, inventoryRows);
    const inTransitBySku = new Map<string, number>();

    for (const record of purchaseRecords) {
      if (!isInventoryRecord(record)) continue;
      if (!isInTransitStatus(record.status)) continue;
      const normalized = withPurchaseTotals(record);
      const key = skuKey(normalized.sku);
      inTransitBySku.set(key, (inTransitBySku.get(key) ?? 0) + effectivePurchaseQuantity(normalized));
      for (const line of normalized.mixedGroups.flatMap((group) => group.lines).filter((mixedLine) => skuKey(mixedLine.sku))) {
        const mixedKey = skuKey(line.sku);
        inTransitBySku.set(mixedKey, (inTransitBySku.get(mixedKey) ?? 0) + line.quantity);
      }
    }

    const applySavedOverride = (row: SalesSuggestionRow): SalesSuggestionRow => {
      const inTransitQuantity = inTransitBySku.get(skuKey(row.sku)) ?? row.inTransitQuantity;
      const rawAutoSuggestedQuantity = Math.max(round(
        row.targetQuantity
        - row.localStockQuantity
        - row.takealotStockQuantity
        - row.stockOnWayQuantity
        - inTransitQuantity,
        2,
      ), 0);
      const autoSuggestedQuantity = applySuggestedQuantityMinimum(row.monthlySales, rawAutoSuggestedQuantity);
      const override = suggestedQuantityOverrides[row.rowId];
      const suggestedQuantity = override ?? autoSuggestedQuantity;
      const ratio = row.suggestedQuantity > 0 ? suggestedQuantity / row.suggestedQuantity : 0;
      return {
        ...row,
        inTransitQuantity,
        suggestedQuantity,
        estimatedCartons: row.estimatedCartons !== null && row.estimatedCartons !== undefined && ratio > 0 ? round(row.estimatedCartons * ratio, 2) : row.estimatedCartons,
        estimatedCbm: row.estimatedCbm !== null && row.estimatedCbm !== undefined && ratio > 0 ? round(row.estimatedCbm * ratio, 4) : row.estimatedCbm,
      };
    };

    if (inventoryRows.length === 0 && salesRows.length === 0 && savedSuggestions.length > 0) {
      const rows = selectedStore
        ? savedSuggestions.filter((row) => canonicalStoreName(row.shopName) === selectedStore)
        : savedSuggestions;
      return sortSuggestionRows(rows.map(applySavedOverride));
    }

    const sourceRows = inventoryRows.length > 0
      ? inventoryRows.map((row, index) => ({
        rowId: `takealot-${row.shopName}-${row.sku || index}`,
        sku: row.sku,
        productName: rawField(row, ['title', 'product_title', 'name']),
        imageUrl: row.imageUrl,
        shopName: selectedStore,
        purchaseQuantity: row.apiSalesQuantity,
        inventory: row,
      }))
      : salesRows.map((row) => ({
        rowId: row.rowId,
        sku: row.sku,
        productName: row.productName,
        imageUrl: '',
        shopName: selectedStore,
        purchaseQuantity: row.purchaseQuantity ?? 0,
        inventory: inventoryMap.get(row.sku.trim().toUpperCase()),
      }));

    return sortSuggestionRows(sourceRows.map((row) => {
      const key = skuKey(row.sku);
      const skuItem = skuMap.get(key);
      const inventory = row.inventory ?? inventoryMap.get(key);
      const rawMonthlySales = inventory?.apiSalesQuantity ?? row.purchaseQuantity ?? 0;
      const newProductRank = newProductRankMap.get(key) ?? 0;
      const forecast = forecastMonthlySales(selectedStore, newProductRank, rawMonthlySales);
      const monthlySales = forecast.monthlySales;
      const stockMonths = stockMonthsForMonthlySales(monthlySales);
      const calculatedTargetQuantity = round(monthlySales * stockMonths, 2);
      const localStockQuantity = inventory?.localStockQuantity ?? 0;
      const takealotStockQuantity = inventory?.takealotStockQuantity ?? 0;
      const stockOnWayQuantity = inventory?.stockOnWayQuantity ?? 0;
      const inTransitQuantity = inTransitBySku.get(key) ?? 0;
      const directTarget = selectedStore === 'Aicom' ? aicomDirectTargetQuantity(newProductRank, rawMonthlySales) : null;
      const targetQuantity = directTarget?.targetQuantity ?? calculatedTargetQuantity;
      const rawAutoSuggestedQuantity = Math.max(round(
        targetQuantity - localStockQuantity - takealotStockQuantity - stockOnWayQuantity - inTransitQuantity,
        2,
      ), 0);
      const autoSuggestedQuantity = applySuggestedQuantityMinimum(monthlySales, rawAutoSuggestedQuantity);
      const suggestedQuantity = suggestedQuantityOverrides[row.rowId] ?? autoSuggestedQuantity;
      const estimatedCartons =
        skuItem && skuItem.unitsPerCarton > 0 ? round(suggestedQuantity / skuItem.unitsPerCarton, 2) : null;
      const estimatedCbm =
        skuItem && skuItem.unitCbm > 0
          ? round(suggestedQuantity * skuItem.unitCbm, 4)
          : null;
      const messages: string[] = [];

      if (!row.sku.trim()) messages.push('SKU 为空');
      if (!skuItem && row.sku.trim()) messages.push('未录入 SKU 资料');
      if (skuItem?.isSeasonal) messages.push('季节性产品，请结合旺季/淡季人工确认采购量');
      if (directTarget?.message) {
        messages.push(`${directTarget.message}，扣减库存和海运在途后建议 ${autoSuggestedQuantity} 个`);
      } else if (forecast.message) {
        messages.push(forecast.message);
      }

      return {
        rowId: row.rowId,
        sku: row.sku,
        productName: skuItem?.englishName || skuItem?.productName || row.productName || '',
        imageUrl: row.imageUrl,
        shopName: row.shopName || selectedStore || skuItem?.shopName || '',
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
    }));
  }, [inventoryRows, purchaseRecords, salesRows, savedSuggestions, selectedStore, skuItems, suggestedQuantityOverrides]);

  const poolSummary = useMemo(() => {
    return {
      count: purchasePool.length,
      quantity: round(purchasePool.reduce((sum, row) => sum + row.suggestedQuantity, 0), 2),
      cbm: round(purchasePool.reduce((sum, row) => sum + (row.estimatedCbm ?? 0), 0), 4),
    };
  }, [purchasePool]);
  const groupedPurchasePool = useMemo(() => {
    const groups = new Map<string, SalesSuggestionRow[]>();
    for (const row of purchasePool) {
      const store = row.shopName || '未分配店铺';
      groups.set(store, [...(groups.get(store) ?? []), row]);
    }
    return Array.from(groups.entries()).map(([store, rows]) => ({
      store,
      rows,
      quantity: round(rows.reduce((sum, row) => sum + row.suggestedQuantity, 0), 2),
      cbm: round(rows.reduce((sum, row) => sum + (row.estimatedCbm ?? 0), 0), 4),
    }));
  }, [purchasePool]);

  function validSuggestionRows(rows: SalesSuggestionRow[]) {
    return rows.filter((row) => row.suggestedQuantity > 0 && !hasMissingSkuData(row));
  }

  function suggestedQuantityInputValue(row: SalesSuggestionRow) {
    return suggestedQuantityDrafts[row.rowId] ?? String(row.suggestedQuantity);
  }

  function commitSuggestedQuantity(row: SalesSuggestionRow) {
    const draft = suggestedQuantityDrafts[row.rowId];
    if (draft === undefined) return;
    const parsed = Number(draft);
    setSuggestedQuantityDrafts((current) => {
      const next = { ...current };
      delete next[row.rowId];
      return next;
    });
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const quantity = round(parsed, 2);
    setSuggestedQuantityOverrides((current) => ({ ...current, [row.rowId]: quantity }));
    setPurchasePool((current) => current.map((item) => {
      if (item.rowId !== row.rowId) return item;
      const ratio = item.suggestedQuantity > 0 ? quantity / item.suggestedQuantity : 0;
      return {
        ...item,
        suggestedQuantity: quantity,
        estimatedCartons: item.estimatedCartons !== null && item.estimatedCartons !== undefined && ratio > 0 ? round(item.estimatedCartons * ratio, 2) : item.estimatedCartons,
        estimatedCbm: item.estimatedCbm !== null && item.estimatedCbm !== undefined && ratio > 0 ? round(item.estimatedCbm * ratio, 4) : item.estimatedCbm,
      };
    }));
  }

  function addCurrentStoreToPool() {
    if (!canEditData) return;
    const rows = validSuggestionRows(suggestions);
    if (rows.length === 0) {
      setSyncMessage('当前店铺没有可加入采购池的建议采购数量。');
      return;
    }

    setPurchasePool((current) => {
      const next = new Map(current.map((row) => [`${row.shopName.trim().toLowerCase()}|${row.sku.trim().toUpperCase()}`, row]));
      for (const row of rows) {
        next.set(`${row.shopName.trim().toLowerCase()}|${row.sku.trim().toUpperCase()}`, row);
      }
      return Array.from(next.values());
    });
    setSyncMessage(`已把 ${selectedStore} 的 ${rows.length} 条建议加入本轮采购池。`);
  }

  function removePoolRow(rowId: string) {
    setPurchasePool((current) => current.filter((row) => row.rowId !== rowId));
  }

  function clearPurchasePool() {
    clearStoredPurchasePool();
    setPurchasePool([]);
    setSyncMessage('已清空本轮采购池。');
  }

  function toCalculatorRows(sourceRows: SalesSuggestionRow[]): PurchaseRow[] {
    return validSuggestionRows(sourceRows)
      .filter((row) => row.suggestedQuantity > 0 && !hasMissingSkuData(row))
      .map((row, index) => ({
        rowId: `${Date.now()}-suggestion-${index}`,
        rowNumber: index + 2,
        sku: row.sku,
        productName: row.productName,
        englishName: '',
        imageUrl: row.imageUrl,
        manufacturerName: row.manufacturerName,
        shopName: row.shopName,
        purchaseQuantity: row.suggestedQuantity,
        raw: { source: 'sales-suggestion', shopName: row.shopName, monthlySales: row.monthlySales, stockMonths: row.stockMonths, imageUrl: row.imageUrl },
      }));
  }

  function sendPoolToCalculator() {
    const rows = toCalculatorRows(purchasePool);
    const shouldClearPool = canEditData && rows.length > 0;
    if (canEditData && rows.length > 0) onSendToCalculator(rows, `本轮采购池-${new Date().toISOString().slice(0, 10)}`);
    if (shouldClearPool) {
      clearStoredPurchasePool();
      setPurchasePool([]);
    }
  }

  function sendCurrentToCalculator() {
    const rows = toCalculatorRows(suggestions);
    if (canEditData && rows.length > 0) onSendToCalculator(rows, fileName ? `采购建议：${fileName}` : '采购建议');
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>月销量生成采购建议</h2>
          <p>根据月销量自动设置备货月数，并结合当前库存和海运在途计算建议采购数量。</p>
        </div>
        <div className="export-actions">
          <label className="file-button">
            上传月销量
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} />
          </label>
          <button type="button" onClick={addCurrentStoreToPool} disabled={!canEditData || validSuggestionRows(suggestions).length === 0}>
            加入本轮采购池
          </button>
          <button className="primary" type="button" onClick={sendPoolToCalculator} disabled={!canEditData || purchasePool.length === 0}>
            发送采购池到装柜计算
          </button>
          <button type="button" onClick={clearPurchasePool} disabled={!canEditData || purchasePool.length === 0}>
            清空采购池
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
            <option value="">全部店铺</option>
            {storeOptions.map((store) => <option key={store} value={store}>{store}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void syncTakealotInventory()} disabled={!selectedStore || isSyncingTakealot}>同步 Takealot 库存</button>
        <span>{fileName ? `当前文件：${fileName}` : stockMonthsRuleDescription()}</span>
      </div>
      {syncMessage && <div className="inline-notice">{syncMessage}</div>}

      {purchasePool.length > 0 && (
        <section className="pool-panel">
          <div className="section-heading compact-heading">
            <div>
              <h3>本轮采购池</h3>
              <p>已加入 {poolSummary.count} 条，建议采购数量 {poolSummary.quantity}，预计 {poolSummary.cbm.toFixed(4)} CBM。切换店铺继续同步并加入，最后统一发送到装柜计算。</p>
            </div>
            <div className="export-actions">
              <button type="button" onClick={clearPurchasePool}>清空采购池</button>
              <button type="button" onClick={sendCurrentToCalculator} disabled={!canEditData || validSuggestionRows(suggestions).length === 0}>仅发送当前店铺</button>
            </div>
          </div>
          <div className="table-wrap suggestion-pool-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th><th>产品名称</th><th>月销量</th><th>建议采购数量</th><th>预计 CBM</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {groupedPurchasePool.map((group) => (
                  <Fragment key={group.store}>
                    <tr className="pool-store-row">
                      <td colSpan={6}>{group.store}：{group.rows.length} 条，建议采购数量 {group.quantity}，预计 {group.cbm.toFixed(4)} CBM</td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.rowId}>
                        <td>{row.sku || '-'}</td>
                        <td><div className="suggestion-name-text" title={row.productName || ''}>{row.productName || '-'}</div></td>
                        <td>{row.monthlySales}</td>
                        <td>{row.suggestedQuantity}</td>
                        <td>{row.estimatedCbm?.toFixed(4) ?? '-'}</td>
                        <td><button type="button" onClick={() => removePoolRow(row.rowId)}>移除</button></td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="table-wrap suggestion-table-wrap">
        <table className="suggestion-table">
          <thead>
            <tr>
              <th className="suggestion-sticky suggestion-sticky-1">图片</th><th className="suggestion-sticky suggestion-sticky-2">SKU</th><th className="suggestion-sticky suggestion-sticky-3">产品名称</th><th>月销量</th><th>南非本地库存</th><th>官方仓库存</th><th>送仓路上库存</th><th>海运在途数量</th><th>建议采购数量</th><th>采购人</th><th>预计 CBM</th><th>状态/备注</th><th>店铺</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((row) => (
              <tr key={row.rowId} className={hasMissingSkuData(row) ? 'error-row' : hasSeasonalWarning(row) ? 'seasonal-row' : ''}>
                <td className="suggestion-sticky suggestion-sticky-1">{row.imageUrl ? <img className="sku-thumb" src={row.imageUrl} alt={row.productName || row.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                <td className="suggestion-sticky suggestion-sticky-2">{row.sku || '-'}</td>
                <td className="suggestion-sticky suggestion-sticky-3"><div className="suggestion-name-text" title={row.productName || ''}>{row.productName || '-'}</div></td>
                <td>{row.monthlySales}</td>
                <td>{row.localStockQuantity}</td>
                <td>{row.takealotStockQuantity}</td>
                <td>{row.stockOnWayQuantity}</td>
                <td>{row.inTransitQuantity}</td>
                <td>
                  <input
                    className="quantity-input compact-input"
                    type="number"
                    min="0"
                    step="1"
                    value={suggestedQuantityInputValue(row)}
                    disabled={!canEditData}
                    onChange={(event) => setSuggestedQuantityDrafts((current) => ({ ...current, [row.rowId]: event.target.value }))}
                    onBlur={() => commitSuggestedQuantity(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </td>
                <td>{row.buyerName || '-'}</td>
                <td>{row.estimatedCbm?.toFixed(4) ?? '-'}</td>
                <td>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</td>
                <td>{row.shopName || '-'}</td>
              </tr>
            ))}
            {suggestions.length === 0 && <tr><td colSpan={13} className="empty">上传月销量或手动同步 Takealot 库存后生成采购建议。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
