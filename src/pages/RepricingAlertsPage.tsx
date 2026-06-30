import { useMemo, useState } from 'react';
import type { RepricingAlert, SkuItem } from '../types';

type Props = {
  alerts: RepricingAlert[];
  skuItems: SkuItem[];
  onRefresh?: () => Promise<void>;
};

const TAKEALOT_STORES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

type DatabaseUsage = {
  counts: Record<string, number>;
  checkedAt: string;
};

function money(value: number | null): string {
  if (value === null || value === undefined) return '-';
  return `R ${value.toFixed(2)}`;
}

function formatDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatInactiveSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const labels: Record<string, string> = {
    none: '无预警',
    own_buy_box: '自家 Buy Box',
    own_variant: '自家变体',
    out_of_stock: '缺货',
    variant_uncertain: '变体不确定',
  };
  return Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${labels[key] ?? key} ${Number(count)}`)
    .join('，');
}

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

function enrichAlerts(alerts: RepricingAlert[], skuItems: SkuItem[]): RepricingAlert[] {
  const skuMap = new Map(skuItems.map((item) => [skuKey(item.sku), item]));
  return alerts.map((alert) => {
    const sku = skuMap.get(skuKey(alert.sku));
    return {
      ...alert,
      imageUrl: sku?.imageUrl ?? alert.imageUrl,
      productName: sku?.productName || alert.productName,
    };
  });
}

export function RepricingAlertsPage({ alerts, skuItems, onRefresh }: Props) {
  const [shopFilter, setShopFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncingStore, setSyncingStore] = useState('');
  const [usage, setUsage] = useState<DatabaseUsage | null>(null);
  const [usageMessage, setUsageMessage] = useState('');
  const [isCheckingUsage, setIsCheckingUsage] = useState(false);

  const enrichedAlerts = useMemo(() => enrichAlerts(alerts, skuItems), [alerts, skuItems]);
  const shops = useMemo(() => Array.from(new Set(enrichedAlerts.map((alert) => alert.shopName).filter(Boolean))).sort(), [enrichedAlerts]);
  const summary = useMemo(() => {
    const active = enrichedAlerts
      .filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'))
      .filter((alert) => shopFilter === 'all' || alert.shopName === shopFilter);
    return {
      total: active.length,
      lostBuyBox: active.filter((alert) => alert.alertType === 'lost_buy_box').length,
      followedPrice: active.filter((alert) => alert.alertType === 'followed_price').length,
      shops: new Set(active.map((alert) => alert.shopName).filter(Boolean)).size,
    };
  }, [enrichedAlerts, shopFilter]);

  const filteredAlerts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return enrichedAlerts
      .filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'))
      .filter((alert) => shopFilter === 'all' || alert.shopName === shopFilter)
      .filter((alert) => !term || [alert.sku, alert.productName, alert.title, alert.lowestCompetitorSeller].some((value) => value.toLowerCase().includes(term)))
      .sort((a, b) => (b.priceGap ?? 0) - (a.priceGap ?? 0));
  }, [enrichedAlerts, search, shopFilter]);

  async function syncStore(store: string) {
    setSyncingStore(store);
    setSyncMessage('');
    try {
      const response = await fetch(`/api/repricing-monitor?store=${encodeURIComponent(store)}`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      await onRefresh?.();
      setShopFilter(store);
      const skippedSummary = formatInactiveSummary(payload.inactiveByType);
      setSyncMessage(`${store} 同步完成：检查 ${payload.checked ?? 0} 条，确定被跟价 ${payload.confirmedAlerts ?? 0} 条。${skippedSummary ? `跳过原因：${skippedSummary}` : ''}`);
    } catch (error) {
      console.error(error);
      setSyncMessage(`${store} 同步失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSyncingStore('');
    }
  }

  async function checkDatabaseUsage(action?: 'clear-repricing-snapshots') {
    setIsCheckingUsage(true);
    setUsageMessage('');
    try {
      const url = action ? `/api/database-usage?action=${action}` : '/api/database-usage';
      const response = await fetch(url, { method: action ? 'POST' : 'GET' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setUsage(payload);
      setUsageMessage(action ? '历史价格快照已清空。' : '数据库用量已更新。');
    } catch (error) {
      console.error(error);
      setUsageMessage(`数据库用量操作失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsCheckingUsage(false);
    }
  }

  return (
    <section className="panel repricing-page">
      <div className="section-heading">
        <div>
          <h2>价格预警</h2>
          <p>只显示已经确认有竞争卖家低于我方价格的商品，不会自动改价。</p>
        </div>
        <div className="store-sync-actions">
          {TAKEALOT_STORES.map((store) => (
            <button
              key={store}
              type="button"
              onClick={() => void syncStore(store)}
              disabled={Boolean(syncingStore)}
            >
              {syncingStore === store ? `正在同步 ${store}...` : `同步 ${store}`}
            </button>
          ))}
        </div>
      </div>

      {syncMessage && <div className="inline-notice">{syncMessage}</div>}

      <div className="database-usage-panel">
        <div className="database-usage-actions">
          <button type="button" onClick={() => void checkDatabaseUsage()} disabled={isCheckingUsage}>
            检查数据库用量
          </button>
          <button type="button" onClick={() => void checkDatabaseUsage('clear-repricing-snapshots')} disabled={isCheckingUsage}>
            清空历史快照
          </button>
        </div>
        {usage && (
          <div className="database-usage-counts">
            <span>SKU：{usage.counts.sku_items ?? 0}</span>
            <span>采购记录：{usage.counts.purchase_records ?? 0}</span>
            <span>采购建议：{usage.counts.sales_suggestions ?? 0}</span>
            <span>当前价格预警：{usage.counts.repricing_alerts ?? 0}</span>
            <span>历史快照：{usage.counts.repricing_snapshots ?? 0}</span>
          </div>
        )}
        {usageMessage && <div className="muted-text">{usageMessage}</div>}
      </div>

      <div className="repricing-summary">
        <div className="metric"><span>确定被跟价</span><strong>{summary.total}</strong></div>
        <div className="metric"><span>丢 Buy Box</span><strong>{summary.lostBuyBox}</strong></div>
        <div className="metric"><span>低于我方价格</span><strong>{summary.followedPrice}</strong></div>
        <div className="metric"><span>涉及店铺</span><strong>{summary.shops}</strong></div>
      </div>

      <div className="filter-grid repricing-filter-grid">
        <label>
          店铺
          <select value={shopFilter} onChange={(event) => setShopFilter(event.target.value)}>
            <option value="all">全部店铺</option>
            {shops.map((shop) => <option key={shop} value={shop}>{shop}</option>)}
          </select>
        </label>
        <label>
          搜索
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="SKU、产品名称、竞争卖家" />
        </label>
      </div>

      <div className="table-wrap repricing-table-wrap">
        <table className="repricing-table">
          <thead>
            <tr>
              <th>店铺</th>
              <th>图片</th>
              <th>SKU</th>
              <th>产品名称</th>
              <th>当前售价</th>
              <th>Buy Box</th>
              <th>最低竞品价</th>
              <th>竞争卖家</th>
              <th>差价</th>
              <th>最后检测</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.length === 0 && (
              <tr>
                <td className="empty" colSpan={11}>暂无确定被跟价商品。</td>
              </tr>
            )}
            {filteredAlerts.map((alert) => (
              <tr key={alert.id} className={`repricing-row repricing-${alert.alertLevel}`}>
                <td>{alert.shopName || '-'}</td>
                <td>{alert.imageUrl ? <img className="product-thumb" src={alert.imageUrl} alt="" /> : '-'}</td>
                <td>{alert.sku || '-'}</td>
                <td>
                  <div className="repricing-product-name">{alert.title || alert.productName || '-'}</div>
                  {alert.productName && alert.title && alert.productName !== alert.title && <small>{alert.productName}</small>}
                </td>
                <td>{money(alert.myPrice)}</td>
                <td>{money(alert.buyBoxPrice)}</td>
                <td>{money(alert.lowestCompetitorPrice)}</td>
                <td>{alert.lowestCompetitorSeller || '-'}</td>
                <td>{money(alert.priceGap)}</td>
                <td>{formatDate(alert.checkedAt)}</td>
                <td>{alert.alertMessage || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
