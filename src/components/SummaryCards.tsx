import type { ContainerSummary } from '../types';

type Props = {
  summary: ContainerSummary;
  errorCount: number;
};

export function SummaryCards({ summary, errorCount }: Props) {
  return (
    <section className="summary-grid" aria-label="装柜汇总">
      <div className="metric">
        <span>柜容基准</span>
        <strong>{summary.containerCbm} CBM</strong>
      </div>
      <div className="metric">
        <span>建议采购目标</span>
        <strong>{summary.targetCbm} CBM</strong>
      </div>
      <div className="metric">
        <span>当前总立方数</span>
        <strong>{summary.totalCbm.toFixed(4)} CBM</strong>
      </div>
      <div className="metric">
        <span>距离 70 CBM</span>
        <strong className={summary.remainingCbm < 0 ? 'danger-text' : ''}>
          {summary.remainingCbm.toFixed(4)} CBM
        </strong>
      </div>
      <div className={`status-panel ${summary.statusLevel}`}>
        <span>状态提示</span>
        <strong>{summary.statusText}</strong>
        <small>{errorCount > 0 ? `${errorCount} 行需要处理后才能准确计算` : '采购报表数据已完成匹配'}</small>
      </div>
    </section>
  );
}
