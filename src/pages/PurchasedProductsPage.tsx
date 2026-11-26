import { useMemo, useState } from 'react';
import type { PurchaseRecord, SkuItem, HaichuanWarehouseLot } from '../types';

type Props = { records: PurchaseRecord[]; skuItems: SkuItem[]; lots: HaichuanWarehouseLot[] };
const purchaseStatuses = { pending: '待到货', in_transit: '在途', arrived: '已到货', cancelled: '已取消' };
const warehouseStatuses = { available: '在库可用', partially_reserved: '部分预留', fully_reserved: '全部预留', depleted: '已出库' };
export function PurchasedProductsPage({ records, skuItems, lots }: Props) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [filters, setFilters] = useState({ month: 'recent', manufacturerName: '', shopName: '', buyerName: '', batch: '', loadingType: '', from: '', to: '' });
  const patch = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const rows = useMemo(() => {
    const skuMap = new Map(skuItems.map(item => [item.sku, item]));
    const recordMap = new Map(records.map(item => [item.id, item]));
    const enrich = (item: PurchaseRecord | HaichuanWarehouseLot) => {
      const sku = skuMap.get(item.sku);
      return { ...item, internalCode: item.internalCode || sku?.internalCode || '', englishName: item.englishName || sku?.englishName || '', productName: item.productName || sku?.productName || '', imageUrl: item.imageUrl || sku?.imageUrl || '' };
    };
    return [
      ...records.filter(r => r.status !== 'cancelled' && (r.poolStatus === 'submitted_to_pool' || r.poolStatus === 'sent_to_inventory')).map(r => ({ ...enrich(r), key: `record-${r.id}`, source: r.poolStatus === 'submitted_to_pool' ? '采购订单池' : '采购 / 在途库存', state: purchaseStatuses[r.status], quantity: r.confirmedPurchaseQuantity ?? r.purchaseQuantity, reference: r.purchaseBatchName || r.purchasePoolName || r.id, batch: r.purchaseBatchId || r.purchasePoolId || r.purchaseBatchName || r.purchasePoolName, loadingType: r.loadingType || '整柜', date: r.purchaseDate || r.purchaseBatchDate || r.containerDate || '' })),
      ...lots.filter(l => l.remainingCartonCount > 0).flatMap(lot => (lot.productDetails.length ? lot.productDetails : [null]).map((detail, index) => { const l = detail ? { ...lot, sku: detail.sku, internalCode: detail.internalCode, productName: detail.productName, englishName: detail.englishName, imageUrl: detail.sku === lot.sku ? lot.imageUrl : '', remainingProductQuantity: detail.quantity } : lot; return ({ ...enrich(l), key: `lot-${l.id}-${index}`, source: '海川仓库库存', state: warehouseStatuses[l.status], quantity: l.remainingProductQuantity, reference: recordMap.get(l.purchaseRecordId)?.purchaseBatchName || recordMap.get(l.purchaseRecordId)?.purchasePoolName || l.purchaseRecordId, batch: recordMap.get(l.purchaseRecordId)?.purchaseBatchId || recordMap.get(l.purchaseRecordId)?.purchasePoolId || recordMap.get(l.purchaseRecordId)?.purchaseBatchName || recordMap.get(l.purchaseRecordId)?.purchasePoolName || '', loadingType: '海川', date: recordMap.get(l.purchaseRecordId)?.purchaseDate || recordMap.get(l.purchaseRecordId)?.purchaseBatchDate || '' }); })),
    ];
  }, [records, skuItems, lots]);
  const recentMonths = Array.from({ length: 3 }, (_, index) => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() - index, 1).toLocaleDateString('sv-SE').slice(0, 7); });
  const months = Array.from(new Set(rows.map(row => row.date.slice(0, 7)).filter(Boolean))).sort().reverse();
  const options = (key: 'manufacturerName' | 'shopName' | 'buyerName') => Array.from(new Set(rows.map(row => row[key]).filter(Boolean))).sort();
  const batches = Array.from(new Map(rows.filter(row => row.batch).map(row => [row.batch, row.reference])).entries());
  const visible = submitted === null ? [] : rows.filter(row => {
    if (source && row.source !== source || status && row.state !== status) return false;
    if (filters.month === 'recent' ? !recentMonths.includes(row.date.slice(0, 7)) : filters.month && row.date.slice(0, 7) !== filters.month) return false;
    if (filters.manufacturerName && row.manufacturerName !== filters.manufacturerName || filters.shopName && row.shopName !== filters.shopName || filters.buyerName && row.buyerName !== filters.buyerName) return false;
    if (filters.batch && row.batch !== filters.batch || filters.loadingType && row.loadingType !== filters.loadingType) return false;
    if (filters.from && row.date < filters.from || filters.to && row.date > filters.to) return false;
    return [row.sku, row.productName, row.englishName, row.internalCode, row.manufacturerName, row.buyerName].some(value => value.toLowerCase().includes(submitted.trim().toLowerCase()));
  });
  return <section className="panel">
    <div className="section-header"><div><h2>已采购商品查询</h2><p>只读查询采购订单池、海川仓库现存库存及采购 / 在途库存。海川显示剩余数量，各批次分别展示。</p></div></div>
    <div className="filter-grid inventory-filter-grid">
      <label>采购月份<select value={filters.month} onChange={e => patch('month', e.target.value)}><option value="recent">最近 3 个月</option><option value="">全部月份</option>{months.map(m => <option key={m}>{m}</option>)}</select></label>
      {(['manufacturerName', 'shopName', 'buyerName'] as const).map((key, i) => <label key={key}>{['厂家名', '店铺', '采购人'][i]}<select value={filters[key]} onChange={e => patch(key, e.target.value)}><option value="">全部</option>{options(key).map(v => <option key={v}>{v}</option>)}</select></label>)}
      <label>批次<select value={filters.batch} onChange={e => patch('batch', e.target.value)}><option value="">全部批次</option>{batches.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>装货方式<select value={filters.loadingType} onChange={e => patch('loadingType', e.target.value)}><option value="">全部</option>{['整柜', '冠通', '海川'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>状态<select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部历史</option>{Array.from(new Set(rows.map(r => r.state))).map(v => <option key={v}>{v}</option>)}</select></label>
      <label>采购日期起<input type="date" value={filters.from} onChange={e => patch('from', e.target.value)} /></label>
      <label>采购日期止<input type="date" value={filters.to} onChange={e => patch('to', e.target.value)} /></label>
      <label>来源<select value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{['采购订单池', '海川仓库库存', '采购 / 在途库存'].map(v => <option key={v}>{v}</option>)}</select></label>
    </div>
    <form className="inventory-search-bar" onSubmit={e => { e.preventDefault(); setSubmitted(search); }}>
      <input aria-label="搜索已采购商品" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索 SKU、商品名称、英文名称、内部编号、厂家名、采购人" />
      <button type="submit">搜索</button>
    </form>
    {submitted !== null && <>
    <p>共 {visible.length} 条明细</p>
    <div className="table-wrap" style={{ overflowX: 'auto' }}><table><thead><tr>{['图片', 'SKU', '商品名称', '英文名称', '内部编号', '来源', '状态', '数量', '采购人', '采购批次 / 关联记录', '日期'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>
      {visible.map(row => <tr key={row.key}><td>{row.imageUrl ? <img src={row.imageUrl} alt={row.productName} loading="lazy" style={{ width: 48, height: 48, objectFit: 'contain' }} /> : '—'}</td><td>{row.sku}</td><td>{row.productName}</td><td>{row.englishName || '—'}</td><td>{row.internalCode || '—'}</td><td>{row.source}</td><td>{row.state}</td><td>{row.quantity}</td><td>{row.buyerName || '—'}</td><td>{row.reference || '—'}</td><td>{row.date || '—'}</td></tr>)}
      {!visible.length && <tr><td colSpan={11}>暂无符合条件的已采购商品</td></tr>}
    </tbody></table></div>
    </>}
  </section>;
}
