import { useMemo, useState } from 'react';
import type { AppProfile, MonthlyProfitSummary, ProfitAnalysisRun, ProfitAnalysisStatus, SkuItem } from '../types';
import { MonthlyProfitSection } from '../components/MonthlyProfitSection';
import { exportProfitAnalysisRows } from '../utils/exporters';
import { buildProfitAnalysisRows } from '../utils/profitCalculations';
import { fetchTakealotInventory } from '../utils/takealot';
import { fetchTakealotSales } from '../utils/takealotSales';

type Props = {
  skuItems: SkuItem[];
  profile: AppProfile;
  runs: ProfitAnalysisRun[];
  monthlySummaries: MonthlyProfitSummary[];
  onSaveRun: (run: ProfitAnalysisRun) => Promise<void>;
  onSaveMonthlySummary: (summary: MonthlyProfitSummary) => Promise<void>;
  onRefresh: () => Promise<void>;
};

const STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

function statusText(status: ProfitAnalysisStatus): string {
  return { profit: '盈利', loss: '亏损', break_even: '持平', missing_data: '无法计算' }[status];
}

function money(value: number | null): string {
  return value === null ? '-' : `R ${value.toFixed(2)}`;
}

function dateText(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function ProfitAnalysisPage({ skuItems, profile, runs, monthlySummaries, onSaveRun, onSaveMonthlySummary, onRefresh }: Props) {
  const [selectedStore, setSelectedStore] = useState(runs[0]?.shopName ?? STORES[0]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProfitAnalysisStatus | ''>('');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const currentRun = runs.find((run) => run.shopName === selectedStore);
  const rows = currentRun?.rows ?? [];

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => (!term || `${row.sku} ${row.productName}`.toLowerCase().includes(term))
      && (!statusFilter || row.status === statusFilter))
      .sort((left, right) => {
        if (left.profit === null && right.profit === null) return left.sku.localeCompare(right.sku);
        if (left.profit === null) return 1;
        if (right.profit === null) return -1;
        return sortDirection === 'desc' ? right.profit - left.profit : left.profit - right.profit;
      });
  }, [rows, search, sortDirection, statusFilter]);

  const summary = useMemo(() => rows.reduce<Record<string, number>>((result, row) => {
    result.total = (result.total ?? 0) + 1;
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {}), [rows]);

  async function sync() {
    try {
      setIsSyncing(true);
      setMessage('正在同步商品与最近180天销售明细...');
      const [offers, sales] = await Promise.all([
        fetchTakealotInventory(selectedStore, []),
        fetchTakealotSales(selectedStore, (pages, rowCount) => setMessage(`正在同步销售明细：第 ${pages} 页，已读取 ${rowCount} 条...`)),
      ]);
      const runId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const nextRows = buildProfitAnalysisRows({ runId, shopName: selectedStore, syncedAt: createdAt, offers, sales: sales.rows, skuItems });
      const run: ProfitAnalysisRun = { id: runId, shopName: selectedStore, createdAt, createdBy: profile.email, rowCount: nextRows.length, rows: nextRows };
      await onSaveRun(run);
      await onRefresh();
      setMessage(`同步完成：${nextRows.length} 个 SKU，销售明细 ${sales.rows.length} 条，共 ${sales.pagesFetched} 页`);
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : '利润分析同步失败，已保留上次结果');
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <section className="panel profit-analysis-page">
      {profile.role === 'owner' && <MonthlyProfitSection profile={profile} skuItems={skuItems} stores={STORES} summaries={monthlySummaries} onSave={onSaveMonthlySummary} onRefresh={onRefresh} />}
      <div className="section-heading">
        <div><h2>利润分析</h2><p>使用每个 SKU 最近一笔有效成交，结合采购成本、海运费、Total Fees 和送仓费计算单件利润。</p></div>
        <div className="export-actions">
          <button type="button" disabled={visibleRows.length === 0} onClick={() => exportProfitAnalysisRows(visibleRows, selectedStore)}>导出 Excel</button>
          <button className="primary" type="button" disabled={isSyncing} onClick={() => void sync()}>{isSyncing ? '同步中...' : '同步利润数据'}</button>
        </div>
      </div>
      <div className="profit-analysis-controls">
        <label>店铺<select value={selectedStore} onChange={(event) => setSelectedStore(event.target.value)}>{STORES.map((store) => <option key={store}>{store}</option>)}</select></label>
        <label>搜索<input value={search} placeholder="SKU / 产品名称" onChange={(event) => setSearch(event.target.value)} /></label>
        <label>状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ProfitAnalysisStatus | '')}><option value="">全部</option><option value="profit">盈利</option><option value="loss">亏损</option><option value="break_even">持平</option><option value="missing_data">无法计算</option></select></label>
        <label>利润排序<select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as 'desc' | 'asc')}><option value="desc">从高到低</option><option value="asc">从低到高</option></select></label>
        <span>{currentRun ? `最近同步：${dateText(currentRun.createdAt)}` : '该店铺尚未同步'}</span>
      </div>
      {message && <div className="inline-notice">{message}</div>}
      <div className="repricing-summary">
        <div className="metric"><span>SKU 总数</span><strong>{summary.total ?? 0}</strong></div>
        <div className="metric"><span>盈利</span><strong>{summary.profit ?? 0}</strong></div>
        <div className="metric"><span>亏损</span><strong>{summary.loss ?? 0}</strong></div>
        <div className="metric"><span>持平</span><strong>{summary.break_even ?? 0}</strong></div>
        <div className="metric"><span>无法计算</span><strong>{summary.missing_data ?? 0}</strong></div>
      </div>
      <div className="table-wrap profit-analysis-table-wrap">
        <table className="profit-analysis-table">
          <thead><tr><th>图片</th><th>店铺</th><th>SKU</th><th>产品名称</th><th>最近成交时间</th><th>实际成交价</th><th>采购价 RMB</th><th>采购成本 ZAR</th><th>单品 CBM</th><th>海运费</th><th>国内运费</th><th>送仓费</th><th>Total Fees</th><th>单件利润</th><th>状态</th><th>提示</th></tr></thead>
          <tbody>
            {visibleRows.map((row) => <tr key={row.id} className={`profit-row-${row.status}`}>
              <td>{row.imageUrl ? <img className="sku-thumb" src={row.imageUrl} alt={row.productName || row.sku} loading="lazy" /> : '-'}</td><td>{row.shopName}</td><td>{row.sku}</td><td><span className="cell-ellipsis" title={row.productName}>{row.productName || '-'}</span></td><td>{dateText(row.latestOrderDate)}</td><td>{money(row.sellingPrice)}</td><td>{row.purchaseCostRmb === null ? '-' : `¥ ${row.purchaseCostRmb.toFixed(2)}`}</td><td>{money(row.purchaseCostZar)}</td><td>{row.unitCbm === null ? '-' : row.unitCbm.toFixed(8)}</td><td>{money(row.seaFreightCost)}</td><td>{money(row.domesticFreightCost)}</td><td>{money(row.warehouseFee)}</td><td>{money(row.totalFees)}</td><td><strong>{money(row.profit)}</strong></td><td><span className={`repricing-badge ${row.status}`}>{statusText(row.status)}</span></td><td>{row.messages.length ? row.messages.join('；') : '正常'}</td>
            </tr>)}
            {visibleRows.length === 0 && <tr><td colSpan={16} className="empty">暂无利润数据，请选择店铺后同步。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
