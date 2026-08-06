import { Fragment, useMemo, useState } from 'react';
import type { AppProfile, MonthlyProfitDetail, MonthlyProfitReturnDetail, MonthlyProfitSaleDetail, MonthlyProfitSummary, SkuItem, TakealotSale } from '../types';
import { DateRangePicker } from './DateRangePicker';
import { exportMonthlyProfit } from '../utils/exporters';
import { calculateMonthlyProfit, defaultMonthlyProfitDateRange, latestSettledFeeSalesBySku, monthlyProfitMaxDate, sastToday } from '../utils/monthlyProfit';
import { fetchTakealotReturns } from '../utils/takealotReturns';
import { fetchTakealotSales, fetchTakealotSalesByOrder } from '../utils/takealotSales';

type Props = {
  profile: AppProfile; skuItems: SkuItem[]; stores: string[]; summaries: MonthlyProfitSummary[];
  onSave: (summary: MonthlyProfitSummary) => Promise<void>; onRefresh: () => Promise<void>;
};

const money = (value: number) => `R ${value.toFixed(2)}`;

async function fetchOriginalOrders(shopName: string, orderIds: string[], onProgress: (done: number, total: number) => void): Promise<TakealotSale[]> {
  const rows: TakealotSale[] = [];
  let done = 0;
  for (let index = 0; index < orderIds.length; index += 5) {
    const groups = await Promise.all(orderIds.slice(index, index + 5).map((orderId) => fetchTakealotSalesByOrder(shopName, orderId)));
    groups.forEach((group) => rows.push(...group));
    done += groups.length;
    onProgress(done, orderIds.length);
  }
  return rows;
}

export function MonthlyProfitSection({ profile, skuItems, stores, summaries, onSave, onRefresh }: Props) {
  const initialRange = useMemo(() => defaultMonthlyProfitDateRange(), []);
  const [shopName, setShopName] = useState(stores[0]);
  const [dateFrom, setDateFrom] = useState(initialRange.dateFrom);
  const [dateTo, setDateTo] = useState(initialRange.dateTo);
  const [advertisingCost, setAdvertisingCost] = useState('');
  const [salaryCost, setSalaryCost] = useState('');
  const [note, setNote] = useState('');
  const [details, setDetails] = useState<MonthlyProfitDetail[]>([]);
  const [salesDetails, setSalesDetails] = useState<MonthlyProfitSaleDetail[]>([]);
  const [returnDetails, setReturnDetails] = useState<MonthlyProfitReturnDetail[]>([]);
  const [showReturnDetails, setShowReturnDetails] = useState(false);
  const [expandedSkus, setExpandedSkus] = useState<Set<string>>(new Set());
  const [currentSummary, setCurrentSummary] = useState<MonthlyProfitSummary | null>(null);
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const savedSummary = useMemo(() => summaries.find((item) => item.shopName === shopName && item.dateFrom === dateFrom && item.dateTo === dateTo) ?? null, [dateFrom, dateTo, shopName, summaries]);
  const displayed = currentSummary?.shopName === shopName && currentSummary.dateFrom === dateFrom && currentSummary.dateTo === dateTo ? currentSummary : savedSummary;
  const salesBySku = useMemo(() => {
    const result = new Map<string, MonthlyProfitSaleDetail[]>();
    for (const row of salesDetails) {
      const key = row.sku.trim().toUpperCase();
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  }, [salesDetails]);

  async function sync() {
    const adCost = Number(advertisingCost);
    const salary = salaryCost.trim() === '' ? 0 : Number(salaryCost);
    if (advertisingCost.trim() === '' || !Number.isFinite(adCost) || adCost < 0) { setMessage('广告费用必须明确填写 0 或正数。'); return; }
    if (!Number.isFinite(salary) || salary < 0) { setMessage('人员工资必须留空或填写 0 以上的数字。'); return; }
    const maxDate = monthlyProfitMaxDate();
    if (!dateFrom || !dateTo) { setMessage('请选择完整的开始日期和结束日期。'); return; }
    if (dateFrom.slice(0, 7) !== dateTo.slice(0, 7)) { setMessage('开始日期和结束日期必须在同一个自然月。'); return; }
    if (dateFrom > dateTo || dateTo > maxDate) { setMessage('统计日期范围无效或尚未达到 7 天结算期。'); return; }
    try {
      setSyncing(true); setDetails([]); setSalesDetails([]); setReturnDetails([]); setShowReturnDetails(false); setExpandedSkus(new Set()); setCurrentSummary(null);
      setMessage(`正在读取 ${dateFrom} 至 ${dateTo} 的销售和退货数据...`);
      const [salesResult, returns] = await Promise.all([
        fetchTakealotSales(shopName, (pages, rows) => setMessage(`销售明细：第 ${pages} 页，已读取 ${rows} 条`), { dateFrom, dateTo }),
        fetchTakealotReturns(shopName, dateFrom, dateTo),
      ]);
      const pairKey = (orderId: string, sku: string) => `${orderId}|${sku.trim().toUpperCase()}`;
      const existingPairs = new Set(salesResult.rows.map((sale) => pairKey(sale.orderId, sale.sku)));
      const orderIds = [...new Set(returns.filter((row) => row.orderId && !existingPairs.has(pairKey(row.orderId, row.sku))).map((row) => row.orderId))];
      const originalSales = await fetchOriginalOrders(shopName, orderIds, (done, total) => setMessage(`正在关联退货原订单：${done}/${total}`));
      const loadedSales = [...salesResult.rows, ...originalSales];
      const settledExactPairs = new Set(loadedSales.filter((sale) => sale.quantity > 0 && sale.totalFees !== null && sale.totalFees > 0).map((sale) => pairKey(sale.orderId, sale.sku)));
      const loadedFallbacks = latestSettledFeeSalesBySku(loadedSales);
      const needsHistoricalFallback = returns.some((row) => !settledExactPairs.has(pairKey(row.orderId, row.sku)) && !loadedFallbacks.has(row.sku.trim().toUpperCase()));
      let feeFallbackSales: TakealotSale[] = [];
      if (needsHistoricalFallback) {
        const historicalStart = new Date(`${dateTo}T00:00:00Z`);
        historicalStart.setUTCDate(historicalStart.getUTCDate() - 179);
        setMessage(`正在读取 ${historicalStart.toISOString().slice(0, 10)} 至 ${dateTo} 的历史销售，用于匹配退货 Total Fees...`);
        feeFallbackSales = (await fetchTakealotSales(shopName, (pages, rows) => setMessage(`历史销售费用：第 ${pages} 页，已读取 ${rows} 条`), { dateFrom: historicalStart.toISOString().slice(0, 10), dateTo })).rows;
      }
      const result = calculateMonthlyProfit({ shopName, month: dateFrom.slice(0, 7), dateFrom, dateTo, dataCutoffDate: dateTo, isCurrentMonth: dateFrom.slice(0, 7) === sastToday().slice(0, 7),
        sales: salesResult.rows, returns, originalSales, feeFallbackSales, skuItems, advertisingCost: adCost, salaryCost: salary, note, createdBy: profile.email });
      await onSave(result.summary);
      setCurrentSummary(result.summary); setDetails(result.details); setSalesDetails(result.salesDetails); setReturnDetails(result.returnDetails);
      await onRefresh();
      setMessage(`同步完成：销售 ${salesResult.rows.length} 条，退货 ${returns.length} 条。${result.summary.status === 'incomplete' ? '存在费用未结算或无法匹配的数据，最终利润为已知数据结果。' : ''}`);
    } catch (error) {
      console.error(error); setMessage(error instanceof Error ? error.message : '月度利润同步失败，已保留上次汇总。');
    } finally { setSyncing(false); }
  }

  return <section className="monthly-profit-section">
    <div className="section-heading"><div><h2>月度利润</h2><p>按南非自然月统计销售、退货、广告费用和人员工资；数据统一延迟 7 天结算。</p></div>
      <div className="export-actions"><button type="button" disabled={!displayed} onClick={() => displayed && exportMonthlyProfit(displayed, currentSummary === displayed ? details : [], currentSummary === displayed ? salesDetails : [], currentSummary === displayed ? returnDetails : [])}>导出 Excel</button><button className="primary" type="button" disabled={syncing || !dateFrom || !dateTo} onClick={() => void sync()}>{syncing ? '同步中...' : '同步月度利润'}</button></div></div>
    <div className="profit-analysis-controls">
      <label>店铺<select value={shopName} onChange={(event) => { setShopName(event.target.value); setCurrentSummary(null); setDetails([]); setSalesDetails([]); setReturnDetails([]); setShowReturnDetails(false); setExpandedSkus(new Set()); }}>{stores.map((store) => <option key={store}>{store}</option>)}</select></label>
      <label className="monthly-date-control">统计日期<DateRangePicker startDate={dateFrom} endDate={dateTo} maxDate={monthlyProfitMaxDate()} onChange={(start, end) => { setDateFrom(start); setDateTo(end); setCurrentSummary(null); setDetails([]); setSalesDetails([]); setReturnDetails([]); setShowReturnDetails(false); setExpandedSkus(new Set()); }} /></label>
      <label>广告费用 (ZAR)<input type="number" min="0" step="0.01" value={advertisingCost} onChange={(event) => setAdvertisingCost(event.target.value)} placeholder="必须填写，0 也要填写" /></label>
      <label>人员工资 (ZAR)<input type="number" min="0" step="0.01" value={salaryCost} onChange={(event) => setSalaryCost(event.target.value)} placeholder="选填，留空按 0" /></label>
      <label>备注<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
    </div>
    {message && <div className="inline-notice">{message}</div>}
    {displayed && <>
      <div className={`inline-notice ${displayed.status === 'incomplete' ? 'warning' : ''}`}>状态：{displayed.status === 'complete' ? '完整' : '不完整（最终利润为已知数据结果）'}</div>
      <div className="repricing-summary">
        <div className="metric"><span>销售额 / 数量</span><strong>{money(displayed.salesRevenue)} / {displayed.salesQuantity}</strong></div><div className="metric"><span>销售利润</span><strong>{money(displayed.salesProfit)}</strong></div>
        <div className="metric"><span>退货数量</span><strong>{displayed.returnQuantity}</strong></div><button type="button" className="metric monthly-profit-clickable-metric" disabled={!returnDetails.length} onClick={() => setShowReturnDetails((value) => !value)}><span>退货基础损失（点击查看明细）</span><strong>{money(displayed.returnProfitReversal)}</strong></button>
        <div className="metric"><span>退货额外损失</span><strong>{money(displayed.returnNetFees)}</strong></div><div className="metric"><span>广告费用</span><strong>{money(displayed.advertisingCost)}</strong></div><div className="metric"><span>人员工资</span><strong>{money(displayed.salaryCost)}</strong></div><div className="metric"><span>最终利润</span><strong>{money(displayed.finalProfit)}</strong></div>
      </div>
    </>}
    {showReturnDetails && returnDetails.length > 0 && <div className="table-wrap monthly-return-detail-table"><table><thead><tr><th>退货编号</th><th>原订单号</th><th>SKU</th><th>产品名称</th><th>退货日期</th><th>退货数量</th><th>采购成本 ZAR</th><th>海运费</th><th>国内运费</th><th>送仓费</th><th>分摊 Total Fees</th><th>Total Fees 来源订单号</th><th>退货基础损失</th><th>退货额外损失</th><th>异常原因</th></tr></thead><tbody>{returnDetails.map((row) => <tr key={row.id} className={row.messages.length ? 'monthly-sale-loss' : ''}><td>{row.returnId || '-'}</td><td>{row.orderId || '-'}</td><td>{row.sku}</td><td>{row.productName || '-'}</td><td>{row.returnDate || '-'}</td><td>{row.quantity}</td><td>{row.purchaseCostZar === null ? '-' : money(row.purchaseCostZar)}</td><td>{row.seaFreightCost === null ? '-' : money(row.seaFreightCost)}</td><td>{row.domesticFreightCost === null ? '-' : money(row.domesticFreightCost)}</td><td>{row.warehouseFee === null ? '-' : money(row.warehouseFee)}</td><td>{row.allocatedTotalFees === null ? '-' : money(row.allocatedTotalFees)}</td><td>{row.totalFeesSourceOrderId || '-'}</td><td><strong>{row.baseLoss === null ? '-' : money(row.baseLoss)}</strong></td><td>{money(row.extraLoss)}</td><td>{row.messages.join('；') || '正常'}</td></tr>)}</tbody></table></div>}
    {details.length > 0 && <div className="table-wrap"><table><thead><tr><th>SKU</th><th>产品名称</th><th>销售数量</th><th>退货数量</th><th>销售利润</th><th>退货影响</th><th>净利润</th><th>异常原因</th><th>操作</th></tr></thead><tbody>{details.map((row) => {
      const expanded = expandedSkus.has(row.sku);
      const rows = salesBySku.get(row.sku.trim().toUpperCase()) ?? [];
      return <Fragment key={row.sku}><tr><td>{row.sku}</td><td>{row.productName || '-'}</td><td>{row.salesQuantity}</td><td>{row.returnQuantity}</td><td>{money(row.salesProfit)}</td><td>{money(row.returnProfitReversal + row.returnNetFees)}</td><td><strong>{money(row.netProfit)}</strong></td><td>{row.messages.join('；') || '正常'}</td><td><button type="button" disabled={!rows.length} onClick={() => setExpandedSkus((current) => { const next = new Set(current); if (next.has(row.sku)) next.delete(row.sku); else next.add(row.sku); return next; })}>{expanded ? '收起明细' : `展开明细 (${rows.length})`}</button></td></tr>
        {expanded && <tr className="monthly-sale-detail-row"><td colSpan={9}><div className="monthly-sale-detail-table"><table><thead><tr><th>订单号</th><th>成交时间</th><th>Sale Status</th><th>实际成交价</th><th>数量</th><th>采购价 RMB</th><th>采购成本 ZAR</th><th>单品 CBM</th><th>海运费</th><th>国内运费</th><th>送仓费</th><th>Total Fees</th><th>该笔利润</th><th>异常原因</th></tr></thead><tbody>{rows.map((sale) => <tr key={sale.id} className={sale.profit !== null && sale.profit < 0 ? 'monthly-sale-loss' : ''}><td>{sale.orderId || '-'}</td><td>{new Date(sale.orderDate).toLocaleString('zh-CN')}</td><td>{sale.saleStatus || '-'}</td><td>{money(sale.sellingPrice)}</td><td>{sale.quantity}</td><td>{sale.purchaseCostRmb === null ? '-' : `¥ ${sale.purchaseCostRmb.toFixed(2)}`}</td><td>{sale.purchaseCostZar === null ? '-' : money(sale.purchaseCostZar)}</td><td>{sale.unitCbm === null ? '-' : sale.unitCbm.toFixed(8)}</td><td>{sale.seaFreightCost === null ? '-' : money(sale.seaFreightCost)}</td><td>{sale.domesticFreightCost === null ? '-' : money(sale.domesticFreightCost)}</td><td>{sale.warehouseFee === null ? '-' : money(sale.warehouseFee)}</td><td>{sale.totalFees === null ? '-' : money(sale.totalFees)}</td><td><strong>{sale.profit === null ? '-' : money(sale.profit)}</strong></td><td>{sale.messages.join('；') || '正常'}</td></tr>)}</tbody></table></div></td></tr>}
      </Fragment>;
    })}</tbody></table></div>}
  </section>;
}
