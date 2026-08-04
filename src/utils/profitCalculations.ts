import type { ProfitAnalysisRow, SkuItem, TakealotSale } from '../types';
import type { TakealotInventoryRow } from './takealot';
import { round } from './number';
import { canonicalShopName } from './shops';

export const PURCHASE_COST_EXCHANGE_RATE = 3;
export const SEA_FREIGHT_RATE_PER_CBM = 3600;

export function calculateWarehouseFee(seaFreightCost: number): number {
  return seaFreightCost > 0 ? round(Math.ceil(seaFreightCost / 15) * 10, 2) : 0;
}

export function calculateBaseProductCosts(purchaseCostRmb: number, unitCbm: number) {
  const purchaseCostZar = round(purchaseCostRmb * PURCHASE_COST_EXCHANGE_RATE, 2);
  const seaFreightCost = round(unitCbm * SEA_FREIGHT_RATE_PER_CBM, 2);
  return { purchaseCostZar, seaFreightCost, warehouseFee: calculateWarehouseFee(seaFreightCost) };
}

function key(value: string): string {
  return value.trim().toUpperCase();
}

export function isExcludedSaleStatus(status: string): boolean {
  return /cancel(?:led)?|return(?:ed)?|refund(?:ed)?/i.test(status);
}

export function latestValidSalesBySku(sales: TakealotSale[]): Map<string, TakealotSale> {
  const result = new Map<string, TakealotSale>();
  for (const sale of sales) {
    const sku = key(sale.sku);
    const hasUsableFees = sale.totalFees !== null && sale.totalFees > 0;
    const hasUsableQuantity = Number.isFinite(sale.quantity) && sale.quantity > 0;
    if (!sku || isExcludedSaleStatus(sale.saleStatus) || !hasUsableFees || !hasUsableQuantity) continue;
    const current = result.get(sku);
    if (!current) {
      result.set(sku, sale);
      continue;
    }
    const saleIsSingle = sale.quantity === 1;
    const currentIsSingle = current.quantity === 1;
    if ((saleIsSingle && !currentIsSingle)
      || (saleIsSingle === currentIsSingle && Date.parse(sale.orderDate) > Date.parse(current.orderDate))) {
      result.set(sku, sale);
    }
  }
  return result;
}

export function buildProfitAnalysisRows(input: {
  runId: string;
  shopName: string;
  syncedAt: string;
  offers: TakealotInventoryRow[];
  sales: TakealotSale[];
  skuItems: SkuItem[];
}): ProfitAnalysisRow[] {
  const shopName = canonicalShopName(input.shopName);
  const skuMap = new Map(input.skuItems
    .filter((item) => canonicalShopName(item.shopName) === shopName && key(item.sku))
    .map((item) => [key(item.sku), item]));
  const salesMap = latestValidSalesBySku(input.sales);

  const offersBySku = new Map(input.offers.filter((offer) => key(offer.sku)).map((offer) => [key(offer.sku), offer]));
  return [...offersBySku.values()].map((offer) => {
    const normalizedSku = key(offer.sku);
    const skuItem = skuMap.get(normalizedSku);
    const sale = salesMap.get(normalizedSku);
    const purchaseCostRmb = skuItem && skuItem.purchasePrice > 0 ? round(skuItem.purchasePrice, 2) : null;
    const rawUnitCbm = skuItem ? (skuItem.unitCbm || skuItem.manualUnitCbm) : 0;
    const unitCbm = rawUnitCbm > 0 ? round(rawUnitCbm, 8) : null;
    const saleQuantity = sale && Number.isFinite(sale.quantity) && sale.quantity > 0 ? sale.quantity : null;
    const sellingPrice = sale?.sellingPrice !== null && sale?.sellingPrice !== undefined && sale.sellingPrice > 0 && saleQuantity !== null
      ? round(sale.sellingPrice / saleQuantity, 2)
      : null;
    const totalFees = sale?.totalFees !== null && sale?.totalFees !== undefined && sale.totalFees >= 0 ? round(sale.totalFees, 2) : null;
    const messages: string[] = [];
    if (!skuItem) messages.push('未匹配 SKU 资料库');
    if (!sale) messages.push('最近180天无 Total Fees 大于 0 的有效成交');
    if (sale && saleQuantity === null) messages.push('最近成交购买数量无效');
    if (sale && sellingPrice === null && saleQuantity !== null) messages.push('最近成交售价缺失');
    if (sale && totalFees === null) messages.push('Total Fees 缺失');
    if (purchaseCostRmb === null) messages.push('采购单价缺失');
    if (unitCbm === null) messages.push('单品 CBM 缺失');

    const costs = purchaseCostRmb !== null && unitCbm !== null
      ? calculateBaseProductCosts(purchaseCostRmb, unitCbm)
      : null;
    const canCalculate = sellingPrice !== null && totalFees !== null && costs !== null;
    const profit = canCalculate
      ? round(sellingPrice - costs.purchaseCostZar - costs.seaFreightCost - totalFees - costs.warehouseFee, 2)
      : null;
    const status = profit === null ? 'missing_data' : profit > 0 ? 'profit' : profit < 0 ? 'loss' : 'break_even';

    return {
      id: `${input.runId}-${normalizedSku}`,
      runId: input.runId,
      shopName,
      sku: offer.sku,
      productName: skuItem?.englishName || skuItem?.productName || String((offer.raw as Record<string, unknown> | undefined)?.title ?? ''),
      imageUrl: skuItem?.imageUrl || offer.imageUrl,
      latestOrderDate: sale?.orderDate ?? '',
      sellingPrice,
      purchaseCostRmb,
      purchaseCostZar: costs?.purchaseCostZar ?? null,
      unitCbm,
      seaFreightCost: costs?.seaFreightCost ?? null,
      warehouseFee: costs?.warehouseFee ?? null,
      totalFees,
      profit,
      status,
      messages,
      syncedAt: input.syncedAt,
    };
  });
}
