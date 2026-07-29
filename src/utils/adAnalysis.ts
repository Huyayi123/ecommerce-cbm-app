import type { AdAnalysisRow, AdStrategyLabel, SkuItem } from '../types';
import type { AdReportImportRow } from './fileParsers';
import { round } from './number';
import { canonicalShopName } from './shops';
import type { TakealotInventoryRow } from './takealot';

const PURCHASE_COST_EXCHANGE_RATE = 3;
const SEA_FREIGHT_RATE_PER_CBM = 3600;
const PLATFORM_FEE_FALLBACK_RATE = 0.4;

const NEW_PRODUCT_LIMITS: Record<string, { protection: number; newProduct: number }> = {
  Bestby: { protection: 60, newProduct: 200 },
  Arfast: { protection: 15, newProduct: 40 },
  Aicom: { protection: 15, newProduct: 25 },
};

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

function tsinKey(value: string): string {
  return value.trim().toUpperCase();
}

function storeKey(value: string): string {
  return canonicalShopName(value).trim().toLowerCase();
}

function strategy(label: AdStrategyLabel): { strategyName: string; actionSuggestion: string } {
  const rules: Record<AdStrategyLabel, { strategyName: string; actionSuggestion: string }> = {
    no_profit: { strategyName: '无利润产品', actionSuggestion: '不进行广告投放，避免广告进一步扩大亏损' },
    green_star: { strategyName: 'Green Star', actionSuggestion: '高效盈利产品，建议增加广告预算，扩大销售规模' },
    yellow_cow: { strategyName: 'Yellow Cow', actionSuggestion: '表现良好产品，建议保持广告投入，持续优化' },
    orange_question: { strategyName: 'Orange Question Mark', actionSuggestion: '效率一般产品，建议优化关键词、竞价和 Listing，提高 ROAS' },
    loss_product: { strategyName: '亏损产品', actionSuggestion: '建议停止广告，暂停投入并分析产品竞争力' },
    new_test: { strategyName: '新品保护期', actionSuggestion: '允许测试广告，先获取市场数据' },
    new_optimize: { strategyName: '新品优化期', actionSuggestion: '结合 ROAS、转化率、排名情况继续优化' },
    missing_data: { strategyName: '数据不足', actionSuggestion: '补齐售价、采购成本、ROAS 或广告销量后再判断' },
  };
  return rules[label];
}

function adLabel(profitRate: number | null, roas: number | null): AdStrategyLabel {
  if (roas === null) return 'missing_data';
  if (profitRate === null) return roasLabel(roas);
  if (profitRate <= 0) return 'no_profit';
  return roasLabel(roas);
}

function roasLabel(roas: number): AdStrategyLabel {
  if (roas <= 2) return 'loss_product';
  if (roas > 10) return 'green_star';
  if (roas > 5) return 'yellow_cow';
  return 'orange_question';
}

function buildSkuRankMap(items: SkuItem[]): Map<string, number> {
  const byStore = new Map<string, string[]>();
  for (const item of items) {
    const sku = item.sku.trim();
    const store = item.shopName.trim();
    if (!sku || !store || Number.isNaN(Number(sku))) continue;
    const key = storeKey(store);
    byStore.set(key, [...(byStore.get(key) ?? []), sku]);
  }

  const ranks = new Map<string, number>();
  for (const [store, skus] of byStore.entries()) {
    [...new Set(skus)]
      .sort((left, right) => Number(right) - Number(left))
      .forEach((sku, index) => ranks.set(`${store}|${skuKey(sku)}`, index + 1));
  }
  return ranks;
}

function productAgeStatus(shopName: string, rank: number | null): AdAnalysisRow['productAgeStatus'] {
  if (!rank) return 'unknown';
  const limits = NEW_PRODUCT_LIMITS[canonicalShopName(shopName)];
  if (!limits) return 'old';
  if (rank <= limits.protection) return 'protection';
  if (rank <= limits.newProduct) return 'new';
  return 'old';
}

function applyNewProductPolicy(label: AdStrategyLabel, ageStatus: AdAnalysisRow['productAgeStatus'], profitRate: number | null): AdStrategyLabel {
  if (ageStatus === 'protection') return 'new_test';
  if (ageStatus === 'new' && profitRate !== null && profitRate >= -0.15) return 'loss_product';
  if (ageStatus === 'new') return 'new_optimize';
  return label;
}

export function analyzeAdRows(input: {
  runId: string;
  reportRows: AdReportImportRow[];
  skuItems: SkuItem[];
  inventoryRows: TakealotInventoryRow[];
}): AdAnalysisRow[] {
  const skuItemsBySku = new Map(input.skuItems.filter((item) => skuKey(item.sku)).map((item) => [skuKey(item.sku), item]));
  const skuItemsByTsin = new Map(input.skuItems.filter((item) => tsinKey(item.tsin)).map((item) => [tsinKey(item.tsin), item]));
  const inventoryBySku = new Map(input.inventoryRows.filter((item) => skuKey(item.sku)).map((item) => [skuKey(item.sku), item]));
  const inventoryByTsin = new Map(input.inventoryRows.filter((item) => tsinKey(item.tsin)).map((item) => [tsinKey(item.tsin), item]));
  const rankMap = buildSkuRankMap(input.skuItems);

  return input.reportRows.map((row) => {
    const sku = skuKey(row.sku);
    const skuItem = skuItemsByTsin.get(tsinKey(row.sku)) ?? skuItemsBySku.get(sku);
    const inventory = inventoryByTsin.get(tsinKey(row.sku)) ?? inventoryBySku.get(sku);
    const shopName = canonicalShopName(row.shopName || inventory?.shopName || skuItem?.shopName || '');
    const salePrice = round(inventory?.salePrice ?? 0, 2);
    const purchaseCostRmb = round(skuItem?.purchasePrice ?? 0, 2);
    const purchaseCostZar = round(purchaseCostRmb * PURCHASE_COST_EXCHANGE_RATE, 2);
    const unitCbm = round(skuItem?.unitCbm || skuItem?.manualUnitCbm || 0, 8);
    const seaFreightCost = round(unitCbm * SEA_FREIGHT_RATE_PER_CBM, 2);
    const warehouseFee = seaFreightCost > 0 ? round(Math.ceil(seaFreightCost / 15) * 10, 2) : 0;
    const platformFeeSource = inventory?.platformFee ? 'api' : salePrice > 0 ? 'fallback' : 'missing';
    const platformFee = round(inventory?.platformFee ?? (salePrice > 0 ? salePrice * PLATFORM_FEE_FALLBACK_RATE : 0), 2);
    const adCostPerSale = row.adSalesQuantity > 0 ? round(row.adSpend / row.adSalesQuantity, 2) : 0;
    const canCalculateProfit = salePrice > 0 && purchaseCostZar > 0 && row.roas !== null && row.adSalesQuantity > 0;
    const profitRate = canCalculateProfit
      ? round((salePrice - purchaseCostZar - platformFee - seaFreightCost - adCostPerSale - warehouseFee) / purchaseCostZar, 4)
      : null;
    const rankIdentity = skuItem?.sku || row.sku;
    const skuRank = rankMap.get(`${storeKey(shopName)}|${skuKey(rankIdentity)}`) ?? null;
    const ageStatus = productAgeStatus(shopName, skuRank);
    const baseLabel = adLabel(profitRate, row.roas);
    const strategyLabel = ageStatus === 'old' && row.adSalesQuantity <= 0
      ? 'no_profit'
      : applyNewProductPolicy(baseLabel, ageStatus, profitRate);
    const messages: string[] = [];

    if (!skuItem) messages.push('SKU资料库未找到该 TSIN 对应资料');
    if (purchaseCostRmb <= 0) messages.push('采购成本缺失，无法换算兰特成本');
    if (salePrice <= 0) messages.push('Takealot 售价缺失');
    if (row.roas === null) messages.push('广告报表 ROAS 缺失');
    if (row.adSalesQuantity <= 0) messages.push('广告销量为 0，无法计算单次广告成本');
    if (ageStatus === 'old' && row.adSalesQuantity <= 0) messages.push('老品广告销量为 0，直接判定为广告无利润');
    if (platformFeeSource === 'fallback') messages.push('平台税费用售价 40% 估算');
    if (ageStatus === 'unknown') messages.push('无法根据 TSIN 排名判断新品状态');

    return {
      id: `${input.runId}-${row.rowNumber}-${row.sku || row.productName}`,
      runId: input.runId,
      sku: row.sku,
      productId: row.productId,
      productName: skuItem?.productName || skuItem?.englishName || row.productName,
      shopName,
      imageUrl: row.imageUrl || inventory?.imageUrl || skuItem?.imageUrl || '',
      adSpend: round(row.adSpend, 2),
      adSalesQuantity: row.adSalesQuantity,
      roas: row.roas === null ? null : round(row.roas, 4),
      salePrice,
      platformFee,
      platformFeeSource,
      purchaseCostRmb,
      purchaseCostZar,
      unitCbm,
      seaFreightCost,
      warehouseFee,
      adCostPerSale,
      profitRate,
      skuRank,
      productAgeStatus: ageStatus,
      strategyLabel,
      ...strategy(strategyLabel),
      messages,
    };
  });
}

export function summarizeAdRows(rows: AdAnalysisRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((summary, row) => {
    summary.total = (summary.total ?? 0) + 1;
    summary[row.strategyLabel] = (summary[row.strategyLabel] ?? 0) + 1;
    return summary;
  }, {});
}
