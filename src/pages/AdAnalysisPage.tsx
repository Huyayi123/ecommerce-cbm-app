import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { AdAnalysisRun, AppProfile, SkuItem } from '../types';
import { analyzeAdRows, summarizeAdRows } from '../utils/adAnalysis';
import { exportAdAnalysisRows } from '../utils/exporters';
import { parseAdReportFile, type AdReportImportRow } from '../utils/fileParsers';
import { round } from '../utils/number';
import { fetchTakealotInventory, type TakealotInventoryRow } from '../utils/takealot';

type Props = {
  skuItems: SkuItem[];
  profile: AppProfile;
  savedRuns: AdAnalysisRun[];
  onSaveRun: (run: AdAnalysisRun) => Promise<void>;
  onRefresh: () => Promise<void>;
};

const DEFAULT_STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];
const AD_ANALYSIS_DRAFT_STORAGE_KEY = 'ecommerce-cbm-ad-analysis-draft';

type AdAnalysisDraft = {
  reportRows: AdReportImportRow[];
  inventoryRows: TakealotInventoryRow[];
  fileName: string;
  selectedStore: string;
};

function loadAdAnalysisDraft(): AdAnalysisDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AD_ANALYSIS_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AdAnalysisDraft>;
    return {
      reportRows: Array.isArray(parsed.reportRows) ? parsed.reportRows : [],
      inventoryRows: Array.isArray(parsed.inventoryRows) ? parsed.inventoryRows : [],
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
      selectedStore: typeof parsed.selectedStore === 'string' ? parsed.selectedStore : '',
    };
  } catch {
    localStorage.removeItem(AD_ANALYSIS_DRAFT_STORAGE_KEY);
    return null;
  }
}

function compactReportRows(rows: AdReportImportRow[]): AdReportImportRow[] {
  return rows.map((row) => ({ ...row, raw: {} }));
}

function compactInventoryRows(rows: TakealotInventoryRow[]): TakealotInventoryRow[] {
  return rows.map(({ raw: _raw, ...row }) => row);
}

function saveAdAnalysisDraft(draft: AdAnalysisDraft): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(AD_ANALYSIS_DRAFT_STORAGE_KEY, JSON.stringify({
      reportRows: compactReportRows(draft.reportRows),
      inventoryRows: compactInventoryRows(draft.inventoryRows),
      fileName: draft.fileName,
      selectedStore: draft.selectedStore,
    }));
  } catch (error) {
    console.warn('广告分析草稿缓存失败', error);
  }
}

function clearAdAnalysisDraft(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AD_ANALYSIS_DRAFT_STORAGE_KEY);
}

function labelClass(value: string): string {
  if (value === 'green_star') return 'good';
  if (value === 'yellow_cow') return 'near';
  if (value === 'orange_question' || value === 'new_optimize') return 'review';
  if (value === 'loss_product' || value === 'no_profit') return 'stop';
  return 'none';
}

function ageStatusText(value: string): string {
  const map: Record<string, string> = {
    protection: '新品保护期',
    new: '新品',
    old: '老品',
    unknown: '未知',
  };
  return map[value] ?? value;
}

function percentText(value: number | null): string {
  return value === null ? '-' : `${round(value * 100, 2)}%`;
}

function dateText(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN');
}

export function AdAnalysisPage({ skuItems, profile, savedRuns, onSaveRun, onRefresh }: Props) {
  const [reportRows, setReportRows] = useState<AdReportImportRow[]>(() => loadAdAnalysisDraft()?.reportRows ?? []);
  const [inventoryRows, setInventoryRows] = useState<TakealotInventoryRow[]>(() => loadAdAnalysisDraft()?.inventoryRows ?? []);
  const [fileName, setFileName] = useState(() => loadAdAnalysisDraft()?.fileName ?? '');
  const [selectedStore, setSelectedStore] = useState(() => loadAdAnalysisDraft()?.selectedStore ?? '');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [message, setMessage] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const storeOptions = useMemo(() => {
    const fromSku = skuItems.map((item) => item.shopName.trim()).filter(Boolean);
    const fromRuns = savedRuns.flatMap((run) => run.rows.map((row) => row.shopName.trim()).filter(Boolean));
    return Array.from(new Set([...DEFAULT_STORES, ...fromSku, ...fromRuns]));
  }, [savedRuns, skuItems]);

  const visibleRuns = useMemo(() => savedRuns.filter((run) => run.rows.length > 0), [savedRuns]);
  const currentRun = useMemo(() => visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0], [selectedRunId, visibleRuns]);
  const currentRows = currentRun?.rows ?? [];

  const draftRows = useMemo(() => {
    if (reportRows.length === 0) return [];
    const runId = `draft-${Date.now()}`;
    const scopedReportRows = selectedStore
      ? reportRows.map((row) => ({ ...row, shopName: row.shopName || selectedStore }))
      : reportRows;
    return analyzeAdRows({ runId, reportRows: scopedReportRows, skuItems, inventoryRows });
  }, [inventoryRows, reportRows, selectedStore, skuItems]);

  const displayRows = draftRows.length > 0 ? draftRows : currentRows;
  const displaySummary = useMemo(() => summarizeAdRows(displayRows), [displayRows]);

  useEffect(() => {
    if (reportRows.length === 0) {
      clearAdAnalysisDraft();
      return;
    }
    saveAdAnalysisDraft({ reportRows, inventoryRows, fileName, selectedStore });
  }, [fileName, inventoryRows, reportRows, selectedStore]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const rows = await parseAdReportFile(file);
    setReportRows(rows);
    setFileName(file.name);
    setSelectedRunId('');
    setMessage(`已导入 ${rows.length} 条广告报表记录`);
    event.target.value = '';
  }

  async function syncTakealot() {
    if (!selectedStore) {
      setMessage('请先选择店铺，再同步 Takealot 售价和平台税费');
      return;
    }
    try {
      setIsSyncing(true);
      const tsins = reportRows.map((row) => row.sku).filter(Boolean);
      const rows = await fetchTakealotInventory(selectedStore, tsins);
      setInventoryRows(rows);
      setMessage(`已同步 ${rows.length} 条 ${selectedStore} Takealot 数据`);
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : '同步 Takealot 数据失败');
    } finally {
      setIsSyncing(false);
    }
  }

  async function saveAnalysis() {
    if (draftRows.length === 0) {
      setMessage('请先导入广告报表并生成分析结果');
      return;
    }
    const runId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const rows = draftRows.map((row, index) => ({
      ...row,
      id: `${runId}-${index + 1}-${row.sku || row.productName || 'row'}`,
      runId,
    }));
    const run: AdAnalysisRun = {
      id: runId,
      createdAt,
      createdBy: profile.email,
      sourceFileName: fileName,
      rowCount: rows.length,
      summary: summarizeAdRows(rows),
      rows,
    };
    try {
      setIsSaving(true);
      await onSaveRun(run);
      setReportRows([]);
      setInventoryRows([]);
      setFileName('');
      clearAdAnalysisDraft();
      setSelectedRunId(runId);
      setMessage('广告分析结果已保存，系统只保留最近三次');
      await onRefresh();
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : '保存广告分析结果失败');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="panel ad-analysis-page">
      <div className="section-heading">
        <div>
          <h2>广告分析</h2>
          <p>导入广告报表后，结合 TSIN、成本、CBM 和 Takealot 售价生成广告调整建议；只输出建议，不自动修改广告。</p>
        </div>
        <div className="export-actions">
          <label className="file-button">
            导入广告报表
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} />
          </label>
          <button type="button" onClick={() => exportAdAnalysisRows(displayRows, 'xlsx')} disabled={displayRows.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportAdAnalysisRows(displayRows, 'csv')} disabled={displayRows.length === 0}>导出 CSV</button>
        </div>
      </div>

      <div className="ad-analysis-controls">
        <label>
          店铺
          <select value={selectedStore} onChange={(event) => {
            setSelectedStore(event.target.value);
            setInventoryRows([]);
          }}>
            <option value="">全部店铺</option>
            {storeOptions.map((store) => <option key={store} value={store}>{store}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void syncTakealot()} disabled={!selectedStore || isSyncing}>
          {isSyncing ? '同步中...' : '同步 Takealot 售价'}
        </button>
        <button className="primary" type="button" onClick={() => void saveAnalysis()} disabled={draftRows.length === 0 || isSaving}>
          {isSaving ? '保存中...' : '保存分析结果'}
        </button>
        <label>
          最近三次结果
          <select value={selectedRunId || currentRun?.id || ''} onChange={(event) => {
            setSelectedRunId(event.target.value);
            setReportRows([]);
            setInventoryRows([]);
            setFileName('');
            clearAdAnalysisDraft();
          }}>
            {visibleRuns.length === 0 && <option value="">暂无历史</option>}
            {visibleRuns.map((run) => <option key={run.id} value={run.id}>{dateText(run.createdAt)} - {run.sourceFileName || '广告分析'}</option>)}
          </select>
        </label>
        <span>{fileName ? `当前导入：${fileName}` : currentRun ? `当前历史：${dateText(currentRun.createdAt)}` : '请先导入广告报表'}</span>
      </div>

      {message && <div className="inline-notice">{message}</div>}

      <div className="repricing-summary">
        <div className="metric"><span>分析记录</span><strong>{displaySummary.total ?? 0}</strong></div>
        <div className="metric"><span>高效盈利</span><strong>{displaySummary.green_star ?? 0}</strong></div>
        <div className="metric"><span>持续优化</span><strong>{(displaySummary.yellow_cow ?? 0) + (displaySummary.orange_question ?? 0) + (displaySummary.new_optimize ?? 0)}</strong></div>
        <div className="metric"><span>建议暂停</span><strong>{(displaySummary.loss_product ?? 0) + (displaySummary.no_profit ?? 0)}</strong></div>
      </div>

      <div className="table-wrap ad-analysis-table-wrap">
        <table className="ad-analysis-table">
          <thead>
            <tr>
              <th>图片</th><th>店铺</th><th>TSIN</th><th>产品名称</th><th>广告花费</th><th>广告销量</th><th>ROAS</th><th>售价</th><th>采购成本RMB</th><th>采购成本兰特</th><th>平台税费</th><th>海运费</th><th>送仓费</th><th>单次广告成本</th><th>利润率</th><th>TSIN排名</th><th>新品状态</th><th>分类</th><th>执行动作</th><th>提示</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.id}>
                <td>{row.imageUrl ? <img className="sku-thumb" src={row.imageUrl} alt={row.productName || row.sku} loading="lazy" /> : '-'}</td>
                <td>{row.shopName || '-'}</td>
                <td>{row.sku || '-'}</td>
                <td><div className="ad-product-name" title={row.productName}>{row.productName || '-'}</div></td>
                <td>{row.adSpend}</td>
                <td>{row.adSalesQuantity}</td>
                <td>{row.roas ?? '-'}</td>
                <td>{row.salePrice || '-'}</td>
                <td>{row.purchaseCostRmb || '-'}</td>
                <td>{row.purchaseCostZar || '-'}</td>
                <td>{row.platformFee || '-'}{row.platformFeeSource === 'fallback' ? ' (40%)' : ''}</td>
                <td>{row.seaFreightCost || '-'}</td>
                <td>{row.warehouseFee || '-'}</td>
                <td>{row.adCostPerSale || '-'}</td>
                <td>{percentText(row.profitRate)}</td>
                <td>{row.skuRank ?? '-'}</td>
                <td>{ageStatusText(row.productAgeStatus)}</td>
                <td><span className={`repricing-badge ${labelClass(row.strategyLabel)}`}>{row.strategyName}</span></td>
                <td>{row.actionSuggestion}</td>
                <td>{row.messages.length > 0 ? row.messages.join('；') : '正常'}</td>
              </tr>
            ))}
            {displayRows.length === 0 && <tr><td colSpan={20} className="empty">导入广告报表后生成分析，或查看最近三次历史分析结果。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
