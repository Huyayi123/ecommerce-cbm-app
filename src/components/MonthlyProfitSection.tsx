import { Fragment, useMemo, useState } from 'react';
import type { AppProfile, MonthlyProfitDetail, MonthlyProfitSaleDetail, MonthlyProfitSummary, SkuItem, TakealotSale } from '../types';
import { exportMonthlyProfit } from '../utils/exporters';
import { calculateMonthlyProfit, monthlyProfitRange, sastToday } from '../utils/monthlyProfit';
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
  const [shopName, setShopName] = useState(stores[0]);
  const [month, setMonth] = useState(sastToday().slice(0, 7));
  const [advertisingCost, setAdvertisingCost] = useState('');
  const [note, setNote] = useState('');
  const [details, setDetails] = useState<MonthlyProfitDetail[]>([]);
  const [salesDetails, setSalesDetails] = useState<MonthlyProfitSaleDetail[]>([]);
  const [expandedSkus, setExpandedSkus] = useState<Set<string>>(new Set());
  const [currentSummary, setCurrentSummary] = useState<MonthlyProfitSummary | null>(null);
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const savedSummary = useMemo(() => summaries.find((item) => item.shopName === shopName && item.month === month) ?? null, [month, shopName, summaries]);
  const displayed = currentSummary?.shopName === shopName && currentSummary.month === month ? currentSummary : savedSummary;
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
    if (advertisingCost.trim() === '' || !Number.isFinite(adCost) || adCost < 0) { setMessage('广告费用必须明确填写 0 或正数。'); return; }
    const range = monthlyProfitRange(month);
    if (!range.hasEligibleDates) { setMessage(`该月暂无可统计数据；当前数据截止日为 ${range.dataCutoffDate}。`); return; }
    try {
      setSyncing(true); setDetails([]); setSalesDetails([]); setExpandedSkus(new Set()); setCurrentSummary(null);
      setMessage(`正在读取 ${range.startDate} 至 ${range.endDate} 的销售和退货数据...`);
      const [salesResult, returns] = await Promise.all([
        fetchTakealotSales(shopName, (pages, rows) => setMessage(`销售明细：第 ${pages} 页，已读取 ${rows} 条`), { dateFrom: range.startDate, dateTo: range.endDate }),
        fetchTakealotReturns(shopName, range.startDate, range.endDate),
      ]);
      const existingOrders = new Set(salesResult.rows.map((sale) => sale.orderId));
      const orderIds = [...new Set(returns.map((row) => row.orderId).filter((id) => id && !existingOrders.has(id)))];
      const originalSales = await fetchOriginalOrders(shopName, orderIds, (done, total) => setMessage(`正在关联退货原订单：${done}/${total}`));
      const result = calculateMonthlyProfit({ shopName, month, dataCutoffDate: range.endDate, isCurrentMonth: range.isCurrentMonth,
        sales: salesResult.rows, returns, originalSales, skuItems, advertisingCost: adCost, note, createdBy: profile.email });
      await onSave(result.summary);
      setCurrentSummary(result.summary); setDetails(result.details); setSalesDetails(result.salesDetails);
      await onRefresh();
      setMessage(`同步完成：销售 ${salesResult.rows.length} 条，退货 ${returns.length} 条。${result.summary.status === 'incomplete' ? '存在费用未结算或无法匹配的数据，最终利润为已知数据结果。' : ''}`);
    } catch (error) {
      console.error(error); setMessage(error instanceof Error ? error.message : '月度利润同步失败，已保留上次汇总。');
    } finally { setSyncing(false); }
  }

  return <section className="monthly-profit-section">
    <div className="section-heading"><div><h2>老板月度利润</h2><p>按南非自然月统计销售、退货和广告费用；数据统一延迟 7 天结算。</p></div>
      <div className="export-actions"><button type="button" disabled={!displayed} onClick={() => displayed && exportMonthlyProfit(displayed, currentSummary === displayed ? details : [], currentSummary === displayed ? salesDetails : [])}>导出 Excel</button><button className="primary" type="button" disabled={syncing} onClick={() => void sync()}>{syncing ? '同步中...' : '同步月度利润'}</button></div></div>
    <div className="profit-analysis-controls">
      <label>店铺<select value={shopName} onChange={(event) => { setShopName(event.target.value); setCurrentSummary(null); setDetails([]); setSalesDetails([]); setExpandedSkus(new Set()); }}>{stores.map((store) => <option key={store}>{store}</option>)}</select></label>
      <label>月份<input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setCurrentSummary(null); setDetails([]); setSalesDetails([]); setExpandedSkus(new Set()); }} /></label>
      <label>广告费用 (ZAR)<input type="number" min="0" step="0.01" value={advertisingCost} onChange={(event) => setAdvertisingCost(event.target.value)} placeholder="必须填写，0 也要填写" /></label>
      <label>备注<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
    </div>
    {message && <div className="inline-notice">{message}</div>}
    {displayed && <>
      <div className={`inline-notice ${displayed.status === 'incomplete' ? 'warning' : ''}`}>{displayed.isCurrentMonth ? '月份未结束；' : ''}数据截止日：{displayed.dataCutoffDate}；状态：{displayed.status === 'complete' ? '完整' : '不完整（最终利润为已知数据结果）'}</div>
      <div className="repricing-summary">
        <div className="metric"><span>销售额 / 数量</span><strong>{money(displayed.salesRevenue)} / {displayed.salesQuantity}</strong></div><div className="metric"><span>销售利润</span><strong>{money(displayed.salesProfit)}</strong></div>
        <div className="metric"><span>退货数量</span><strong>{displayed.returnQuantity}</strong></div><div className="metric"><span>退货基础损失</span><strong>{money(displayed.returnProfitReversal)}</strong></div>
        <div className="metric"><span>退货额外损失</span><strong>{money(displayed.returnNetFees)}</strong></div><div className="metric"><span>广告费用</span><strong>{money(displayed.advertisingCost)}</strong></div><div className="metric"><span>最终利润</span><strong>{money(displayed.finalProfit)}</strong></div>
      </div>
    </>}
    {details.length > 0 && <div className="table-wrap"><table><thead><tr><th>SKU</th><th>产品名称</th><th>销售数量</th><th>退货数量</th><th>销售利润</th><th>退货影响</th><th>净利润</th><th>异常原因</th><th>操作</th></tr></thead><tbody>{details.map((row) => {
      const expanded = expandedSkus.has(row.sku);
      const rows = salesBySku.get(row.sku.trim().toUpperCase()) ?? [];
      return <Fragment key={row.sku}><tr><td>{row.sku}</td><td>{row.productName || '-'}</td><td>{row.salesQuantity}</td><td>{row.returnQuantity}</td><td>{money(row.salesProfit)}</td><td>{money(row.returnProfitReversal + row.returnNetFees)}</td><td><strong>{money(row.netProfit)}</strong></td><td>{row.messages.join('；') || '正常'}</td><td><button type="button" disabled={!rows.length} onClick={() => setExpandedSkus((current) => { const next = new Set(current); if (next.has(row.sku)) next.delete(row.sku); else next.add(row.sku); return next; })}>{expanded ? '收起明细' : `展开明细 (${rows.length})`}</button></td></tr>
        {expanded && <tr className="monthly-sale-detail-row"><td colSpan={9}><div className="monthly-sale-detail-table"><table><thead><tr><th>订单号</th><th>成交时间</th><th>Sale Status</th><th>实际成交价</th><th>数量</th><th>采购价 RMB</th><th>采购成本 ZAR</th><th>单品 CBM</th><th>海运费</th><th>国内运费</th><th>送仓费</th><th>Total Fees</th><th>该笔利润</th><th>异常原因</th></tr></thead><tbody>{rows.map((sale) => <tr key={sale.id} className={sale.profit !== null && sale.profit < 0 ? 'monthly-sale-loss' : ''}><td>{sale.orderId || '-'}</td><td>{new Date(sale.orderDate).toLocaleString('zh-CN')}</td><td>{sale.saleStatus || '-'}</td><td>{money(sale.sellingPrice)}</td><td>{sale.quantity}</td><td>{sale.purchaseCostRmb === null ? '-' : `¥ ${sale.purchaseCostRmb.toFixed(2)}`}</td><td>{sale.purchaseCostZar === null ? '-' : money(sale.purchaseCostZar)}</td><td>{sale.unitCbm === null ? '-' : sale.unitCbm.toFixed(8)}</td><td>{sale.seaFreightCost === null ? '-' : money(sale.seaFreightCost)}</td><td>{sale.domesticFreightCost === null ? '-' : money(sale.domesticFreightCost)}</td><td>{sale.warehouseFee === null ? '-' : money(sale.warehouseFee)}</td><td>{sale.totalFees === null ? '-' : money(sale.totalFees)}</td><td><strong>{sale.profit === null ? '-' : money(sale.profit)}</strong></td><td>{sale.messages.join('；') || '正常'}</td></tr>)}</tbody></table></div></td></tr>}
      </Fragment>;
    })}</tbody></table></div>}
  </section>;
}
