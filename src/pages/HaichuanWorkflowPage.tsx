import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AppProfile, HaichuanData, HaichuanLoadingBatch, HaichuanLoadingItem, HaichuanProductDetail, HaichuanWarehouseLot } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { calculateHaichuanLoadingSuggestion } from '../utils/haichuan';
import { purchaseColumnLabels as labels } from '../utils/purchaseColumns';

type LoadingSelection = Record<string, number>;
type ReviewDraft = Record<string, { cartons: number; quantity: number; cbm: number; note: string }>;

type Props = {
  profile: AppProfile;
  profiles: AppProfile[];
  data: HaichuanData;
  onRefresh: () => Promise<void>;
  onConfirmReceipt: (inboundId: string, actualCartonCount: number) => Promise<void>;
  onSubmitBatch: (input: {
    id: string;
    containerDate: string;
    note: string;
    items: Array<{ warehouseLotId: string; requestedCartonCount: number; note?: string }>;
  }) => Promise<void>;
  onReviewBatch: (input: {
    batchId: string;
    containerDate: string;
    note: string;
    approve: boolean;
    rejectionReason?: string;
    items: Array<{ id: string; approvedCartonCount: number; approvedProductQuantity: number; approvedCbm: number; note?: string }>;
  }) => Promise<void>;
  onSaveProfile: (profile: AppProfile) => Promise<void>;
};

function valueText(value: number, digits = 4): string {
  return Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '0';
}

function includesSearch(values: string[], search: string): boolean {
  const keyword = search.trim().toLowerCase();
  return !keyword || values.some((value) => value.toLowerCase().includes(keyword));
}

function loadingStatusLabel(status: HaichuanLoadingBatch['status']): string {
  if (status === 'submitted') return '审核中';
  if (status === 'approved') return '已装柜';
  if (status === 'rejected') return '已退回';
  return '编辑中';
}

function warehouseStatusLabel(lot: HaichuanWarehouseLot): string {
  if (lot.status === 'depleted') return '已装完';
  if (lot.status === 'fully_reserved') return '全部审核中';
  if (lot.status === 'partially_reserved') return '部分审核中';
  return '可装柜';
}

function mainProductDetail(details: HaichuanProductDetail[]): HaichuanProductDetail | undefined {
  return details.find((detail) => !detail.isMixed) ?? details[0];
}

function mixedProductDetails(details: HaichuanProductDetail[]): HaichuanProductDetail[] {
  return details.filter((detail) => detail.isMixed);
}

function productCells(detail: HaichuanProductDetail | undefined, fallback: { productName: string; englishName?: string; internalCode: string; sku: string }) {
  const productName = detail?.productName || fallback.productName || '-';
  const englishName = detail?.englishName || fallback.englishName || '-';
  const internalCode = detail?.internalCode || fallback.internalCode || '-';
  const sku = detail?.sku || fallback.sku || '-';
  return <>
    <td className="haichuan-pin haichuan-pin-product"><span className="cell-ellipsis" title={productName}>{productName}</span></td>
    <td className="haichuan-pin haichuan-pin-english"><span className="cell-ellipsis" title={englishName}>{englishName}</span></td>
    <td className="haichuan-pin haichuan-pin-code"><span className="cell-ellipsis" title={internalCode}>{internalCode}</span></td>
    <td className="haichuan-pin haichuan-pin-sku"><span className="cell-ellipsis" title={sku}>{sku}</span></td>
  </>;
}

function mixedNote(detail: HaichuanProductDetail): string {
  const group = detail.mixedGroupName || '混装组';
  const cartons = detail.mixedGroupCartonCount > 0 ? ` ${detail.mixedGroupCartonCount}件` : '';
  return `${group}${cartons} · 混装子行`;
}

export function HaichuanWorkflowPage({
  profile,
  profiles,
  data,
  onRefresh,
  onConfirmReceipt,
  onSubmitBatch,
  onReviewBatch,
  onSaveProfile,
}: Props) {
  const isLogistics = profile.role === 'logistics';
  const [tab, setTab] = useState(isLogistics ? 'inbound' : 'warehouse');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, number>>({});
  const [selectedLots, setSelectedLots] = useState<LoadingSelection>({});
  const [containerDate, setContainerDate] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [activeBatchId, setActiveBatchId] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraft>({});

  const pendingInbound = useMemo(() => data.inboundItems.filter((item) => item.status === 'pending_receipt' && includesSearch([
    item.sku, item.productName, item.englishName, item.internalCode,
    ...item.productDetails.flatMap((detail) => [detail.sku, detail.productName, detail.englishName, detail.internalCode]),
  ], search)), [data.inboundItems, search]);
  const visibleLots = useMemo(() => data.warehouseLots.filter((lot) => lot.remainingCartonCount > 0 && includesSearch([
    lot.sku, lot.productName, lot.englishName, lot.internalCode,
    ...lot.productDetails.flatMap((detail) => [detail.sku, detail.productName, detail.englishName, detail.internalCode]),
  ], search)), [data.warehouseLots, search]);
  const submittedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'submitted'), [data.loadingBatches]);
  const approvedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'approved'), [data.loadingBatches]);
  const rejectedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'rejected'), [data.loadingBatches]);
  const loadedProducts = useMemo(() => approvedBatches.flatMap((batch) => batch.items.map((item) => ({ batch, item }))), [approvedBatches]);
  const activeBatch = submittedBatches.find((batch) => batch.id === activeBatchId) ?? submittedBatches[0] ?? null;

  useEffect(() => {
    setReceiptDrafts((current) => {
      const next = { ...current };
      for (const item of data.inboundItems) {
        if (next[item.id] === undefined) next[item.id] = item.declaredTotalCartonCount;
      }
      return next;
    });
  }, [data.inboundItems]);

  useEffect(() => {
    if (!activeBatch) return;
    setActiveBatchId(activeBatch.id);
    setReviewDate(activeBatch.containerDate);
    setReviewNote(activeBatch.note);
    setReviewDrafts(Object.fromEntries(activeBatch.items.map((item) => [item.id, {
      cartons: item.approvedCartonCount ?? item.requestedCartonCount,
      quantity: item.approvedProductQuantity ?? item.suggestedProductQuantity,
      cbm: item.approvedCbm ?? item.suggestedCbm,
      note: item.note,
    }])));
  }, [activeBatch?.id]);

  async function runAction(key: string, action: () => Promise<void>, successMessage: string) {
    if (busyKey) return;
    setBusyKey(key);
    setMessage(key.startsWith('review') ? '正在处理审核...' : '正在提交...');
    try {
      await action();
      setMessage(successMessage);
      await onRefresh();
    } catch (error) {
      setMessage(`操作失败：${formatErrorMessage(error)}`);
    } finally {
      setBusyKey('');
    }
  }

  async function confirmReceipt(itemId: string) {
    const value = Math.trunc(Number(receiptDrafts[itemId]) || 0);
    await runAction(`receipt-${itemId}`, () => onConfirmReceipt(itemId, value), '入仓确认成功，记录已进入海川仓库库存。');
  }

  function toggleLot(lot: HaichuanWarehouseLot, checked: boolean) {
    setSelectedLots((current) => {
      const next = { ...current };
      if (checked) next[lot.id] = Math.max(0, lot.remainingCartonCount - lot.reservedCartonCount);
      else delete next[lot.id];
      return next;
    });
  }

  async function submitLoading() {
    const items = Object.entries(selectedLots).map(([warehouseLotId, requestedCartonCount]) => ({ warehouseLotId, requestedCartonCount }));
    if (!containerDate) {
      setMessage('请先填写装柜日期。');
      return;
    }
    if (items.length === 0) {
      setMessage('请至少选择一条仓库存货。');
      return;
    }
    await runAction('submit-loading', () => onSubmitBatch({
      id: `hc-load-${crypto.randomUUID()}`,
      containerDate,
      note: batchNote,
      items,
    }), '装柜批次提交成功，已进入我方审核。');
    setSelectedLots({});
    setBatchNote('');
  }

  async function reviewBatch(approve: boolean) {
    if (!activeBatch) return;
    if (!approve && !rejectionReason.trim()) {
      setMessage('退回时请填写退回原因。');
      return;
    }
    const items = activeBatch.items.map((item) => {
      const draft = reviewDrafts[item.id] ?? {
        cartons: item.requestedCartonCount,
        quantity: item.suggestedProductQuantity,
        cbm: item.suggestedCbm,
        note: item.note,
      };
      return {
        id: item.id,
        approvedCartonCount: Number(draft.cartons) || 0,
        approvedProductQuantity: Number(draft.quantity) || 0,
        approvedCbm: Number(draft.cbm) || 0,
        note: draft.note,
      };
    });
    await runAction(`review-${activeBatch.id}`, () => onReviewBatch({
      batchId: activeBatch.id,
      containerDate: reviewDate,
      note: reviewNote,
      approve,
      rejectionReason,
      items,
    }), approve ? '审核确认成功，装柜记录已进入海运在途。' : '批次已退回，冻结库存已释放。');
    setRejectionReason('');
  }

  function patchReview(item: HaichuanLoadingItem, field: 'cartons' | 'quantity' | 'cbm' | 'note', value: string) {
    if (field === 'cartons') {
      const lot = data.warehouseLots.find((candidate) => candidate.id === item.warehouseLotId);
      if (!lot) {
        setMessage('无法找到对应的海川仓库存货，请刷新后重试。');
        return;
      }
      const cartons = Math.min(
        lot.remainingCartonCount,
        Math.max(0, Math.trunc(Number(value) || 0)),
      );
      const suggestion = calculateHaichuanLoadingSuggestion(lot, cartons);
      setReviewDrafts((current) => {
        const existing = current[item.id] ?? {
          cartons: item.requestedCartonCount,
          quantity: item.suggestedProductQuantity,
          cbm: item.suggestedCbm,
          note: item.note,
        };
        return {
          ...current,
          [item.id]: {
            ...existing,
            cartons,
            quantity: suggestion.productQuantity,
            cbm: suggestion.cbm,
          },
        };
      });
      return;
    }
    setReviewDrafts((current) => {
      const existing = current[item.id] ?? {
        cartons: item.requestedCartonCount,
        quantity: item.suggestedProductQuantity,
        cbm: item.suggestedCbm,
        note: item.note,
      };
      return { ...current, [item.id]: { ...existing, [field]: field === 'note' ? value : Number(value) || 0 } };
    });
  }

  const tabs = isLogistics
    ? [['inbound', '待入仓'], ['warehouse', '仓库存货'], ['loaded', '已装柜']] as const
    : [['warehouse', '海川仓库库存'], ['review', '海川装柜审核'], ['loaded', '已装柜'], ['binding', '物流商绑定']] as const;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{isLogistics ? '海川物流工作台' : '海川仓库管理'}</h2>
          <p>采购数量保持不变；海川仅确认实际箱数，并按仓库批次分批装柜。</p>
        </div>
        <button type="button" onClick={() => void onRefresh()} disabled={Boolean(busyKey)}>刷新</button>
      </div>
      <div className="tabs">
        {tabs.map(([key, title]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{title}</button>)}
      </div>
      {message && <div className="inline-notice">{message}</div>}

      {(tab === 'inbound' || tab === 'warehouse') && (
        <div className="search-bar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 SKU、产品名称、英文名称、内部编号" /></div>
      )}

      {tab === 'inbound' && isLogistics && (
        <div className="table-wrap haichuan-table-wrap">
          <table className="haichuan-table">
            <thead><tr><th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>{labels.purchaseTotalQuantity}</th><th>申报总件数</th><th>{labels.unitsPerCarton}</th><th>{labels.tailQuantity}</th><th>{labels.unitCbm}</th><th>{labels.totalCbm}</th><th>实际收到总件数</th><th>{labels.status}</th><th>{labels.actions}</th></tr></thead>
            <tbody>
              {pendingInbound.map((item) => {
                const mainDetail = mainProductDetail(item.productDetails);
                return <Fragment key={item.id}>
                  <tr>
                    {productCells(mainDetail, item)}
                    <td>{valueText(item.purchaseTotalQuantity)}</td><td>{item.declaredTotalCartonCount}</td>
                    <td>{valueText(item.declaredUnitsPerCarton)}</td><td>{valueText(item.declaredTailQuantity)}</td>
                    <td>{valueText(item.unitCbm, 8)}</td><td>{valueText(item.declaredTotalCbm)}</td>
                    <td><input type="number" min="1" step="1" value={receiptDrafts[item.id] ?? item.declaredTotalCartonCount} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: Number(event.target.value) }))} /></td>
                    <td>待入仓</td>
                    <td><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id)}>{busyKey === `receipt-${item.id}` ? '正在确认...' : '确认入仓'}</button></td>
                  </tr>
                  {mixedProductDetails(item.productDetails).map((detail) => <tr className="mixed-child-row" key={`${item.id}:${detail.id}`}>
                    {productCells(detail, item)}<td>{valueText(detail.quantity)}</td><td /><td /><td /><td>{valueText(detail.unitCbm, 8)}</td><td>{valueText(detail.totalCbm)}</td><td /><td>{mixedNote(detail)}</td><td />
                  </tr>)}
                </Fragment>;
              })}
              {pendingInbound.length === 0 && <tr><td colSpan={13}>暂无待入仓记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'warehouse' && (
        <>
          {isLogistics && (
            <div className="record-form">
              <label>{labels.containerDate}<input type="date" value={containerDate} onChange={(event) => setContainerDate(event.target.value)} /></label>
              <label>{labels.note}<input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} /></label>
              <div className="form-actions"><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void submitLoading()}>{busyKey === 'submit-loading' ? '正在提交...' : '提交装柜审核'}</button></div>
            </div>
          )}
          <div className="table-wrap haichuan-table-wrap">
            <table className="haichuan-table">
              <thead><tr>{isLogistics && <th>选择</th>}<th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>{labels.purchaseTotalQuantity}</th><th>入仓总件数</th><th>剩余件数</th><th>冻结件数</th><th>{labels.unitsPerCarton}</th><th>{labels.tailQuantity}</th><th>剩余数量</th><th>剩余 CBM</th><th>{labels.status}</th>{isLogistics && <th>本次装柜件数</th>}</tr></thead>
              <tbody>
                {visibleLots.map((lot) => {
                  const available = Math.max(0, lot.remainingCartonCount - lot.reservedCartonCount);
                  const checked = selectedLots[lot.id] !== undefined;
                  const mainDetail = mainProductDetail(lot.productDetails);
                  return (
                    <Fragment key={lot.id}>
                      <tr>
                        {isLogistics && <td><input type="checkbox" checked={checked} disabled={available <= 0 || Boolean(busyKey)} onChange={(event) => toggleLot(lot, event.target.checked)} /></td>}
                        {productCells(mainDetail, lot)}
                        <td>{valueText(lot.initialProductQuantity)}</td><td>{lot.initialCartonCount}</td><td>{lot.remainingCartonCount}</td><td>{lot.reservedCartonCount}</td>
                        <td>{valueText(lot.declaredUnitsPerCarton)}</td><td>{valueText(lot.declaredTailQuantity)}</td>
                        <td>{valueText(lot.remainingProductQuantity)}</td><td>{valueText(lot.remainingCbm)}</td>
                        <td>{lot.hasPackingVariance ? '包装件数有差异' : warehouseStatusLabel(lot)}</td>
                        {isLogistics && <td><input type="number" min={lot.productDetails.length > 1 ? available : 1} max={available} step="1" disabled={!checked || Boolean(busyKey) || lot.productDetails.length > 1} value={checked ? selectedLots[lot.id] : available} title={lot.productDetails.length > 1 ? '混装库存需整批装走，避免拆散同一混装箱内商品' : ''} onChange={(event) => setSelectedLots((current) => ({ ...current, [lot.id]: Number(event.target.value) }))} /></td>}
                      </tr>
                      {mixedProductDetails(lot.productDetails).map((detail) => <tr className="mixed-child-row" key={`${lot.id}:${detail.id}`}>
                        {isLogistics && <td />}{productCells(detail, lot)}<td>{valueText(detail.quantity)}</td><td /><td /><td /><td /><td /><td>{valueText(detail.quantity)}</td><td>{valueText(detail.totalCbm)}</td><td>{mixedNote(detail)}</td>{isLogistics && <td />}
                      </tr>)}
                    </Fragment>
                  );
                })}
                {visibleLots.length === 0 && <tr><td colSpan={isLogistics ? 15 : 13}>暂无海川仓库存货</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'review' && !isLogistics && (
        <div className="split-layout">
          <div className="batch-list">
            {submittedBatches.map((batch) => <button key={batch.id} type="button" className={activeBatch?.id === batch.id ? 'active' : ''} onClick={() => setActiveBatchId(batch.id)}>{batch.containerDate} · {batch.items.length}项 · 审核中</button>)}
            {submittedBatches.length === 0 && <p>暂无待审核批次</p>}
          </div>
          {activeBatch && (
            <div className="batch-detail">
              <div className="record-form">
                <label>{labels.containerDate}<input type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} /></label>
                <label>审核备注<input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>
                <label>退回原因<input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} /></label>
              </div>
              <div className="table-wrap haichuan-table-wrap"><table className="haichuan-table">
                <thead><tr><th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>申报装柜件数</th><th>最终装柜件数</th><th>系统数量</th><th>最终装柜数量</th><th>系统 CBM</th><th>最终 CBM</th><th>{labels.note}</th></tr></thead>
                <tbody>{activeBatch.items.map((item) => {
                  const draft = reviewDrafts[item.id] ?? { cartons: item.requestedCartonCount, quantity: item.suggestedProductQuantity, cbm: item.suggestedCbm, note: item.note };
                  const lot = data.warehouseLots.find((candidate) => candidate.id === item.warehouseLotId);
                  const mainDetail = mainProductDetail(item.productDetails);
                  return <Fragment key={item.id}>
                    <tr>{productCells(mainDetail, { productName: item.productName, internalCode: item.internalCode, sku: item.sku })}<td>{item.requestedCartonCount}</td><td><input type="number" min="0" max={lot?.remainingCartonCount} step="1" value={draft.cartons} onChange={(event) => patchReview(item, 'cartons', event.target.value)} /></td><td>{valueText(item.suggestedProductQuantity)}{item.isEstimated ? '（系统估算）' : ''}</td><td><input type="number" min="0" value={draft.quantity} onChange={(event) => patchReview(item, 'quantity', event.target.value)} /></td><td>{valueText(item.suggestedCbm)}</td><td><input type="number" min="0" step="0.0001" value={draft.cbm} onChange={(event) => patchReview(item, 'cbm', event.target.value)} /></td><td><input value={draft.note} onChange={(event) => patchReview(item, 'note', event.target.value)} /></td></tr>
                    {mixedProductDetails(item.productDetails).map((detail) => <tr className="mixed-child-row" key={`${item.id}:${detail.id}`}>
                      {productCells(detail, { productName: item.productName, internalCode: item.internalCode, sku: item.sku })}<td /><td /><td>{valueText(detail.quantity)}</td><td /><td>{valueText(detail.totalCbm)}</td><td /><td>{mixedNote(detail)}</td>
                    </tr>)}
                  </Fragment>;
                })}</tbody>
              </table></div>
              <div className="form-actions"><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void reviewBatch(true)}>{busyKey ? '正在处理...' : '确认进入海运在途'}</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void reviewBatch(false)}>退回海川</button></div>
            </div>
          )}
        </div>
      )}

      {tab === 'loaded' && (
        <div className="table-wrap haichuan-table-wrap"><table className="haichuan-table">
          <thead><tr><th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>{labels.containerDate}</th><th>最终装柜件数</th><th>最终装柜数量</th><th>最终 CBM</th><th>{labels.status}</th><th>确认时间</th><th>{labels.note}</th></tr></thead>
          <tbody>{loadedProducts.map(({ batch, item }) => {
            const fallback = { productName: item.productName, internalCode: item.internalCode, sku: item.sku };
            return <Fragment key={`${batch.id}-${item.id}`}>
              <tr>{productCells(mainProductDetail(item.productDetails), fallback)}<td>{batch.containerDate}</td><td>{item.approvedCartonCount ?? item.requestedCartonCount}</td><td>{valueText(item.approvedProductQuantity ?? item.suggestedProductQuantity)}</td><td>{valueText(item.approvedCbm ?? item.suggestedCbm, 8)}</td><td>{loadingStatusLabel(batch.status)}</td><td>{batch.reviewedAt ? new Date(batch.reviewedAt).toLocaleString() : '-'}</td><td>{item.note || batch.note || '-'}</td></tr>
              {mixedProductDetails(item.productDetails).map((detail) => <tr className="mixed-child-row" key={`${batch.id}:${item.id}:${detail.id}`}>
                {productCells(detail, fallback)}<td>{batch.containerDate}</td><td /><td>{valueText(detail.quantity)}</td><td>{valueText(detail.totalCbm, 8)}</td><td>混装子行</td><td /><td>{mixedNote(detail)}</td>
              </tr>)}
            </Fragment>;
          })}{loadedProducts.length === 0 && <tr><td colSpan={11}>暂无已装柜产品</td></tr>}</tbody>
        </table></div>
      )}

      {tab === 'binding' && !isLogistics && (
        <div className="table-wrap"><table>
          <thead><tr><th>显示名称</th><th>登录邮箱</th><th>角色</th><th>物流商类型</th><th>{labels.actions}</th></tr></thead>
          <tbody>{profiles.filter((item) => item.role === 'logistics').map((item) => <LogisticsBindingRow key={item.id} profile={item} busy={Boolean(busyKey)} onSave={(next) => runAction(`profile-${item.id}`, () => onSaveProfile(next), '物流商账号绑定已保存。')} />)}{profiles.every((item) => item.role !== 'logistics') && <tr><td colSpan={5}>暂无物流商账号</td></tr>}</tbody>
        </table></div>
      )}

      {isLogistics && rejectedBatches.length > 0 && tab === 'warehouse' && (
        <div className="table-wrap">
          <h3>已退回装柜批次</h3>
          <table>
            <thead><tr><th>批次</th><th>{labels.containerDate}</th><th>退回原因</th><th>我方调整结果</th></tr></thead>
            <tbody>{rejectedBatches.map((batch) => <tr key={batch.id}><td>{batch.id}</td><td>{batch.containerDate}</td><td>{batch.rejectionReason || '-'}</td><td>{batch.items.map((item) => `${item.internalCode || item.sku}：${item.approvedCartonCount ?? item.requestedCartonCount}件 / ${valueText(item.approvedProductQuantity ?? item.suggestedProductQuantity)}个`).join('；')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LogisticsBindingRow({ profile, busy, onSave }: { profile: AppProfile; busy: boolean; onSave: (profile: AppProfile) => Promise<void> }) {
  const [providerType, setProviderType] = useState(profile.logisticsProviderType);
  useEffect(() => setProviderType(profile.logisticsProviderType), [profile.logisticsProviderType]);
  return <tr><td>{profile.displayName}</td><td>{profile.email}</td><td>物流商</td><td><select value={providerType} onChange={(event) => setProviderType(event.target.value as AppProfile['logisticsProviderType'])}><option value="">未绑定</option><option value="container">整柜物流商</option><option value="haichuan">海川物流商</option></select></td><td><button type="button" disabled={busy} onClick={() => void onSave({ ...profile, logisticsProviderType: providerType })}>保存</button></td></tr>;
}
