import type { CalculationRow, ContainerSummary, PurchaseRow, SkuItem } from '../types';
import { round } from './number';

export const CONTAINER_CBM = 68;
export const TARGET_CBM = 70;

export function calcCartonCbm(lengthCm: number, widthCm: number, heightCm: number): number {
  if (lengthCm <= 0 || widthCm <= 0 || heightCm <= 0) return 0;
  return round((lengthCm * widthCm * heightCm) / 1_000_000, 8);
}

export function calcUnitCbm(cartonCbm: number, unitsPerCarton: number): number {
  if (cartonCbm <= 0) return 0;
  void unitsPerCarton;
  return round(cartonCbm, 8);
}

type HydratableSku = Omit<SkuItem, 'cartonCbm' | 'unitCbm' | 'storageLocation' | 'purchaseUrl' | 'tsin' | 'internalCode'> & Partial<Pick<SkuItem, 'storageLocation' | 'purchaseUrl' | 'tsin' | 'internalCode'>>;

export function hydrateSku(item: HydratableSku): SkuItem {
  const cartonCbm = calcCartonCbm(item.cartonLengthCm, item.cartonWidthCm, item.cartonHeightCm);
  const unitCbmFromManual = item.manualUnitCbm > 0 ? round(item.manualUnitCbm, 8) : 0;
  const unitCbmFromTotal = item.totalQuantity > 0 && item.totalCbm > 0 ? round(item.totalCbm / item.totalQuantity, 8) : 0;
  const unitCbmFromCarton = calcUnitCbm(cartonCbm, item.unitsPerCarton);
  const unitCbm = unitCbmFromManual || unitCbmFromTotal || unitCbmFromCarton;
  const cbmSource = unitCbmFromManual ? 'imported' : unitCbmFromTotal ? 'total' : unitCbmFromCarton ? 'carton' : 'missing';
  return {
    ...item,
    internalCode: item.internalCode ?? '',
    tsin: item.tsin ?? '',
    storageLocation: item.storageLocation ?? '',
    purchaseUrl: item.purchaseUrl ?? '',
    cartonCbm,
    unitCbm,
    cbmSource,
  };
}

function normalizeMatchValue(value: string): string {
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

type SkuMatchInput = Pick<SkuItem, 'sku' | 'productName' | 'englishName' | 'manufacturerName'>;

export function getSkuMatchKey(input: SkuMatchInput): string {
  const skuKey = normalizeMatchValue(input.sku);
  if (skuKey) {
    return `sku:${skuKey}`;
  }

  const manufacturerKey = normalizeMatchValue(input.manufacturerName);
  const productNameKey = normalizeMatchValue(input.productName);
  if (productNameKey && manufacturerKey) {
    return `product:${productNameKey}:${manufacturerKey}`;
  }

  const englishNameKey = normalizeMatchValue(input.englishName);
  if (englishNameKey && manufacturerKey) {
    return `english:${englishNameKey}:${manufacturerKey}`;
  }

  return '';
}

export function findMatchingSkuItem(input: SkuMatchInput, skuItems: SkuItem[]): SkuItem | undefined {
  const key = getSkuMatchKey(input);
  if (!key) return undefined;
  return skuItems.find((item) => getSkuMatchKey(item) === key);
}

function normalizeShopName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function manualTotalCbmFor(row: PurchaseRow): number | null {
  const value = row.manualTotalCbm ?? row.raw.manualTotalCbm;
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasIdentity(input: Pick<PurchaseRow, 'sku' | 'productName' | 'englishName'>): boolean {
  return Boolean(input.sku.trim() || input.productName.trim() || input.englishName.trim());
}

function hasOnlyCbmWarning(messages: string[]): boolean {
  return messages.length > 0 && messages.every((message) => message === '缺少CBM资料');
}

export function calculateRows(purchases: PurchaseRow[], skuItems: SkuItem[]): CalculationRow[] {
  return purchases.map((purchase) => {
    const messages: string[] = [];
    const sourceShopName = normalizeShopName(purchase.shopName ?? purchase.raw.shopName);
    const scopedSkuItems = sourceShopName
      ? skuItems.filter((item) => normalizeShopName(item.shopName) === sourceShopName)
      : skuItems;
    const skuItem = findMatchingSkuItem(purchase, scopedSkuItems) ?? findMatchingSkuItem(purchase, skuItems);

    const quantityValid =
      purchase.purchaseQuantity === null ||
      !Number.isFinite(purchase.purchaseQuantity) ||
      purchase.purchaseQuantity <= 0
        ? false
        : true;

    if (!skuItem) {
      messages.push(purchase.sku.trim() ? 'SKU未录入资料库' : '未匹配到SKU资料库');
    }

    if (!hasIdentity(purchase)) {
      messages.push('SKU、产品名称、英文名称至少填写一个');
    }

    if (!quantityValid) {
      messages.push('采购数量为空或无效');
    }

    if (skuItem && !skuItem.buyerName.trim()) {
      messages.push('未分配采购人');
    }

    if (skuItem && skuItem.purchasePrice <= 0) {
      messages.push('缺少采购单价');
    }

    const unitCbm = skuItem?.unitCbm ?? 0;
    const hasValidUnitCbm = unitCbm > 0;

    if (skuItem && !hasValidUnitCbm) {
      messages.push('缺少CBM资料');
    }

    const manualTotalCbm = manualTotalCbmFor(purchase);
    const totalCbm = manualTotalCbm !== null
      ? round(manualTotalCbm, 4)
      : skuItem && quantityValid && hasValidUnitCbm
        ? round(purchase.purchaseQuantity! * unitCbm, 4)
        : null;
    const totalAmount =
      purchase.purchaseQuantity !== null &&
      Number.isFinite(purchase.purchaseQuantity) &&
      skuItem &&
      skuItem.purchasePrice > 0
        ? round(purchase.purchaseQuantity * skuItem.purchasePrice, 2)
        : null;

    return {
      rowId: purchase.rowId,
      rowNumber: purchase.rowNumber,
      internalCode: skuItem?.internalCode || purchase.internalCode || '',
      sku: skuItem?.sku || purchase.sku,
      manufacturerName: skuItem?.manufacturerName ?? '',
      productName: skuItem?.productName ?? '',
      englishName: skuItem?.englishName ?? '',
      imageUrl: skuItem?.imageUrl || (typeof purchase.raw.imageUrl === 'string' ? purchase.raw.imageUrl : ''),
      shopName: skuItem?.shopName ?? '',
      buyerName: skuItem?.buyerName ?? '',
      monthlySales: 0,
      localStockQuantity: 0,
      inTransitQuantity: 0,
      purchaseQuantity: purchase.purchaseQuantity,
      purchasePrice: skuItem?.purchasePrice ?? null,
      totalAmount,
      unitCbm: skuItem?.unitCbm ?? null,
      totalCbm,
      status: messages.length === 0
        ? totalCbm && totalCbm > 0 ? 'ok' : 'warning'
        : hasOnlyCbmWarning(messages) ? 'warning' : 'error',
      messages,
    };
  });
}

export function summarize(rows: CalculationRow[]): ContainerSummary {
  const totalCbm = round(
    rows.reduce((sum, row) => sum + (row.totalCbm ?? 0), 0),
    4,
  );
  const remainingCbm = round(TARGET_CBM - totalCbm, 4);
  const usageRate = round((totalCbm / TARGET_CBM) * 100, 2);

  if (totalCbm > TARGET_CBM) {
    return { containerCbm: CONTAINER_CBM, targetCbm: TARGET_CBM, totalCbm, remainingCbm, usageRate, statusText: '超过 70 CBM，需确认柜容或调整采购数量', statusLevel: 'over' };
  }
  if (totalCbm >= CONTAINER_CBM) {
    return { containerCbm: CONTAINER_CBM, targetCbm: TARGET_CBM, totalCbm, remainingCbm, usageRate, statusText: '达到装柜要求，70 CBM 附近更理想', statusLevel: 'good' };
  }
  return { containerCbm: CONTAINER_CBM, targetCbm: TARGET_CBM, totalCbm, remainingCbm, usageRate, statusText: '未满 68 CBM，建议继续加货', statusLevel: 'under' };
}
