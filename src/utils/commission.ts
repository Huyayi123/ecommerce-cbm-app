import type { AppProfile, CommissionBuyerSummary, CommissionDetailRow, CommissionRun, SkuItem, TakealotSale } from '../types';
import { round } from './number';

const ZAR_TO_RMB_DIVISOR = 3;

function key(value: string): string {
  return value.trim().toUpperCase();
}

function skuLookup(items: SkuItem[]): Map<string, SkuItem> {
  const result = new Map<string, SkuItem>();
  for (const item of items) {
    const itemKey = key(item.sku);
    if (itemKey && !result.has(itemKey)) result.set(itemKey, item);
  }
  return result;
}

export function commissionRateForSales(totalSalesZar: number): number {
  if (totalSalesZar > 800000) return 0.015;
  if (totalSalesZar > 400000) return 0.012;
  return 0.01;
}

export function commissionRateLabel(rate: number): string {
  return `${round(rate * 100, 2)}%`;
}

export function buildCommissionRun(input: {
  shopName: string;
  dateFrom: string;
  dateTo: string;
  createdAt: string;
  profile: AppProfile;
  sales: TakealotSale[];
  skuItems: SkuItem[];
}): CommissionRun {
  const runId = crypto.randomUUID();
  const itemsBySku = skuLookup(input.skuItems);
  const grouped = new Map<string, {
    shopName: string;
    sku: string;
    salesQuantity: number;
    salesRevenueZar: number;
    messages: string[];
  }>();

  for (const sale of input.sales) {
    const sku = sale.sku.trim();
    if (!sku) continue;
    const rowKey = key(`${input.shopName}:${sku}`);
    const current = grouped.get(rowKey) ?? { shopName: input.shopName, sku, salesQuantity: 0, salesRevenueZar: 0, messages: [] };
    const quantity = Math.max(0, Number(sale.quantity ?? 0));
    const sellingPrice = sale.sellingPrice === null || sale.sellingPrice === undefined ? null : Number(sale.sellingPrice);
    if (quantity <= 0) current.messages.push('Sales 为空或 0');
    if (sellingPrice === null || !Number.isFinite(sellingPrice) || sellingPrice <= 0) current.messages.push('Selling Price 为空或 0');
    if (quantity > 0 && sellingPrice !== null && Number.isFinite(sellingPrice) && sellingPrice > 0) {
      current.salesQuantity += quantity;
      current.salesRevenueZar += quantity * sellingPrice;
    }
    grouped.set(rowKey, current);
  }

  const draftRows: CommissionDetailRow[] = [...grouped.values()].map((row) => {
    const skuItem = itemsBySku.get(key(row.sku));
    const buyerName = skuItem?.buyerName.trim() ?? '';
    const messages = [...new Set([
      ...row.messages,
      ...(skuItem ? [] : ['SKU 资料库找不到']),
      ...(buyerName ? [] : ['SKU 资料库没有采购人']),
      ...(row.salesRevenueZar > 0 ? [] : ['销售额为 0，未参与提成']),
    ])];
    const salesRevenueZar = round(row.salesRevenueZar, 2);
    const salesRevenueRmb = round(salesRevenueZar / ZAR_TO_RMB_DIVISOR, 2);
    return {
      id: `${runId}-${row.shopName}-${row.sku}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
      runId,
      shopName: row.shopName,
      sku: row.sku,
      internalCode: skuItem?.internalCode ?? '',
      productName: skuItem?.productName ?? '',
      englishName: skuItem?.englishName ?? '',
      imageUrl: skuItem?.imageUrl ?? '',
      buyerName,
      salesQuantity: row.salesQuantity,
      averageSellingPriceZar: row.salesQuantity > 0 ? round(salesRevenueZar / row.salesQuantity, 2) : 0,
      salesRevenueZar,
      salesRevenueRmb,
      commissionRate: 0,
      commissionAmountRmb: 0,
      messages,
    };
  });

  const validRows = draftRows.filter((row) => row.buyerName && row.salesRevenueZar > 0);
  const revenueByBuyer = new Map<string, number>();
  for (const row of validRows) {
    revenueByBuyer.set(row.buyerName, (revenueByBuyer.get(row.buyerName) ?? 0) + row.salesRevenueZar);
  }

  const rows = validRows.map((row) => {
    const commissionRate = commissionRateForSales(revenueByBuyer.get(row.buyerName) ?? 0);
    return {
      ...row,
      commissionRate,
      commissionAmountRmb: round(row.salesRevenueRmb * commissionRate, 2),
    };
  }).sort((left, right) => right.commissionAmountRmb - left.commissionAmountRmb);

  const exceptions = draftRows
    .filter((row) => !row.buyerName || row.salesRevenueZar <= 0)
    .sort((left, right) => left.sku.localeCompare(right.sku));

  const summaryMap = new Map<string, CommissionBuyerSummary>();
  for (const row of rows) {
    const current = summaryMap.get(row.buyerName) ?? {
      buyerName: row.buyerName,
      skuCount: 0,
      salesQuantity: 0,
      salesRevenueZar: 0,
      salesRevenueRmb: 0,
      commissionRate: row.commissionRate,
      commissionAmountRmb: 0,
    };
    current.skuCount += 1;
    current.salesQuantity += row.salesQuantity;
    current.salesRevenueZar += row.salesRevenueZar;
    current.salesRevenueRmb += row.salesRevenueRmb;
    current.commissionRate = row.commissionRate;
    current.commissionAmountRmb += row.commissionAmountRmb;
    summaryMap.set(row.buyerName, current);
  }

  const buyerSummaries = [...summaryMap.values()]
    .map((row) => ({
      ...row,
      salesRevenueZar: round(row.salesRevenueZar, 2),
      salesRevenueRmb: round(row.salesRevenueRmb, 2),
      commissionAmountRmb: round(row.commissionAmountRmb, 2),
    }))
    .sort((left, right) => right.commissionAmountRmb - left.commissionAmountRmb);

  return {
    id: runId,
    shopName: input.shopName,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    createdAt: input.createdAt,
    createdBy: input.profile.email,
    rowCount: rows.length,
    totalSalesQuantity: round(rows.reduce((sum, row) => sum + row.salesQuantity, 0), 2),
    totalSalesRevenueZar: round(rows.reduce((sum, row) => sum + row.salesRevenueZar, 0), 2),
    totalSalesRevenueRmb: round(rows.reduce((sum, row) => sum + row.salesRevenueRmb, 0), 2),
    totalCommissionRmb: round(rows.reduce((sum, row) => sum + row.commissionAmountRmb, 0), 2),
    buyerSummaries,
    rows,
    exceptions,
  };
}
