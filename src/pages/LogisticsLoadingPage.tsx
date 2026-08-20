import { useMemo, useState } from 'react';
import type { AppProfile, LogisticsBatch, LogisticsBatchItem, PurchaseRecord, SkuItem } from '../types';
import { exportSubmittedLogisticsBatches } from '../utils/exporters';
import { buildLogisticsBatch, logisticsStatusLabel, normalizeLogisticsItemInput } from '../utils/logistics';
import { formatErrorMessage } from '../utils/errors';

type Props = {
  profile: AppProfile;
  profiles: AppProfile[];
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  batches: LogisticsBatch[];
  onSaveBatch: (batch: LogisticsBatch) => Promise<void>;
  onSubmitBatch: (batch: LogisticsBatch) => Promise<void>;
  onApproveBatch: (batch: LogisticsBatch) => Promise<void>;
  onRejectBatch: (batch: LogisticsBatch) => Promise<void>;
  onClearLogistics: () => Promise<void>;
};

const SINGLE_ITEM_REJECT_MARK = 'admin驳回';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function batchStats(batch: LogisticsBatch): { items: number; cartons: number; loaded: number; left: number } {
  return batch.items.reduce((sum, item) => {
    const normalized = normalizeLogisticsItemInput(item);
    return {
      items: sum.items + 1,
      cartons: sum.cartons + (item.cartonCount ?? 0) + (item.tailQuantity > 0 ? 1 : 0),
      loaded: sum.loaded + (normalized.loadedCartonCount ?? 0) + (normalized.loadedTailQuantity > 0 ? 1 : 0),
      left: sum.left + (normalized.leftCartonCount ?? 0) + (normalized.leftTailQuantity > 0 ? 1 : 0),
    };
  }, { items: 0, cartons: 0, loaded: 0, left: 0 });
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function setItemAllLoaded(item: LogisticsBatchItem): LogisticsBatchItem {
  return normalizeLogisticsItemInput({
    ...item,
    loadedCartonCount: item.cartonCount ?? 0,
    loadedTailQuantity: item.tailQuantity,
    leftCartonCount: 0,
    leftTailQuantity: 0,
  });
}

function setItemAllLeft(item: LogisticsBatchItem): LogisticsBatchItem {
  return normalizeLogisticsItemInput({
    ...item,
    loadedCartonCount: 0,
    loadedTailQuantity: 0,
    leftCartonCount: item.cartonCount ?? 0,
    leftTailQuantity: item.tailQuantity,
  });
}

function isGuantongItem(item: LogisticsBatchItem): boolean {
  return (item.loadingType || '').trim() === '冠通';
}

function matchesLogisticsSearch(item: LogisticsBatchItem, searchText: string): boolean {
  const keyword = searchText.trim().toLowerCase();
  if (!keyword) return true;
  return [item.internalCode, item.manufacturerName, item.sku, item.productName, item.englishName]
    .some((value) => String(value || '').toLowerCase().includes(keyword));
}

function isSingleRejectedItem(item: LogisticsBatchItem): boolean {
  return item.note.includes(SINGLE_ITEM_REJECT_MARK);
}

function withSingleRejectNote(note: string): string {
  if (note.includes(SINGLE_ITEM_REJECT_MARK)) return note;
  return note.trim() ? `${SINGLE_ITEM_REJECT_MARK}：请重新核对本条装柜数据；${note.trim()}` : `${SINGLE_ITEM_REJECT_MARK}：请重新核对本条装柜数据`;
}

export function LogisticsLoadingPage({
  profile,
  profiles,
  records,
  skuItems,
  batches,
  onSaveBatch,
  onSubmitBatch,
  onApproveBatch,
  onRejectBatch,
  onClearLogistics,
}: Props) {
  const isAdmin = profile.role === 'admin' || profile.role === 'owner';
  const logisticsProfiles = useMemo(() => profiles.filter((item) => item.role === 'logistics'), [profiles]);
  const containerDates = useMemo(() => Array.from(new Set(records
    .filter((record) => record.poolStatus === 'submitted_to_pool' && record.status !== 'cancelled' && record.containerDate)
    .map((record) => record.containerDate)))
    .sort((left, right) => right.localeCompare(left)), [records]);
  const visibleBatches = useMemo(() => {
    if (isAdmin) return batches;
    const email = profile.email.trim().toLowerCase();
    return batches.filter((batch) => batch.logisticsUserId === profile.id || batch.logisticsEmail.trim().toLowerCase() === email);
  }, [batches, isAdmin, profile.email, profile.id]);

  const [containerDate, setContainerDate] = useState(containerDates[0] ?? todayIso());
  const [logisticsUserId, setLogisticsUserId] = useState(logisticsProfiles[0]?.id ?? '');
  const [activeBatchId, setActiveBatchId] = useState(visibleBatches[0]?.id ?? '');
  const [draftBatch, setDraftBatch] = useState<LogisticsBatch | null>(null);
  const [message, setMessage] = useState('');
  const [searchText, setSearchText] = useState('');

  const activeBatch = draftBatch
    ?? visibleBatches.find((batch) => batch.id === activeBatchId)
    ?? visibleBatches[0]
    ?? null;
  const canEditActive = Boolean(activeBatch && !isAdmin && (activeBatch.status === 'draft' || activeBatch.status === 'rejected'));
  const submittedBatches = useMemo(() => visibleBatches.filter((batch) => batch.status === 'submitted'), [visibleBatches]);
  const displayItems = useMemo(() => {
    if (!activeBatch) return [];
    return activeBatch.items
      .map(normalizeLogisticsItemInput)
      .filter((item) => (isAdmin || !isGuantongItem(item)) && matchesLogisticsSearch(item, searchText));
  }, [activeBatch, isAdmin, searchText]);

  function selectedLogisticsProfile(): AppProfile | null {
    return logisticsProfiles.find((item) => item.id === logisticsUserId) ?? null;
  }

  async function handleBuildBatch() {
    const logisticsProfile = selectedLogisticsProfile();
    if (!containerDate) {
      setMessage('请先选择装柜日期。');
      return;
    }
    if (!logisticsProfile) {
      setMessage('请先选择物流商账号。');
      return;
    }

    const existing = batches.find((batch) => batch.containerDate === containerDate && batch.logisticsUserId === logisticsProfile.id);
    const batch = buildLogisticsBatch(records, skuItems, profile, containerDate, logisticsProfile, existing);
    if (batch.items.length === 0) {
      setMessage('这个装柜日期下面没有可分配给物流商的装柜池记录。');
      return;
    }

    try {
      await onSaveBatch(batch);
      setDraftBatch(null);
      setActiveBatchId(batch.id);
      setMessage(`已生成/刷新 ${batch.items.length} 条物流装柜确认明细。`);
    } catch (error) {
      setMessage(`物流批次保存失败：${formatErrorMessage(error)}`);
    }
  }

  function patchItem(itemId: string, patch: Partial<LogisticsBatchItem>) {
    if (!activeBatch) return;
    const nextBatch = {
      ...activeBatch,
      items: activeBatch.items.map((item) => (item.id === itemId ? normalizeLogisticsItemInput({ ...item, ...patch }) : item)),
    };
    setDraftBatch(nextBatch);
  }

  async function handleSubmit() {
    if (!activeBatch) return;
    const normalized = {
      ...activeBatch,
      status: 'submitted' as const,
      submittedAt: new Date().toISOString(),
      items: activeBatch.items.map(normalizeLogisticsItemInput),
    };
    try {
      await onSubmitBatch(normalized);
      setDraftBatch(null);
      setMessage('已提交给 admin 审核，提交后不能继续编辑。');
    } catch (error) {
      setMessage(`提交失败：${formatErrorMessage(error)}`);
    }
  }

  async function handleApprove() {
    if (!activeBatch) return;
    try {
      await onApproveBatch(activeBatch);
      setDraftBatch(null);
      setMessage('已审核通过，并写回内部采购记录。');
    } catch (error) {
      setMessage(`审核写回失败：${formatErrorMessage(error)}`);
    }
  }

  async function handleReject() {
    if (!activeBatch) return;
    try {
      await onRejectBatch({
        ...activeBatch,
        status: 'rejected',
        reviewedBy: profile.id,
        reviewedAt: new Date().toISOString(),
      });
      setDraftBatch(null);
      setMessage('已驳回给物流商重新填写。');
    } catch (error) {
      setMessage(`驳回失败：${formatErrorMessage(error)}`);
    }
  }

  async function handleRejectItem(itemId: string) {
    if (!activeBatch) return;
    const now = new Date().toISOString();
    const nextBatch: LogisticsBatch = {
      ...activeBatch,
      status: 'rejected',
      reviewedBy: profile.id,
      reviewedAt: now,
      items: activeBatch.items.map((item) => (item.id === itemId
        ? normalizeLogisticsItemInput({ ...item, note: withSingleRejectNote(item.note), updatedAt: now })
        : item)),
    };
    try {
      await onSaveBatch(nextBatch);
      setDraftBatch(null);
      setActiveBatchId(nextBatch.id);
      setMessage('已单条驳回给物流商，物流商只需要重新填写这一条。');
    } catch (error) {
      setMessage(`单条驳回失败：${formatErrorMessage(error)}`);
    }
  }

  async function handleClearLogistics() {
    if (!isAdmin) return;
    if (!window.confirm('确定清空全部物流装柜确认批次和测试物流状态吗？这个操作不可恢复。')) return;
    try {
      await onClearLogistics();
      setDraftBatch(null);
      setActiveBatchId('');
      setMessage('已清空全部物流装柜确认批次，并重置采购记录物流状态。');
    } catch (error) {
      setMessage(`清空失败：${formatErrorMessage(error)}`);
    }
  }

  const stats = activeBatch ? batchStats({ ...activeBatch, items: displayItems }) : null;

  return (
    <section className="panel logistics-panel">
      <div className="section-heading">
        <div>
          <h2>物流装柜确认</h2>
          <p>物流商只查看装柜核对信息，不显示采购单价、运费、总金额、采购链接和采购人邮箱。</p>
        </div>
        {activeBatch && (
          <div className="export-actions">
            {isAdmin && <button type="button" disabled={submittedBatches.length === 0} onClick={() => exportSubmittedLogisticsBatches(submittedBatches)}>导出待审核表格</button>}
            {isAdmin && <button type="button" className="danger" disabled={batches.length === 0} onClick={() => void handleClearLogistics()}>清空物流确认</button>}
            <strong className={`logistics-status ${activeBatch.status}`}>{logisticsStatusLabel(activeBatch.status)}</strong>
            {isAdmin && activeBatch.status === 'submitted' && <button type="button" className="primary" onClick={handleApprove}>审核通过并写回</button>}
            {isAdmin && activeBatch.status === 'submitted' && <button type="button" onClick={handleReject}>驳回</button>}
            {!isAdmin && <button type="button" className="primary" disabled={!canEditActive} onClick={handleSubmit}>提交审核</button>}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="logistics-admin-bar">
          <label>装柜日期
            <select value={containerDate} onChange={(event) => setContainerDate(event.target.value)}>
              {containerDates.map((date) => <option key={date} value={date}>{date}</option>)}
              {!containerDates.includes(containerDate) && <option value={containerDate}>{containerDate}</option>}
            </select>
          </label>
          <label>物流商账号
            <select value={logisticsUserId} onChange={(event) => setLogisticsUserId(event.target.value)}>
              <option value="">请选择物流商</option>
              {logisticsProfiles.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.email}</option>)}
            </select>
          </label>
          <button type="button" className="primary" onClick={handleBuildBatch}>生成/刷新物流批次</button>
        </div>
      )}

      {visibleBatches.length > 0 && (
        <div className="logistics-batch-tabs">
          {visibleBatches.map((batch) => (
            <button
              key={batch.id}
              type="button"
              className={(activeBatch?.id === batch.id ? 'active ' : '') + batch.status}
              onClick={() => {
                setDraftBatch(null);
                setActiveBatchId(batch.id);
              }}
            >
              {batch.containerDate || '未填日期'} · {batch.logisticsEmail || '未分配'} · {logisticsStatusLabel(batch.status)}
            </button>
          ))}
        </div>
      )}

      {message && <div className="inline-notice">{message}</div>}

      {activeBatch && (
        <div className="logistics-search-bar">
          <label>搜索
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索内部编号、厂家名、英文名称"
            />
          </label>
          <span>
            当前显示 {displayItems.length} / {activeBatch.items.length} 条
          </span>
        </div>
      )}

      {activeBatch && stats && (
        <div className="summary-grid logistics-summary">
          <div className="metric"><span>明细数</span><strong>{stats.items}</strong></div>
          <div className="metric"><span>总箱件</span><strong>{stats.cartons}</strong></div>
          <div className="metric"><span>装走箱件</span><strong>{stats.loaded}</strong></div>
          <div className="metric"><span>留下箱件</span><strong>{stats.left}</strong></div>
        </div>
      )}

      {activeBatch ? (
        <div className="table-wrap logistics-table-wrap">
          <table className="logistics-table">
            <thead>
              <tr>
                <th>内部编号</th>{isAdmin && <th>图片</th>}<th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>装柜日期</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>装货方式</th><th>混装组</th><th>装走整箱</th><th>装走尾数</th><th>留下整箱</th><th>留下尾数</th><th>物流备注</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {displayItems.map((item) => {
                const normalized = normalizeLogisticsItemInput(item);
                const isSingleRejected = isSingleRejectedItem(normalized);
                const readOnly = isAdmin || !canEditActive || (activeBatch.status === 'rejected' && !isSingleRejected);
                return (
                  <tr key={item.id} className={[normalized.isMixed ? 'mixed-child-row' : '', isSingleRejected ? 'single-rejected-row' : ''].filter(Boolean).join(' ')}>
                    <td><strong>{normalized.internalCode || '-'}</strong></td>
                    {isAdmin && <td>{normalized.imageUrl ? <img className="sku-thumb" src={normalized.imageUrl} alt={normalized.productName || normalized.sku} loading="lazy" /> : '-'}</td>}
                    <td>{normalized.manufacturerName}</td>
                    <td>{normalized.sku}</td>
                    <td><span className="cell-ellipsis" title={normalized.productName}>{normalized.productName}</span></td>
                    <td><span className="cell-ellipsis" title={normalized.englishName}>{normalized.englishName}</span></td>
                    <td>{normalized.containerDate}</td>
                    <td>{normalized.cartonCount ?? ''}</td>
                    <td>{normalized.unitsPerCarton ?? ''}</td>
                    <td>{normalized.tailQuantity}</td>
                    <td>{(normalized.cartonCount ?? 0) * (normalized.unitsPerCarton ?? 0) + normalized.tailQuantity}</td>
                    <td>{normalized.loadingType || '整柜'}</td>
                    <td><span className="cell-ellipsis" title={normalized.mixedGroupsSummary}>{normalized.mixedGroupsSummary || '-'}</span></td>
                    <td><input type="number" min="0" value={normalized.loadedCartonCount ?? 0} disabled={readOnly || normalized.isMixed} onChange={(event) => patchItem(normalized.id, { loadedCartonCount: nonNegativeInteger(Number(event.target.value)) })} /></td>
                    <td><input type="number" min="0" value={normalized.loadedTailQuantity} disabled={readOnly || normalized.isMixed} onChange={(event) => patchItem(normalized.id, { loadedTailQuantity: nonNegativeInteger(Number(event.target.value)) })} /></td>
                    <td><input type="number" min="0" value={normalized.leftCartonCount ?? 0} disabled={readOnly || normalized.isMixed} onChange={(event) => patchItem(normalized.id, { leftCartonCount: nonNegativeInteger(Number(event.target.value)) })} /></td>
                    <td><input type="number" min="0" value={normalized.leftTailQuantity} disabled={readOnly || normalized.isMixed} onChange={(event) => patchItem(normalized.id, { leftTailQuantity: nonNegativeInteger(Number(event.target.value)) })} /></td>
                    <td><input value={normalized.note} disabled={readOnly} onChange={(event) => patchItem(normalized.id, { note: isSingleRejected ? withSingleRejectNote(event.target.value) : event.target.value })} /></td>
                    <td className="row-actions">
                      {isAdmin && activeBatch.status === 'submitted' ? (
                        <button type="button" className="danger" onClick={() => handleRejectItem(normalized.id)}>驳回此条</button>
                      ) : (
                        <>
                          <button type="button" disabled={readOnly} onClick={() => patchItem(normalized.id, setItemAllLoaded(normalized))}>全装</button>
                          <button type="button" disabled={readOnly} onClick={() => patchItem(normalized.id, setItemAllLeft(normalized))}>全留</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {displayItems.length === 0 && <tr><td className="empty" colSpan={isAdmin ? 19 : 18}>{activeBatch.items.length === 0 ? '这个批次还没有物流明细。' : '没有匹配的物流明细。'}</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">暂无可查看的物流装柜批次。</div>
      )}
    </section>
  );
}
