import type { CalculationRow, ContainerSummary, PurchaseRow, SkuItem } from '../types';
import { round } from './number';

export const CONTAINER_CBM = 68;
export const TARGET_CBM = 70;

export function calcCartonCbm(lengthCm: number, widthCm: number, heightCm: number): number {
  if (lengthCm <= 0 || widthCm <= 0 || heightCm <= 0) return 0;
  return round((lengthCm * widthCm * heightCm) / 1_000_000, 6);
}

export function calcUnitCbm(cartonCbm: number, unitsPerCarton: number): number {
  if (cartonCbm <= 0 || unitsPerCarton <= 0) return 0;
  return round(cartonCbm / unitsPerCarton, 8);
}

export function hydrateSku(item: Omit<SkuItem, 'cartonCbm' | 'unitCbm'>): SkuItem {
  const cartonCbm = calcCartonCbm(item.cartonLengthCm, item.cartonWidthCm, item.cartonHeightCm);
  const unitCbmFromManual = item.manualUnitCbm > 0 ? round(item.manualUnitCbm, 8) : 0;
  const unitCbmFromTotal = item.totalQuantity > 0 && item.totalCbm > 0 ? round(item.totalCbm / item.totalQuantity, 8) : 0;
  const unitCbmFromCarton = calcUnitCbm(cartonCbm, item.unitsPerCarton);
  const unitCbm = unitCbmFromManual || unitCbmFromTotal || unitCbmFromCarton;
  const cbmSource = unitCbmFromManual ? 'imported' : unitCbmFromTotal ? 'total' : unitCbmFromCarton ? 'carton' : 'missing';
  return {
    ...item,
    cartonCbm,
    unitCbm,
    cbmSource,
  };
}

export function calculateRows(purchases: PurchaseRow[], skuItems: SkuItem[]): CalculationRow[] {
  const skuMap = new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item]));

  return purchases.map((purchase) => {
    const messages: string[] = [];
    const normalizedSku = purchase.sku.trim().toUpperCase();
    const skuItem = skuMap.get(normalizedSku);

    const quantityValid =
      purchase.purchaseQuantity === null ||
      !Number.isFinite(purchase.purchaseQuantity) ||
      purchase.purchaseQuantity <= 0
        ? false
        : true;

    if (!skuItem && purchase.sku.trim()) {
      messages.push('SKU未录入资料库');
    }

    if (!purchase.sku.trim()) {
      messages.push('SKU为空');
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
      if (skuItem.unitsPerCarton <= 0) {
        messages.push('每箱数量错误，无法计算单品CBM');
      }

      if (skuItem.cartonLengthCm <= 0 || skuItem.cartonWidthCm <= 0 || skuItem.cartonHeightCm <= 0) {
        messages.push('缺少包装尺寸，无法计算CBM');
      }
    }

    const totalCbm = skuItem && quantityValid && hasValidUnitCbm
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
      sku: purchase.sku,
      manufacturerName: skuItem?.manufacturerName ?? '',
      productName: skuItem?.productName ?? '',
      englishName: skuItem?.englishName ?? '',
      shopName: skuItem?.shopName ?? '',
      buyerName: skuItem?.buyerName ?? '',
      purchaseQuantity: purchase.purchaseQuantity,
      purchasePrice: skuItem?.purchasePrice ?? null,
      totalAmount,
      unitCbm: skuItem?.unitCbm ?? null,
      totalCbm,
      status: messages.length > 0 ? 'error' : totalCbm && totalCbm > 0 ? 'ok' : 'warning',
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
