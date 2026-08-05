import type { MonthlyProfitDetail, MonthlyProfitSaleDetail, MonthlyProfitSummary, SkuItem, TakealotReturn, TakealotSale } from '../types';
import { round } from './number';
import { calculateBaseProductCosts, isExcludedSaleStatus } from './profitCalculations';
import { canonicalShopName } from './shops';

const SAST_TIME_ZONE = 'Africa/Johannesburg';

function skuKey(value: string): string { return value.trim().toUpperCase(); }
function dateText(date: Date): string { return date.toISOString().slice(0, 10); }
function utcDate(value: string): Date { return new Date(`${value}T00:00:00Z`); }

export function sastToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SAST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function monthlyProfitRange(month: string, now = new Date()) {
  const today = sastToday(now);
  const cutoffDate = utcDate(today);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
  const dataCutoffDate = dateText(cutoffDate);
  const startDate = `${month}-01`;
  const [year, monthNumber] = month.split('-').map(Number);
  const monthEnd = dateText(new Date(Date.UTC(year, monthNumber, 0)));
  const endDate = dataCutoffDate < monthEnd ? dataCutoffDate : monthEnd;
  return { startDate, endDate, dataCutoffDate, isCurrentMonth: month === today.slice(0, 7), hasEligibleDates: endDate >= startDate };
}

export function returnExtraLoss(value: TakealotReturn): { amount: number; unknownTypes: string[] } {
  const unknownTypes: string[] = [];
  const netAmount = value.transactions.reduce((sum, transaction) => {
    const type = transaction.transactionType.toLowerCase();
    const amount = Math.abs(transaction.amountInclVat || 0);
    if (type.startsWith('charge-')) return sum + amount;
    if (type.startsWith('reversal-') || type.startsWith('payment-')) return sum - amount;
    if (type) unknownTypes.push(transaction.transactionType);
    return sum;
  }, 0);
  return { amount: round(Math.max(0, netAmount), 2), unknownTypes: [...new Set(unknownTypes)] };
}

export function calculateMonthlyProfit(input: {
  shopName: string; month: string; dataCutoffDate: string; isCurrentMonth: boolean;
  sales: TakealotSale[]; returns: TakealotReturn[]; originalSales: TakealotSale[];
  skuItems: SkuItem[]; advertisingCost: number; note: string; createdBy: string; updatedAt?: string;
}): { summary: MonthlyProfitSummary; details: MonthlyProfitDetail[]; salesDetails: MonthlyProfitSaleDetail[] } {
  const store = canonicalShopName(input.shopName);
  const skuItems = new Map(input.skuItems.filter((item) => canonicalShopName(item.shopName) === store).map((item) => [skuKey(item.sku), item]));
  const details = new Map<string, MonthlyProfitDetail>();
  const detailFor = (sku: string) => {
    const key = skuKey(sku);
    const existing = details.get(key);
    if (existing) return existing;
    const item = skuItems.get(key);
    const next: MonthlyProfitDetail = { sku, productName: item?.englishName || item?.productName || '', salesQuantity: 0, salesRevenue: 0, salesProfit: 0, returnQuantity: 0, returnProfitReversal: 0, returnNetFees: 0, netProfit: 0, messages: [] };
    details.set(key, next);
    return next;
  };
  const costsFor = (sku: string) => {
    const item = skuItems.get(skuKey(sku));
    const cbm = item ? item.unitCbm || item.manualUnitCbm : 0;
    return item && item.purchasePrice > 0 && cbm > 0 ? calculateBaseProductCosts(item.purchasePrice, cbm) : null;
  };

  const salesDetails: MonthlyProfitSaleDetail[] = [];
  let salesRevenue = 0, salesQuantity = 0, salesProfit = 0, missingSalesQuantity = 0, missingSalesRevenue = 0;
  for (const sale of input.sales) {
    if (isExcludedSaleStatus(sale.saleStatus) || sale.quantity <= 0) continue;
    const detail = detailFor(sale.sku);
    const revenue = sale.sellingPrice && sale.sellingPrice > 0 ? sale.sellingPrice : 0;
    salesRevenue += revenue; salesQuantity += sale.quantity;
    detail.salesRevenue += revenue; detail.salesQuantity += sale.quantity;
    const costs = costsFor(sale.sku);
    const errors: string[] = [];
    if (!costs) errors.push('SKU 采购价或 CBM 缺失');
    if (!revenue) errors.push('成交金额缺失');
    if (sale.totalFees === null || sale.totalFees <= 0) errors.push('Total Fees 尚未结算');
    let lineProfit: number | null = null;
    if (errors.length) {
      missingSalesQuantity += sale.quantity; missingSalesRevenue += revenue;
      detail.messages.push(...errors);
    } else {
      const unitBaseCost = costs!.purchaseCostZar + costs!.seaFreightCost + costs!.domesticFreightCost + costs!.warehouseFee;
      lineProfit = revenue - sale.quantity * unitBaseCost - sale.totalFees!;
      salesProfit += lineProfit; detail.salesProfit += lineProfit;
    }
    const item = skuItems.get(skuKey(sale.sku));
    const unitCbm = item ? item.unitCbm || item.manualUnitCbm : 0;
    salesDetails.push({
      id: sale.orderItemId || `${sale.orderId}-${sale.sku}-${sale.orderDate}`, orderId: sale.orderId, sku: sale.sku,
      orderDate: sale.orderDate, saleStatus: sale.saleStatus, sellingPrice: round(revenue, 2), quantity: sale.quantity,
      purchaseCostRmb: item && item.purchasePrice > 0 ? round(item.purchasePrice, 2) : null,
      purchaseCostZar: costs?.purchaseCostZar ?? null, unitCbm: unitCbm > 0 ? round(unitCbm, 8) : null,
      seaFreightCost: costs?.seaFreightCost ?? null, domesticFreightCost: costs?.domesticFreightCost ?? null,
      warehouseFee: costs?.warehouseFee ?? null, totalFees: sale.totalFees === null ? null : round(sale.totalFees, 2),
      profit: lineProfit === null ? null : round(lineProfit, 2), messages: errors,
    });
  }

  const originalByOrderSku = new Map<string, TakealotSale>();
  for (const sale of [...input.sales, ...input.originalSales]) originalByOrderSku.set(`${sale.orderId}|${skuKey(sale.sku)}`, sale);
  let returnQuantity = 0, returnProfitReversal = 0, returnNetFees = 0, missingReturnQuantity = 0;
  let hasUnknownReturnTransactions = false;
  for (const returned of input.returns) {
    if (returned.quantity <= 0) continue;
    const detail = detailFor(returned.sku);
    const extraLoss = returnExtraLoss(returned);
    returnQuantity += returned.quantity; returnNetFees += extraLoss.amount;
    detail.returnQuantity += returned.quantity; detail.returnNetFees += extraLoss.amount;
    if (extraLoss.unknownTypes.length) {
      hasUnknownReturnTransactions = true;
      detail.messages.push(`未识别退货交易类型：${extraLoss.unknownTypes.join('、')}`);
    }
    const original = originalByOrderSku.get(`${returned.orderId}|${skuKey(returned.sku)}`);
    const costs = costsFor(returned.sku);
    if (!original || original.quantity <= 0 || !original.sellingPrice || original.totalFees === null || original.totalFees <= 0 || !costs) {
      missingReturnQuantity += returned.quantity;
      detail.messages.push('无法匹配已结算的原销售记录');
      continue;
    }
    const unitReturnLoss = costs.purchaseCostZar + costs.seaFreightCost + costs.domesticFreightCost + costs.warehouseFee + original.totalFees / original.quantity;
    const baseLoss = unitReturnLoss * returned.quantity;
    returnProfitReversal += baseLoss; detail.returnProfitReversal += baseLoss;
  }
  const normalizedDetails = [...details.values()].map((detail) => ({ ...detail,
    salesRevenue: round(detail.salesRevenue, 2), salesProfit: round(detail.salesProfit, 2), returnProfitReversal: round(detail.returnProfitReversal, 2), returnNetFees: round(detail.returnNetFees, 2),
    netProfit: round(detail.salesProfit - detail.returnProfitReversal - detail.returnNetFees, 2), messages: [...new Set(detail.messages)],
  })).sort((a, b) => b.netProfit - a.netProfit);
  const status = missingSalesQuantity > 0 || missingReturnQuantity > 0 || hasUnknownReturnTransactions ? 'incomplete' : 'complete';
  const summary: MonthlyProfitSummary = {
    id: `${store.toLowerCase()}-${input.month}`, shopName: store, month: input.month, dataCutoffDate: input.dataCutoffDate, isCurrentMonth: input.isCurrentMonth,
    salesRevenue: round(salesRevenue, 2), salesQuantity, salesProfit: round(salesProfit, 2), returnQuantity, returnProfitReversal: round(returnProfitReversal, 2), returnNetFees: round(returnNetFees, 2),
    advertisingCost: round(input.advertisingCost, 2), finalProfit: round(salesProfit - returnProfitReversal - returnNetFees - input.advertisingCost, 2),
    missingSalesQuantity, missingSalesRevenue: round(missingSalesRevenue, 2), missingReturnQuantity, status, note: input.note.trim(), createdBy: input.createdBy, updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  return { summary, details: normalizedDetails, salesDetails: salesDetails.sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate)) };
}
