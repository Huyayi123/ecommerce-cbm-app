import { Fragment, useEffect, useMemo, useState } from 'react';
import { DateRangePicker } from '../components/DateRangePicker';
import type { AppProfile, CommissionRun, SkuItem, TakealotSale } from '../types';
import { buildCommissionRun, commissionRateLabel } from '../utils/commission';
import { exportCommissionRun } from '../utils/exporters';
import { fetchTakealotSales } from '../utils/takealotSales';

type Props = {
  profile: AppProfile;
  skuItems: SkuItem[];
  runs: CommissionRun[];
  onSaveRun: (run: CommissionRun) => Promise<void>;
  onRefresh: () => Promise<void>;
};

const ALL_STORES = '全部店铺';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso(): string {
  return `${todayIso().slice(0, 7)}-01`;
}

function moneyZar(value: number): string {
  return `R ${value.toFixed(2)}`;
}

function moneyRmb(value: number): string {
  return `¥ ${value.toFixed(2)}`;
}

export function CommissionPage({ profile, skuItems, runs, onSaveRun, onRefresh }: Props) {
  const stores = useMemo(() => Array.from(new Set(skuItems.map((item) => item.shopName).filter(Boolean))).sort(), [skuItems]);
  const [shopName, setShopName] = useState('');
  const [dateFrom, setDateFrom] = useState(monthStartIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [currentRun, setCurrentRun] = useState<CommissionRun | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [expandedBuyers, setExpandedBuyers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!shopName && stores[0]) setShopName(stores.length > 1 ? ALL_STORES : stores[0]);
  }, [shopName, stores]);

  const selectedRun = currentRun ?? runs.find((run) => run.id === historyId) ?? runs[0] ?? null;
  const visibleRowsByBuyer = useMemo(() => {
    const result = new Map<string, CommissionRun['rows']>();
    if (!selectedRun) return result;
    for (const row of selectedRun.rows) {
      result.set(row.buyerName, [...(result.get(row.buyerName) ?? []), row]);
    }
    return result;
  }, [selectedRun]);

  async function sync() {
    if (!dateFrom || !dateTo || dateFrom > dateTo) {
      setMessage('请选择有效的统计日期范围。');
      return;
    }
    const targetStores = shopName === ALL_STORES ? stores : [shopName];
    if (targetStores.length === 0 || !targetStores[0]) {
      setMessage('SKU 资料库里还没有店铺，无法同步销售。');
      return;
    }
    try {
      setSyncing(true);
      setCurrentRun(null);
      setExpandedBuyers(new Set());
      const allSales: TakealotSale[] = [];
      for (const store of targetStores) {
        setMessage(`正在同步 ${store}：${dateFrom} 至 ${dateTo} 的 Takealot 销售明细...`);
        const result = await fetchTakealotSales(
          store,
          (pages, rows) => setMessage(`正在同步 ${store}：第 ${pages} 页，已读取 ${rows} 条`),
          { dateFrom, dateTo },
        );
        allSales.push(...result.rows);
      }
      const run = buildCommissionRun({
        shopName: shopName === ALL_STORES ? ALL_STORES : targetStores[0],
        dateFrom,
        dateTo,
        createdAt: new Date().toISOString(),
        profile,
        sales: allSales,
        skuItems,
      });
      await onSaveRun(run);
      setCurrentRun(run);
      setHistoryId(run.id);
      await onRefresh();
      setMessage(`同步完成：有效 SKU ${run.rows.length} 个，异常 ${run.exceptions.length} 个，总提成 ${moneyRmb(run.totalCommissionRmb)}。`);
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : '采购人提成同步失败。');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="panel commission-page">
      <div className="section-heading">
        <div>
          <h2>采购人提成</h2>
          <p>按 Takealot 销售明细计算：提成 = Sales × Selling Price ÷ 3 × 提成比例。销售额先按兰特统计，除以 3 换算人民币。</p>
        </div>
        <div className="export-actions">
          <button type="button" disabled={!selectedRun} onClick={() => selectedRun && exportCommissionRun(selectedRun)}>导出 Excel</button>
          <button className="primary" type="button" disabled={syncing || !dateFrom || !dateTo} onClick={() => void sync()}>
            {syncing ? '同步中...' : '同步提成数据'}
          </button>
        </div>
      </div>

      <div className="profit-analysis-controls">
        <label>店铺
          <select value={shopName} onChange={(event) => { setShopName(event.target.value); setCurrentRun(null); }}>
            {stores.length > 1 && <option value={ALL_STORES}>{ALL_STORES}</option>}
            {stores.map((store) => <option key={store}>{store}</option>)}
          </select>
        </label>
        <label className="monthly-date-control">统计日期
          <DateRangePicker
            startDate={dateFrom}
            endDate={dateTo}
            maxDate={todayIso()}
            onChange={(start, end) => { setDateFrom(start); setDateTo(end); setCurrentRun(null); }}
          />
        </label>
        <label>历史结果
          <select value={selectedRun?.id ?? ''} onChange={(event) => { setHistoryId(event.target.value); setCurrentRun(null); }}>
            <option value="">暂无历史</option>
            {runs.map((run) => <option key={run.id} value={run.id}>{run.dateFrom} 至 {run.dateTo} - {run.shopName}</option>)}
          </select>
        </label>
      </div>

      {message && <div className="inline-notice">{message}</div>}

      {selectedRun && (
        <>
          <div className="repricing-summary">
            <div className="metric"><span>销售额 ZAR</span><strong>{moneyZar(selectedRun.totalSalesRevenueZar)}</strong></div>
            <div className="metric"><span>销售额 RMB</span><strong>{moneyRmb(selectedRun.totalSalesRevenueRmb)}</strong></div>
            <div className="metric"><span>Sales 合计</span><strong>{selectedRun.totalSalesQuantity}</strong></div>
            <div className="metric"><span>总提成 RMB</span><strong>{moneyRmb(selectedRun.totalCommissionRmb)}</strong></div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>采购人</th><th>SKU数</th><th>Sales合计</th><th>销售额 ZAR</th><th>销售额 RMB</th><th>提成比例</th><th>提成金额 RMB</th><th>操作</th></tr>
              </thead>
              <tbody>
                {selectedRun.buyerSummaries.map((row) => {
                  const expanded = expandedBuyers.has(row.buyerName);
                  const detailRows = visibleRowsByBuyer.get(row.buyerName) ?? [];
                  return (
                    <Fragment key={row.buyerName}>
                      <tr>
                        <td><strong>{row.buyerName}</strong></td>
                        <td>{row.skuCount}</td>
                        <td>{row.salesQuantity}</td>
                        <td>{moneyZar(row.salesRevenueZar)}</td>
                        <td>{moneyRmb(row.salesRevenueRmb)}</td>
                        <td>{commissionRateLabel(row.commissionRate)}</td>
                        <td><strong>{moneyRmb(row.commissionAmountRmb)}</strong></td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setExpandedBuyers((current) => {
                              const next = new Set(current);
                              if (next.has(row.buyerName)) next.delete(row.buyerName);
                              else next.add(row.buyerName);
                              return next;
                            })}
                          >
                            {expanded ? '收起明细' : `展开明细 (${detailRows.length})`}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="monthly-sale-detail-row">
                          <td colSpan={8}>
                            <div className="monthly-sale-detail-table">
                              <table>
                                <thead>
                                  <tr><th>内部编号</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>Sales</th><th>Selling Price ZAR</th><th>销售额 ZAR</th><th>销售额 RMB</th><th>提成 RMB</th><th>提示</th></tr>
                                </thead>
                                <tbody>
                                  {detailRows.map((detail) => (
                                    <tr key={detail.id}>
                                      <td>{detail.internalCode || '-'}</td>
                                      <td>{detail.sku}</td>
                                      <td>{detail.productName || '-'}</td>
                                      <td>{detail.englishName || '-'}</td>
                                      <td>{detail.salesQuantity}</td>
                                      <td>{moneyZar(detail.averageSellingPriceZar)}</td>
                                      <td>{moneyZar(detail.salesRevenueZar)}</td>
                                      <td>{moneyRmb(detail.salesRevenueRmb)}</td>
                                      <td><strong>{moneyRmb(detail.commissionAmountRmb)}</strong></td>
                                      <td>{detail.messages.join('；') || '正常'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {selectedRun.buyerSummaries.length === 0 && <tr><td colSpan={8} className="empty">暂无可计算提成的销售数据。</td></tr>}
              </tbody>
            </table>
          </div>

          {selectedRun.exceptions.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>店铺</th><th>SKU</th><th>产品名称</th><th>Sales</th><th>Selling Price ZAR</th><th>销售额 ZAR</th><th>采购人</th><th>异常原因</th></tr>
                </thead>
                <tbody>
                  {selectedRun.exceptions.map((row) => (
                    <tr key={row.id}>
                      <td>{row.shopName}</td>
                      <td>{row.sku}</td>
                      <td>{row.productName || '-'}</td>
                      <td>{row.salesQuantity}</td>
                      <td>{moneyZar(row.averageSellingPriceZar)}</td>
                      <td>{moneyZar(row.salesRevenueZar)}</td>
                      <td>{row.buyerName || '-'}</td>
                      <td>{row.messages.join('；')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!selectedRun && <div className="empty">请选择店铺和日期后同步提成数据，或查看历史结果。</div>}
    </section>
  );
}
