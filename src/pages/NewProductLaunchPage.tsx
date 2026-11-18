import { BarcodeGenerator } from '../components/BarcodeGenerator';
import type { PurchaseRecord } from '../types';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { CANONICAL_SHOP_NAMES } from '../utils/shops';
import './new-product-launch.css';

type Launch = {
  id: string; sku: string; product_name: string; image_path: string; live_store: string;
  shipping_mark: string | null; status: 'pending_arrival' | 'received'; created_by: string;
  received_by_name: string | null; received_at: string | null; version: number; imageUrl?: string;
};
type InboundDetails = { inbound_code: string; official_sku: string; live_store: string; shipping_mark: string; image_path: string | null; imageUrl?: string };
type Action = 'correct_sku' | 'undo_receipt' | 'edit_details';
const bucket = 'new-product-launch';
const imageTypes = 'image/jpeg,image/png,image/webp';

export function NewProductLaunchPage({ userId, admin, purchaseRecords, onRefreshPurchases }: {
  userId: string; admin: boolean; purchaseRecords: PurchaseRecord[]; onRefreshPurchases: () => Promise<void>;
}) {
  const [inboundDetails, setInboundDetails] = useState<Record<string, InboundDetails>>({});
  const [editingInbound, setEditingInbound] = useState<PurchaseRecord | null>(null);
  const [view, setView] = useState<"list" | "add" | "barcode" | "inbound-edit">("list");
  const [rows, setRows] = useState<Launch[]>([]);
  const requestNumber = useRef(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [store, setStore] = useState('');
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ row: Launch; action: Action } | null>(null);
  const [history, setHistory] = useState<Array<{ action: string; actor: string; reason: string; created_at: string; before_change: Launch; after_change: Launch }> | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const request = ++requestNumber.current;
    setLoading(true);
    setLoadError('');
    try {
      let query = supabase.from('new_product_launches').select('*', { count: 'exact' });
      if (status) query = query.eq('status', status);
      if (store) query = query.eq('live_store', store);
      const term = search.trim();
      if (term) query = /^[0-9]+$/.test(term) ? query.ilike('sku', `%${term}%`) : query.ilike('product_name', `%${term}%`);
      const result = await query.order('created_at', { ascending: false }).order('id').range(page * 25, page * 25 + 24);
      if (result.error) throw result.error;
      const items = result.data as Launch[];
      const paths = [...new Set(items.map((item) => item.image_path))];
      const images = paths.length ? await supabase.storage.from(bucket).createSignedUrls(paths, 3600) : null;
      const urls = new Map(images?.data?.map((image) => [image.path, image.signedUrl]));
      if (request !== requestNumber.current) return;
      setRows(items.map((item) => ({ ...item, imageUrl: urls.get(item.image_path) ?? undefined })));
      setCount(result.count ?? 0);
    } catch (failure) {
      if (request === requestNumber.current) setLoadError((failure as Error).message);
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, [page, search, status, store]);

  useEffect(() => { void load(); }, [load]);

  const shipmentsByPurchase = new Map<string, PurchaseRecord[]>();
  for (const record of purchaseRecords) {
    if (!record.logisticsSourceRecordId || record.status === 'cancelled') continue;
    const shipments = shipmentsByPurchase.get(record.logisticsSourceRecordId) ?? [];
    shipments.push(record);
    shipmentsByPurchase.set(record.logisticsSourceRecordId, shipments);
  }

  function arrivalStatus(record: PurchaseRecord) {
    const shipments = shipmentsByPurchase.get(record.id);
    if (!shipments?.length) return record.status;
    if (shipments.every((shipment) => shipment.status === 'arrived')) return 'arrived';
    if (shipments.some((shipment) => shipment.status === 'arrived' || shipment.status === 'in_transit')) return 'in_transit';
    return record.status;
  }

  const loadInboundDetails = useCallback(async () => {
    if (!supabase) return;
    const result = await supabase.from('new_product_inbound_details').select('*');
    if (result.error) throw result.error;
    const details = result.data as InboundDetails[];
    const paths = details.flatMap((detail) => detail.image_path ? [detail.image_path] : []);
    const images = paths.length ? await supabase.storage.from(bucket).createSignedUrls(paths, 3600) : null;
    const urls = new Map(images?.data?.map((image) => [image.path, image.signedUrl]));
    setInboundDetails(Object.fromEntries(details.map((detail) => [
      detail.inbound_code, { ...detail, imageUrl: detail.image_path ? urls.get(detail.image_path) ?? undefined : undefined },
    ])));
  }, []);

  useEffect(() => {
    void loadInboundDetails().catch((failure) => setError(failure.message));
  }, [loadInboundDetails]);

  async function saveInboundDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !editingInbound || busy) return;
    const data = new FormData(event.currentTarget);
    const value = (field: string) => String(data.get(field) ?? '').trim();
    const code = editingInbound.sku.toLowerCase();
    let imagePath = inboundDetails[code]?.image_path ?? null;
    setBusy(true);
    setError('');
    try {
      const file = data.get('image');
      if (file instanceof File && file.size) {
        if (!imageTypes.split(',').includes(file.type) || file.size > 5 * 1024 * 1024) {
          throw new Error('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片');
        }
        imagePath = userId + '/' + crypto.randomUUID();
        const uploaded = await supabase.storage.from(bucket).upload(imagePath, file);
        if (uploaded.error) throw uploaded.error;
      }
      const result = await supabase.from('new_product_inbound_details').upsert({
        inbound_code: code,
        official_sku: value('sku'),
        live_store: value('store'),
        shipping_mark: value('mark'),
        image_path: imagePath,
      });
      if (result.error) throw result.error;
      await loadInboundDetails();
      setEditingInbound(null);
      setView("list");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const purchaseTerm = search.trim().toLowerCase();
  const newPurchases = purchaseRecords.filter((record) => {
    if (!/^new[0-9]{5}$/i.test(record.sku) || record.logisticsSourceRecordId || record.status === 'cancelled') return false;
    if (record.poolStatus !== 'submitted_to_pool' && record.poolStatus !== 'sent_to_inventory') return false;
    const details = inboundDetails[record.sku.toLowerCase()];
    if (store && (details?.live_store ?? record.shopName) !== store) return false;
    if (status && (status === 'received') !== (arrivalStatus(record) === 'arrived')) return false;
    return [record.sku, record.productName, record.englishName, details?.official_sku ?? '', details?.shipping_mark ?? ''].some((value) => value.toLowerCase().includes(purchaseTerm));
  });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (field: string) => String(data.get(field) ?? '').trim();
    const file = data.get('image');
    let imagePath = editing?.row.image_path;
    setBusy(true);
    setError('');
    try {
      if (file instanceof File && file.size) {
        if (!imageTypes.split(',').includes(file.type) || file.size > 5 * 1024 * 1024) {
          throw new Error('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片');
        }
        imagePath = `${userId}/${crypto.randomUUID()}.${file.type.split('/')[1]}`;
        const upload = await supabase.storage.from(bucket).upload(imagePath, file);
        if (upload.error) throw upload.error;
      }
      if (!imagePath) throw new Error('请上传主图');
      const details = { product_name: value('product_name'), live_store: value('live_store'), shipping_mark: value('shipping_mark') || null, image_path: imagePath };
      const result = editing
        ? await supabase.rpc('correct_new_product_launch', {
          p_id: editing.row.id, p_version: editing.row.version, p_action: editing.action,
          p_sku: value('sku'), p_reason: value('reason'), p_name: details.product_name,
          p_store: details.live_store, p_mark: details.shipping_mark, p_image: details.image_path,
        })
        : await supabase.from('new_product_launches').insert({ sku: value('sku'), ...details });
      if (result.error) throw result.error;
      form.reset();
      setEditing(null);
      setView("list");
      setHistory(null);
      await load();
    } catch (failure) {
      const problem = failure as { code?: string; message: string };
      setError(problem.code === '23505' ? '该店铺已存在相同 SKU' : problem.message);
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(id: string) {
    if (!supabase) return;
    const result = await supabase.from('new_product_launch_history').select('*').eq('launch_id', id).order('id', { ascending: false });
    if (result.error) setError(result.error.message);
    else setHistory(result.data);
  }

  const showDetails = !editing || editing.action === 'edit_details';
  return <section className="launch-page">
    <h1>New Product Launch</h1>
    <nav className="launch-tabs" aria-label="新品管理">
      <button type="button" disabled={busy} aria-pressed={view === "list"} onClick={() => { setView("list"); setEditing(null); setError(""); }}>新品列表</button>
      <button type="button" disabled={busy} aria-pressed={view === "add"} onClick={() => { setView("add"); setEditing(null); setError(""); }}>新增新品</button>
      <button type="button" disabled={busy} aria-pressed={view === "barcode"} onClick={() => { setView("barcode"); setEditing(null); setError(""); }}>条形码生成</button>
    </nav>
    {view === "barcode" && <BarcodeGenerator />}
    {view === "inbound-edit" && editingInbound && <form className="launch-card launch-form" onSubmit={saveInboundDetails}>
      <h2>编辑资料 · {editingInbound.sku}</h2>
      <label>产品图片<input name="image" type="file" accept={imageTypes} /></label>
      <label>正式 SKU<input name="sku" inputMode="numeric" pattern="[0-9]*" defaultValue={inboundDetails[editingInbound.sku.toLowerCase()]?.official_sku} /></label>
      <label>上架店铺<select name="store" defaultValue={inboundDetails[editingInbound.sku.toLowerCase()]?.live_store ?? editingInbound.shopName}>
        <option value="">未填写</option>{CANONICAL_SHOP_NAMES.map((name) => <option key={name}>{name}</option>)}
      </select></label>
      <label>Shipping Mark<input name="mark" defaultValue={inboundDetails[editingInbound.sku.toLowerCase()]?.shipping_mark} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>保存</button>
      <button type="button" disabled={busy} onClick={() => { setEditingInbound(null); setView("list"); setError(""); }}>取消</button>
    </form>}
    {view === "add" && <div className="launch-card">
    <h2>{editing ? { edit_details: '修改新品资料', correct_sku: '纠正 SKU', undo_receipt: '撤销到货确认' }[editing.action] : 'Add New Product'}</h2>
    <form key={editing ? `${editing.row.id}-${editing.action}` : 'new'} onSubmit={save}>
      <fieldset disabled={busy}>
        {showDetails && <label className="launch-upload"><strong>Upload Product Image</strong><span>上传一张产品主图</span><input aria-label="产品主图" name="image" type="file" accept={imageTypes} required={!editing} /></label>}
        {(!editing || editing.action === 'correct_sku') && <label>SKU <input name="sku" inputMode="numeric" pattern="[0-9]+" required defaultValue={editing?.row.sku} /></label>}
        {showDetails && <>
          <label>产品名称 <input name="product_name" required defaultValue={editing?.row.product_name} /></label>
          <label>Live Store <select name="live_store" required defaultValue={editing?.row.live_store ?? ''}>
            <option value="">选择店铺</option>
            {CANONICAL_SHOP_NAMES.map((shop) => <option key={shop}>{shop}</option>)}
          </select></label>
          <label>唛头名称（选填） <input name="shipping_mark" defaultValue={editing?.row.shipping_mark ?? ''} /></label>

        </>}
        {editing && <label>操作原因 <input name="reason" required /></label>}
        <button className="launch-save" type="submit">{busy ? '保存中…' : '保存'}</button>
        {editing && <button type="button" onClick={() => { setEditing(null); setView("list"); setError(''); }}>取消</button>}
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    </div>}
    {view === "list" && <div className="launch-card">
    <h2>新品列表</h2>
    <div className="launch-filters">
    <input aria-label="搜索新品" placeholder="SKU、入仓单码或产品名称" value={search} onChange={(event) => { setPage(0); setSearch(event.target.value); }} />
    <select aria-label="到货状态" value={status} onChange={(event) => { setPage(0); setStatus(event.target.value); }}>
      <option value="">全部状态</option><option value="pending_arrival">Pending Arrival</option><option value="received">Received</option>
    </select>
    <select aria-label="店铺" value={store} onChange={(event) => { setPage(0); setStore(event.target.value); }}>
      <option value="">全部店铺</option>{CANONICAL_SHOP_NAMES.map((shop) => <option key={shop}>{shop}</option>)}
    </select>
    <button type="button" onClick={() => { void load(); void onRefreshPurchases(); }} disabled={loading}>刷新</button>
    </div>
    {loadError && <p role="alert">{loadError}</p>}
    {loading && <p role="status">加载中…</p>}
    {!loading && !loadError && !rows.length && !newPurchases.length && <p className="launch-empty">暂无新品记录</p>}
    {(rows.length > 0 || (page === 0 && newPurchases.length > 0)) && <div className="launch-table">
      <table>
        <thead><tr>{['Product Image', 'SKU', '新品入仓单码', 'Product Name', 'Live Store', 'Shipping Mark', 'Status', 'Received By', 'Received At', 'Actions'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
        <tbody>{page === 0 && newPurchases.map((record) => {
          const details = inboundDetails[record.sku.toLowerCase()];
          const imageUrl = details?.imageUrl || record.imageUrl;
          return <tr key={record.id}>
          <td>{imageUrl ? <img className="launch-thumbnail" src={imageUrl} alt={record.productName || record.englishName} loading="lazy" /> : '—'}</td>
          <td>{details?.official_sku || '—'}</td><td>{record.sku}</td><td>{record.productName || record.englishName}</td><td>{(details?.live_store ?? record.shopName) || '—'}</td><td>{details?.shipping_mark || '—'}</td>
          <td>{arrivalStatus(record) === 'arrived' ? '已到货' : arrivalStatus(record) === 'in_transit' ? '海运在途' : '待到货'}</td>
          <td>—</td><td>—</td><td><button type="button" onClick={() => { setEditingInbound(record); setError(""); setView("inbound-edit"); }}>编辑资料</button></td>
        </tr>; })}{rows.map((row) => <tr key={row.id}>
          <td>{row.imageUrl ? <a className="launch-thumbnail" href={row.imageUrl} target="_blank" rel="noreferrer" aria-label={`查看 ${row.product_name} 主图`}><img src={row.imageUrl} alt={row.product_name} loading="lazy" /></a> : '—'}</td>
          <td>{row.sku}</td><td>—</td><td>{row.product_name}</td><td>{row.live_store}</td><td>{row.shipping_mark || '未填写'}</td>
          <td><span className={`launch-status ${row.status}`}>{row.status === 'received' ? 'Received' : 'Pending Arrival'}</span></td><td>{row.received_by_name ?? '—'}</td>
          <td>{row.received_at ? new Date(row.received_at).toLocaleString() : '—'}</td>
          <td>{(admin || row.created_by === userId) && <>
            <button disabled={busy} onClick={() => { setEditing({ row, action: 'correct_sku' }); setView("add"); }}>纠正 SKU</button>
            <button disabled={busy} onClick={() => { setEditing({ row, action: row.status === 'received' ? 'undo_receipt' : 'edit_details' }); setView("add"); }}>{row.status === 'received' ? '撤销确认' : '编辑资料'}</button>
            <button onClick={() => void showHistory(row.id)}>操作历史</button>
          </>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <button disabled={loading || page === 0} onClick={() => setPage(page - 1)}>上一页</button>
    <button disabled={loading || (page + 1) * 25 >= count} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
    {view === "list" && history && <section>
      <h2>操作历史</h2><button onClick={() => setHistory(null)}>关闭历史</button>
      {!history.length && <p>暂无操作记录</p>}
      <ul>{history.map((entry) => <li key={`${entry.created_at}-${entry.action}`}>
        {new Date(entry.created_at).toLocaleString()} · {entry.actor} · {entry.reason}
        {entry.action === 'correct_sku' && ` · SKU ${entry.before_change.sku} → ${entry.after_change.sku}`}
        {entry.action === 'undo_receipt' && ` · 原确认 ${entry.before_change.received_by_name} ${entry.before_change.received_at}`}
      </li>)}</ul>
    </section>}
  </section>;
}
