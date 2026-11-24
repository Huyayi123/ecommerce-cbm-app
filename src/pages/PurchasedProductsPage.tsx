import { useMemo, useState } from 'react';
import type { PurchaseRecord, SkuItem, HaichuanWarehouseLot } from '../types';

type Props = { records: PurchaseRecord[]; skuItems: SkuItem[]; lots: HaichuanWarehouseLot[] };
const purchaseStatuses = { pending: '待到货', in_transit: '在途', arrived: '已到货', cancelled: '已取消' };
const warehouseStatuses = { available: '在库可用', partially_reserved: '部分预留', fully_reserved: '全部预留', depleted: '已出库' };
export function PurchasedProductsPage({ records, skuItems, lots }: Props) {
  const [search, setSearch] = useState('');
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
      ...records.filter(r => r.status !== 'cancelled' && (r.poolStatus === 'submitted_to_pool' || r.poolStatus === 'sent_to_inventory')).map(r => ({ ...enrich(r), key: `record-${r.id}`, source: r.poolStatus === 'submitted_to_pool' ? '采购订单池' : '采购 / 在途库存', state: purchaseStatuses[r.status], quantity: r.confirmedPurchaseQuantity ?? r.purchaseQuantity, reference: r.purchaseBatchName || r.purchasePoolName || r.id, date: r.purchaseDate })),
      ...lots.filter(l => l.remainingCartonCount > 0).map(l => ({ ...enrich(l), key: `lot-${l.id}`, source: '海川仓库库存', state: warehouseStatuses[l.status], quantity: l.remainingProductQuantity, reference: recordMap.get(l.purchaseRecordId)?.purchasePoolName || l.purchaseRecordId, date: l.createdAt?.slice(0, 10) || '' })),
    ];
  }, [records, skuItems, lots]);
  const visible = rows.filter(row => (!source || row.source === source) && (!status || row.state === status) && [row.sku, row.productName, row.englishName, row.internalCode].some(value => value.toLowerCase().includes(search.trim().toLowerCase())));
  return <section className="panel">
    <div className="section-header"><div><h2>已采购商品查询</h2><p>只读查询采购订单池、海川仓库现存库存及采购 / 在途库存。海川显示剩余数量，各批次分别展示。</p></div></div>
    <div className="toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
      <label>搜索 <input value={search} onChange={e => setSearch(e.target.value)} placeholder="SKU / 商品名称 / 英文名称 / 内部编号" style={{ minWidth: 280 }} /></label>
      <label>来源 <select value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{['采购订单池', '海川仓库库存', '采购 / 在途库存'].map(s => <option key={s}>{s}</option>)}</select></label>
      <label>状态 <select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{Array.from(new Set(rows.map(r => r.state))).map(s => <option key={s}>{s}</option>)}</select></label>
      <button type="button" onClick={() => { setSearch(''); setSource(''); setStatus(''); }}>重置筛选</button>
    </div>
    <p>共 {visible.length} 条明细</p>
    <div className="table-wrap" style={{ overflowX: 'auto' }}><table><thead><tr>{['图片', 'SKU', '商品名称', '英文名称', '内部编号', '来源', '状态', '数量', '采购人', '采购批次 / 关联记录', '日期'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>
      {visible.map(row => <tr key={row.key}><td>{row.imageUrl ? <img src={row.imageUrl} alt={row.productName} loading="lazy" style={{ width: 48, height: 48, objectFit: 'contain' }} /> : '—'}</td><td>{row.sku}</td><td>{row.productName}</td><td>{row.englishName || '—'}</td><td>{row.internalCode || '—'}</td><td>{row.source}</td><td>{row.state}</td><td>{row.quantity}</td><td>{row.buyerName || '—'}</td><td>{row.reference || '—'}</td><td>{row.date || '—'}</td></tr>)}
      {!visible.length && <tr><td colSpan={11}>暂无符合条件的已采购商品</td></tr>}
    </tbody></table></div>
  </section>;
}
