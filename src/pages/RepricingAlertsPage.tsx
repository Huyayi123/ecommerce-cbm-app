import { useMemo, useState } from 'react';
import type { RepricingAlert, SkuItem } from '../types';

type Props = {
  alerts: RepricingAlert[];
  skuItems: SkuItem[];
  onRefresh?: () => Promise<void>;
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
  const [isSyncing, setIsSyncing] = useState(false);

  const enrichedAlerts = useMemo(() => enrichAlerts(alerts, skuItems), [alerts, skuItems]);
  const shops = useMemo(() => Array.from(new Set(enrichedAlerts.map((alert) => alert.shopName).filter(Boolean))).sort(), [enrichedAlerts]);
  const summary = useMemo(() => {
    const active = enrichedAlerts.filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'));
    return {
      total: active.length,
      lostBuyBox: active.filter((alert) => alert.alertType === 'lost_buy_box').length,
      followedPrice: active.filter((alert) => alert.alertType === 'followed_price').length,
      shops: new Set(active.map((alert) => alert.shopName).filter(Boolean)).size,
    };
  }, [enrichedAlerts]);

  const filteredAlerts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return enrichedAlerts
      .filter((alert) => alert.isActive && (alert.alertLevel === 'high' || alert.alertLevel === 'medium'))
      .filter((alert) => shopFilter === 'all' || alert.shopName === shopFilter)
      .filter((alert) => !term || [alert.sku, alert.productName, alert.title, alert.lowestCompetitorSeller].some((value) => value.toLowerCase().includes(term)))
      .sort((a, b) => (b.priceGap ?? 0) - (a.priceGap ?? 0));
  }, [enrichedAlerts, search, shopFilter]);

  async function syncMegaValue() {
    setIsSyncing(true);
    setSyncMessage('');
    try {
      const response = await fetch('/api/repricing-monitor?store=MegaValue&limit=500', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      await onRefresh?.();
      setSyncMessage(`MegaValue 测试完成：检查 ${payload.checked ?? 0} 条，确定被跟价 ${payload.confirmedAlerts ?? 0} 条。`);
    } catch (error) {
      console.error(error);
      setSyncMessage(`MegaValue 测试失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <section className="panel repricing-page">
      <div className="section-heading">
        <div>
          <h2>价格预警</h2>
          <p>只显示已经确认有竞争卖家低于我方价格的商品，不会自动改价。</p>
        </div>
        <button type="button" onClick={() => void syncMegaValue()} disabled={isSyncing}>
          {isSyncing ? '正在测试 MegaValue...' : '测试 MegaValue 所有数据'}
        </button>
      </div>

      {syncMessage && <div className="inline-notice">{syncMessage}</div>}

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
                  <div className="repricing-product-name">{alert.productName || alert.title || '-'}</div>
                  {alert.productName && alert.title && alert.productName !== alert.title && <small>{alert.title}</small>}
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
