import type { MonthlyProfitDetail, MonthlyProfitReturnDetail, MonthlyProfitSaleDetail, MonthlyProfitSummary, SkuItem, TakealotReturn, TakealotSale } from '../types';
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

export function monthlyProfitMaxDate(now = new Date()): string {
  const cutoffDate = utcDate(sastToday(now));
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
  return dateText(cutoffDate);
}

export function defaultMonthlyProfitDateRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const dateTo = monthlyProfitMaxDate(now);
  return { dateFrom: `${dateTo.slice(0, 7)}-01`, dateTo };
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

function hasSettledFees(sale: TakealotSale | undefined): sale is TakealotSale {
  return Boolean(sale && sale.quantity > 0 && sale.totalFees !== null && sale.totalFees > 0);
}

export function latestSettledFeeSalesBySku(sales: TakealotSale[]): Map<string, TakealotSale> {
  const result = new Map<string, TakealotSale>();
  for (const sale of sales) {
    if (!hasSettledFees(sale) || isExcludedSaleStatus(sale.saleStatus)) continue;
    const key = skuKey(sale.sku);
    const current = result.get(key);
    const saleIsSingle = sale.quantity === 1;
    const currentIsSingle = current?.quantity === 1;
    if (!current || (saleIsSingle && !currentIsSingle)
      || (saleIsSingle === currentIsSingle && Date.parse(sale.orderDate) > Date.parse(current.orderDate))) result.set(key, sale);
  }
  return result;
}

export function calculateMonthlyProfit(input: {
  shopName: string; month: string; dataCutoffDate: string; isCurrentMonth: boolean;
  dateFrom: string; dateTo: string;
  sales: TakealotSale[]; returns: TakealotReturn[]; originalSales: TakealotSale[]; feeFallbackSales: TakealotSale[];
  skuItems: SkuItem[]; advertisingCost: number; salaryCost: number; note: string; createdBy: string; updatedAt?: string;
}): { summary: MonthlyProfitSummary; details: MonthlyProfitDetail[]; salesDetails: MonthlyProfitSaleDetail[]; returnDetails: MonthlyProfitReturnDetail[] } {
  const store = canonicalShopName(input.shopName);
  const skuItems = new Map(input.skuItems.filter((item) => canonicalShopName(item.shopName) === store).map((item) => [skuKey(item.sku), item]));
  const details = new Map<string, MonthlyProfitDetail>();
  const detailFor = (sku: string) => {
    const key = skuKey(sku);
    const existing = details.get(key);
    if (existing) return existing;
    const item = skuItems.get(key);
    const next: MonthlyProfitDetail = { sku, productName: item?.englishName || item?.productName || '', imageUrl: item?.imageUrl || '', salesQuantity: 0, salesRevenue: 0, salesProfit: 0, returnQuantity: 0, returnProfitReversal: 0, returnNetFees: 0, netProfit: 0, messages: [] };
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
  for (const sale of [...input.sales, ...input.originalSales]) {
    const key = `${sale.orderId}|${skuKey(sale.sku)}`;
    const current = originalByOrderSku.get(key);
    if (!current || (!hasSettledFees(current) && hasSettledFees(sale))) originalByOrderSku.set(key, sale);
  }
  const fallbackFeesBySku = latestSettledFeeSalesBySku([...input.sales, ...input.originalSales, ...input.feeFallbackSales]);
  const returnDetails: MonthlyProfitReturnDetail[] = [];
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
    const feeSource = hasSettledFees(original) ? original : fallbackFeesBySku.get(skuKey(returned.sku));
    const usedFallback = Boolean(feeSource && feeSource !== original);
    const costs = costsFor(returned.sku);
    const item = skuItems.get(skuKey(returned.sku));
    if (!costs) {
      missingReturnQuantity += returned.quantity;
      detail.messages.push('SKU 采购价或 CBM 缺失');
      returnDetails.push({ id: returned.returnId || `${returned.orderId}-${returned.sku}-${returned.returnDate}`, returnId: returned.returnId, orderId: returned.orderId,
        sku: returned.sku, productName: item?.englishName || item?.productName || '', returnDate: returned.returnDate, quantity: returned.quantity,
        purchaseCostZar: null, seaFreightCost: null, domesticFreightCost: null, warehouseFee: null, allocatedTotalFees: null, totalFeesSourceOrderId: '', baseLoss: null,
        extraLoss: extraLoss.amount, messages: ['SKU 采购价或 CBM 缺失', ...(extraLoss.unknownTypes.length ? [`未识别退货交易类型：${extraLoss.unknownTypes.join('、')}`] : [])] });
      continue;
    }
    const messages: string[] = [];
    if (usedFallback) messages.push('原订单超过 180 天或平台未返回，Total Fees 使用同 SKU 最近订单替代');
    if (!feeSource) messages.push('未找到可用 Total Fees');
    if (usedFallback || !feeSource) missingReturnQuantity += returned.quantity;
    const allocatedTotalFees = feeSource ? feeSource.totalFees! / feeSource.quantity * returned.quantity : 0;
    const purchaseCostZar = costs.purchaseCostZar * returned.quantity;
    const seaFreightCost = costs.seaFreightCost * returned.quantity;
    const domesticFreightCost = costs.domesticFreightCost * returned.quantity;
    const warehouseFee = costs.warehouseFee * returned.quantity;
    const baseLoss = purchaseCostZar + seaFreightCost + domesticFreightCost + warehouseFee + allocatedTotalFees;
    const roundedBaseLoss = round(baseLoss, 2);
    returnProfitReversal += roundedBaseLoss; detail.returnProfitReversal += roundedBaseLoss;
    returnDetails.push({ id: returned.returnId || `${returned.orderId}-${returned.sku}-${returned.returnDate}`, returnId: returned.returnId, orderId: returned.orderId,
      sku: returned.sku, productName: item?.englishName || item?.productName || '', returnDate: returned.returnDate, quantity: returned.quantity,
      purchaseCostZar: round(purchaseCostZar, 2), seaFreightCost: round(seaFreightCost, 2), domesticFreightCost: round(domesticFreightCost, 2),
      warehouseFee: round(warehouseFee, 2), allocatedTotalFees: feeSource ? round(allocatedTotalFees, 2) : null, totalFeesSourceOrderId: feeSource?.orderId ?? '', baseLoss: roundedBaseLoss, extraLoss: extraLoss.amount,
      messages: [...messages, ...(extraLoss.unknownTypes.length ? [`未识别退货交易类型：${extraLoss.unknownTypes.join('、')}`] : [])] });
    detail.messages.push(...messages);
  }
  const normalizedDetails = [...details.values()].map((detail) => ({ ...detail,
    salesRevenue: round(detail.salesRevenue, 2), salesProfit: round(detail.salesProfit, 2), returnProfitReversal: round(detail.returnProfitReversal, 2), returnNetFees: round(detail.returnNetFees, 2),
    netProfit: round(detail.salesProfit - detail.returnProfitReversal - detail.returnNetFees, 2), messages: [...new Set(detail.messages)],
  })).sort((a, b) => b.netProfit - a.netProfit);
  const status = missingSalesQuantity > 0 || missingReturnQuantity > 0 || hasUnknownReturnTransactions ? 'incomplete' : 'complete';
  const summary: MonthlyProfitSummary = {
    id: `${store.toLowerCase()}-${input.dateFrom}-${input.dateTo}`, shopName: store, month: input.month, dateFrom: input.dateFrom, dateTo: input.dateTo, dataCutoffDate: input.dataCutoffDate, isCurrentMonth: input.isCurrentMonth,
    salesRevenue: round(salesRevenue, 2), salesQuantity, salesProfit: round(salesProfit, 2), returnQuantity, returnProfitReversal: round(returnProfitReversal, 2), returnNetFees: round(returnNetFees, 2),
    advertisingCost: round(input.advertisingCost, 2), salaryCost: round(input.salaryCost, 2), finalProfit: round(salesProfit - returnProfitReversal - returnNetFees - input.advertisingCost - input.salaryCost, 2),
    missingSalesQuantity, missingSalesRevenue: round(missingSalesRevenue, 2), missingReturnQuantity, status, note: input.note.trim(), createdBy: input.createdBy, updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  return { summary, details: normalizedDetails, salesDetails: salesDetails.sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate)), returnDetails: returnDetails.sort((a, b) => Date.parse(b.returnDate) - Date.parse(a.returnDate)) };
}
