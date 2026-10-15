import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BarcodeScanControl } from '../components/BarcodeScanControl';
import type { AppProfile, HaichuanData, HaichuanLoadingBatch, HaichuanLoadingItem, HaichuanProductDetail, HaichuanReceiptEvent, HaichuanReceiptType, HaichuanWarehouseLot } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { exportHaichuanTable } from '../utils/exporters';
import { calculateHaichuanLoadingSuggestion, previewHaichuanWarehouseQuantity, selectableHaichuanWarehouseLots, toggleAllHaichuanWarehouseLots } from '../utils/haichuan';
import { fetchHaichuanReceiptEvents } from '../utils/haichuanStorage';
import { purchaseColumnLabels as labels } from '../utils/purchaseColumns';
import { filterByBarcodeSku } from '../utils/barcodeMatching';

type LoadingSelection = Record<string, number>;
type ReviewDraft = Record<string, { cartons: number; quantity: number; cbm: number; note: string }>;

type Props = {
  profile: AppProfile;
  profiles: AppProfile[];
  data: HaichuanData;
  onRefresh: () => Promise<void>;
  onConfirmReceipt: (input: { inboundId: string; receivedCartonCount: number; receiptType: HaichuanReceiptType; logisticsNote: string; requestId: string }) => Promise<void>;
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
  onUpdateWarehouseQuantity: (lotId: string, newTotal: number) => Promise<void>;
  onDeleteWarehouseLot: (lotId: string) => Promise<void>;
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

function productExportValues(detail: HaichuanProductDetail | undefined, fallback: { productName: string; englishName?: string; internalCode: string; sku: string }) {
  return {
    产品名称: detail?.productName || fallback.productName || '-',
    英文名称: detail?.englishName || fallback.englishName || '-',
    内部编号: detail?.internalCode || fallback.internalCode || '-',
    SKU: detail?.sku || fallback.sku || '-',
  };
}

export function HaichuanWorkflowPage({
  profile,
  profiles,
  data,
  onRefresh,
  onConfirmReceipt,
  onSubmitBatch,
  onReviewBatch,
  onUpdateWarehouseQuantity,
  onDeleteWarehouseLot,
  onSaveProfile,
}: Props) {
  const isLogistics = profile.role === 'logistics';
  const [tab, setTab] = useState(isLogistics ? 'scan' : 'warehouse');
  const [scanMode, setScanMode] = useState<'inbound' | 'warehouse'>('inbound');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, number>>({});
  const [receiptNotes, setReceiptNotes] = useState<Record<string, string>>({});
  const [historyItemId, setHistoryItemId] = useState('');
  const [receiptHistory, setReceiptHistory] = useState<HaichuanReceiptEvent[]>([]);
  const [selectedLots, setSelectedLots] = useState<LoadingSelection>({});
  const [containerDate, setContainerDate] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [activeBatchId, setActiveBatchId] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraft>({});
  const [quantityLot, setQuantityLot] = useState<HaichuanWarehouseLot | null>(null);
  const [quantityDraft, setQuantityDraft] = useState('');
  const [deleteLot, setDeleteLot] = useState<HaichuanWarehouseLot | null>(null);
  const [scanSku, setScanSku] = useState('');
  const scanResultsRef = useRef<HTMLDivElement>(null);

  const pendingInboundRecords = useMemo(() => data.inboundItems.filter((item) => item.status === 'pending_receipt'), [data.inboundItems]);
  const availableWarehouseLots = useMemo(() => data.warehouseLots.filter((lot) => lot.remainingCartonCount > 0), [data.warehouseLots]);
  const pendingInbound = useMemo(() => pendingInboundRecords.filter((item) => includesSearch([
    item.sku, item.productName, item.englishName, item.internalCode, item.purchaseNote,
    ...item.productDetails.flatMap((detail) => [detail.sku, detail.productName, detail.englishName, detail.internalCode]),
  ], search)), [pendingInboundRecords, search]);
  const visibleLots = useMemo(() => availableWarehouseLots.filter((lot) => includesSearch([
    lot.sku, lot.productName, lot.englishName, lot.internalCode,
    ...lot.productDetails.flatMap((detail) => [detail.sku, detail.productName, detail.englishName, detail.internalCode]),
  ], search)), [availableWarehouseLots, search]);
  const scannedInbound = useMemo(() => filterByBarcodeSku(pendingInboundRecords, scanSku), [pendingInboundRecords, scanSku]);
  const scannedLots = useMemo(() => filterByBarcodeSku(availableWarehouseLots, scanSku), [availableWarehouseLots, scanSku]);
  const submittedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'submitted'), [data.loadingBatches]);
  const approvedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'approved'), [data.loadingBatches]);
  const rejectedBatches = useMemo(() => data.loadingBatches.filter((batch) => batch.status === 'rejected'), [data.loadingBatches]);
  const loadedProducts = useMemo(() => approvedBatches.flatMap((batch) => batch.items.map((item) => ({ batch, item }))), [approvedBatches]);
  const activeBatch = submittedBatches.find((batch) => batch.id === activeBatchId) ?? submittedBatches[0] ?? null;
  const selectableVisibleLots = selectableHaichuanWarehouseLots(visibleLots);
  const allVisibleLotsSelected = selectableVisibleLots.length > 0 && selectableVisibleLots.every((lot) => selectedLots[lot.id] !== undefined);
  const selectableScannedLots = selectableHaichuanWarehouseLots(scannedLots);
  const allScannedLotsSelected = selectableScannedLots.length > 0 && selectableScannedLots.every((lot) => selectedLots[lot.id] !== undefined);

  useEffect(() => {
    setReceiptDrafts((current) => {
      const next = { ...current };
      for (const item of data.inboundItems) {
        if (next[item.id] === undefined) next[item.id] = Math.max(1, item.declaredTotalCartonCount - item.actualReceivedCartonCount);
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

  useEffect(() => {
    if (!scanSku) return;
    const matchCount = tab === 'scan' ? (scanMode === 'inbound' ? scannedInbound.length : scannedLots.length) : 0;
    if (matchCount > 0) requestAnimationFrame(() => scanResultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [scanSku, scanMode, tab, scannedInbound.length, scannedLots.length]);

  async function runAction(key: string, action: () => Promise<void>, successMessage: string): Promise<boolean> {
    if (busyKey) return false;
    setBusyKey(key);
    setMessage(key.startsWith('review') ? '正在处理审核...' : '正在提交...');
    try {
      await action();
      setMessage(successMessage);
      await onRefresh();
      return true;
    } catch (error) {
      setMessage(`操作失败：${formatErrorMessage(error)}`);
      return false;
    } finally {
      setBusyKey('');
    }
  }

  async function confirmReceipt(itemId: string, receiptType: HaichuanReceiptType) {
    const value = Math.trunc(Number(receiptDrafts[itemId]) || 0);
    if (value <= 0) {
      setMessage('本次入库件数必须大于 0。');
      return;
    }
    const saved = await runAction(`receipt-${itemId}`, () => onConfirmReceipt({
      inboundId: itemId,
      receivedCartonCount: value,
      receiptType,
      logisticsNote: receiptNotes[itemId] ?? '',
      requestId: crypto.randomUUID(),
    }), receiptType === 'partial' ? '部分入库成功，剩余货物继续待入仓。' : '完成入库成功，记录已进入海川仓库库存。');
    if (saved) {
      setReceiptNotes((current) => ({ ...current, [itemId]: '' }));
      setReceiptDrafts((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
    }
  }

  async function openReceiptHistory(itemId: string) {
    setBusyKey(`history-${itemId}`);
    try {
      setReceiptHistory(await fetchHaichuanReceiptEvents(itemId));
      setHistoryItemId(itemId);
    } catch (error) {
      setMessage(`入库历史加载失败：${formatErrorMessage(error)}`);
    } finally {
      setBusyKey('');
    }
  }

  function toggleLot(lot: HaichuanWarehouseLot, checked: boolean) {
    setSelectedLots((current) => {
      const next = { ...current };
      if (checked) next[lot.id] = Math.max(0, lot.remainingCartonCount - lot.reservedCartonCount);
      else delete next[lot.id];
      return next;
    });
  }

  function toggleAllVisibleLots() {
    setSelectedLots((current) => toggleAllHaichuanWarehouseLots(current, visibleLots));
  }

  function toggleAllScannedLots() {
    setSelectedLots((current) => toggleAllHaichuanWarehouseLots(current, scannedLots));
  }

  function openQuantityDialog(lot: HaichuanWarehouseLot) {
    setQuantityLot(lot);
    setQuantityDraft(valueText(lot.initialProductQuantity));
  }

  async function saveWarehouseQuantity() {
    if (!quantityLot) return;
    const nextTotal = Number(quantityDraft);
    const preview = previewHaichuanWarehouseQuantity(quantityLot, nextTotal);
    if (!preview.valid) {
      setMessage(`新采购总数量不能小于已装柜数量 ${valueText(preview.consumed)}。`);
      return;
    }
    const saved = await runAction(`quantity-${quantityLot.id}`, () => onUpdateWarehouseQuantity(quantityLot.id, nextTotal), '海川仓库采购总数量已更新。');
    if (saved) setQuantityLot(null);
  }

  async function confirmDeleteWarehouseLot() {
    if (!deleteLot) return;
    const deleted = await runAction(`delete-${deleteLot.id}`, () => onDeleteWarehouseLot(deleteLot.id), '海川仓库记录已删除，采购订单已退回待采购。');
    if (deleted) setDeleteLot(null);
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

  function runExport(action: () => void, successMessage: string) {
    try {
      action();
      setMessage(successMessage);
    } catch (error) {
      setMessage(`导出失败：${formatErrorMessage(error)}`);
    }
  }

  function exportWarehouse() {
    const rows = visibleLots.flatMap((lot) => {
      const mainRow = {
        ...productExportValues(mainProductDetail(lot.productDetails), lot),
        采购总数量: lot.initialProductQuantity,
        入仓总件数: lot.initialCartonCount,
        剩余件数: lot.remainingCartonCount,
        冻结件数: lot.reservedCartonCount,
        每箱数量: lot.declaredUnitsPerCarton,
        尾箱数量: lot.declaredTailQuantity,
        剩余数量: lot.remainingProductQuantity,
        '剩余 CBM': lot.remainingCbm,
        状态: lot.hasPackingVariance ? '包装件数有差异' : warehouseStatusLabel(lot),
      };
      const mixedRows = mixedProductDetails(lot.productDetails).map((detail) => ({
        ...productExportValues(detail, lot),
        采购总数量: detail.quantity,
        入仓总件数: '',
        剩余件数: '',
        冻结件数: '',
        每箱数量: '',
        尾箱数量: '',
        剩余数量: detail.quantity,
        '剩余 CBM': detail.totalCbm,
        状态: mixedNote(detail),
      }));
      return [mainRow, ...mixedRows];
    });
    runExport(() => exportHaichuanTable(rows, '海川仓库库存'), `已导出海川仓库库存 ${rows.length} 行。`);
  }

  function exportReviewBatch() {
    if (!activeBatch) return;
    const rows = activeBatch.items.flatMap((item) => {
      const draft = reviewDrafts[item.id] ?? { cartons: item.requestedCartonCount, quantity: item.suggestedProductQuantity, cbm: item.suggestedCbm, note: item.note };
      const fallback = { productName: item.productName, internalCode: item.internalCode, sku: item.sku };
      const mainRow = {
        ...productExportValues(mainProductDetail(item.productDetails), fallback),
        申报装柜件数: item.requestedCartonCount,
        最终装柜件数: draft.cartons,
        系统数量: item.suggestedProductQuantity,
        最终装柜数量: draft.quantity,
        '系统 CBM': item.suggestedCbm,
        '最终 CBM': draft.cbm,
        备注: draft.note,
      };
      const mixedRows = mixedProductDetails(item.productDetails).map((detail) => ({
        ...productExportValues(detail, fallback),
        申报装柜件数: '',
        最终装柜件数: '',
        系统数量: detail.quantity,
        最终装柜数量: '',
        '系统 CBM': detail.totalCbm,
        '最终 CBM': '',
        备注: mixedNote(detail),
      }));
      return [mainRow, ...mixedRows];
    });
    const moduleName = `海川装柜审核_${reviewDate || activeBatch.containerDate || '未填日期'}`;
    runExport(() => exportHaichuanTable(rows, moduleName), `已导出当前装柜审核批次 ${rows.length} 行。`);
  }

  function exportLoaded() {
    const rows = loadedProducts.flatMap(({ batch, item }) => {
      const fallback = { productName: item.productName, internalCode: item.internalCode, sku: item.sku };
      const mainRow = {
        ...productExportValues(mainProductDetail(item.productDetails), fallback),
        装柜日期: batch.containerDate,
        最终装柜件数: item.approvedCartonCount ?? item.requestedCartonCount,
        最终装柜数量: item.approvedProductQuantity ?? item.suggestedProductQuantity,
        '最终 CBM': item.approvedCbm ?? item.suggestedCbm,
        状态: loadingStatusLabel(batch.status),
        确认时间: batch.reviewedAt ? new Date(batch.reviewedAt).toLocaleString() : '-',
        备注: item.note || batch.note || '-',
      };
      const mixedRows = mixedProductDetails(item.productDetails).map((detail) => ({
        ...productExportValues(detail, fallback),
        装柜日期: batch.containerDate,
        最终装柜件数: '',
        最终装柜数量: detail.quantity,
        '最终 CBM': detail.totalCbm,
        状态: '混装子行',
        确认时间: '',
        备注: mixedNote(detail),
      }));
      return [mainRow, ...mixedRows];
    });
    runExport(() => exportHaichuanTable(rows, '海川已装柜'), `已导出已装柜产品 ${rows.length} 行。`);
  }

  const tabs = isLogistics
    ? [['scan', '扫码'], ['inbound', '待入仓'], ['warehouse', '仓库存货'], ['loaded', '已装柜']] as const
    : [['warehouse', '海川仓库库存'], ['review', '海川装柜审核'], ['loaded', '已装柜'], ['binding', '物流商绑定']] as const;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{isLogistics ? '海川物流工作台' : '海川仓库管理'}</h2>
          <p>采购数量保持不变；海川仅确认实际箱数，并按仓库批次分批装柜。</p>
        </div>
        <div className="section-heading-actions">
          {!isLogistics && tab === 'warehouse' && <button type="button" disabled={visibleLots.length === 0} onClick={exportWarehouse}>导出 Excel</button>}
          {!isLogistics && tab === 'review' && <button type="button" disabled={!activeBatch || activeBatch.items.length === 0} onClick={exportReviewBatch}>导出当前批次</button>}
          {!isLogistics && tab === 'loaded' && <button type="button" disabled={loadedProducts.length === 0} onClick={exportLoaded}>导出 Excel</button>}
          <button type="button" onClick={() => void onRefresh()} disabled={Boolean(busyKey)}>刷新</button>
        </div>
      </div>
      <div className="tabs">
        {tabs.map(([key, title]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{title}</button>)}
      </div>
      {message && <div className="inline-notice">{message}</div>}

      {(tab === 'inbound' || tab === 'warehouse') && (
        <div className="search-bar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 SKU、产品名称、英文名称、内部编号" /></div>
      )}

      {tab === 'scan' && isLogistics && (
        <div className="barcode-workbench">
          <div className="barcode-mode-switch" role="group" aria-label="扫码业务类型">
            <button type="button" className={scanMode === 'inbound' ? 'active' : ''} onClick={() => setScanMode('inbound')}>收货扫码</button>
            <button type="button" className={scanMode === 'warehouse' ? 'active' : ''} onClick={() => setScanMode('warehouse')}>装柜扫码</button>
          </div>
          <BarcodeScanControl
            value={scanSku}
            matchCount={scanMode === 'inbound' ? scannedInbound.length : scannedLots.length}
            targetLabel={scanMode === 'inbound' ? '待入仓' : '仓库存货'}
            onScan={setScanSku}
            onClear={() => setScanSku('')}
            embeddedCamera
          />
          <div ref={scanResultsRef} className="barcode-scan-results-anchor" />

          {scanSku && scanMode === 'inbound' && scannedInbound.length > 0 && <div className="barcode-workbench-results">
            {scannedInbound.map((item, index) => {
              const mainDetail = mainProductDetail(item.productDetails);
              const remainingCartons = Math.max(0, item.declaredTotalCartonCount - item.actualReceivedCartonCount);
              return <article className="mobile-record-card barcode-workbench-card barcode-match-card" key={item.id}>
                <div className="mobile-record-heading">
                  <div><strong>{mainDetail?.productName || item.productName || '-'}</strong><span>SKU：{mainDetail?.sku || item.sku || '-'}</span><span>内部编码：{mainDetail?.internalCode || item.internalCode || '-'}</span></div>
                  <div className="mobile-scan-badges"><span className="mobile-status-chip">{item.actualReceivedCartonCount > 0 ? '部分已入库' : '待入仓'}</span>{index === 0 && <span className="barcode-recommended-chip">建议处理</span>}</div>
                </div>
                <dl className="mobile-record-metrics">
                  <div><dt>采购总数量</dt><dd>{valueText(item.purchaseTotalQuantity)}</dd></div><div><dt>申报件数</dt><dd>{item.declaredTotalCartonCount}</dd></div><div><dt>已入库</dt><dd>{item.actualReceivedCartonCount}</dd></div><div><dt>剩余件数</dt><dd>{remainingCartons}</dd></div><div><dt>每件数量</dt><dd>{valueText(item.declaredUnitsPerCarton)}</dd></div><div><dt>总 CBM</dt><dd>{valueText(item.declaredTotalCbm)}</dd></div>
                </dl>
                {(item.purchaseNote || mixedProductDetails(item.productDetails).length > 0) && <div className="mobile-record-note">{item.purchaseNote && <span>采购备注：{item.purchaseNote}</span>}{mixedProductDetails(item.productDetails).map((detail) => <span key={detail.id}>{detail.productName || detail.sku}：{mixedNote(detail)}</span>)}</div>}
                <div className="mobile-record-form"><label>本次入库件数<input type="number" min="1" step="1" value={receiptDrafts[item.id] ?? Math.max(1, remainingCartons)} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: Number(event.target.value) }))} /></label><label>海川备注<input value={receiptNotes[item.id] ?? ''} onChange={(event) => setReceiptNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="本次入库备注" /></label></div>
                <div className="mobile-record-actions"><button type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'partial')}>部分入库</button><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'complete')}>{busyKey === `receipt-${item.id}` ? '正在确认...' : '完成入库'}</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void openReceiptHistory(item.id)}>入库历史</button></div>
              </article>;
            })}
          </div>}

          {scanSku && scanMode === 'warehouse' && scannedLots.length > 0 && <>
            <div className="barcode-workbench-results">
              {scannedLots.map((lot, index) => {
                const available = Math.max(0, lot.remainingCartonCount - lot.reservedCartonCount);
                const checked = selectedLots[lot.id] !== undefined;
                const mainDetail = mainProductDetail(lot.productDetails);
                return <article className={`mobile-record-card barcode-workbench-card barcode-match-card${checked ? ' selected' : ''}`} key={lot.id}>
                  <div className="mobile-record-heading"><div><strong>{mainDetail?.productName || lot.productName || '-'}</strong><span>SKU：{mainDetail?.sku || lot.sku || '-'}</span><span>内部编码：{mainDetail?.internalCode || lot.internalCode || '-'}</span></div><div className="mobile-scan-badges"><span className="mobile-status-chip">{lot.hasPackingVariance ? '包装件数有差异' : warehouseStatusLabel(lot)}</span>{index === 0 && <span className="barcode-recommended-chip">建议处理</span>}</div></div>
                  <dl className="mobile-record-metrics"><div><dt>采购总数量</dt><dd>{valueText(lot.initialProductQuantity)}</dd></div><div><dt>入仓件数</dt><dd>{lot.initialCartonCount}</dd></div><div><dt>剩余件数</dt><dd>{lot.remainingCartonCount}</dd></div><div><dt>冻结件数</dt><dd>{lot.reservedCartonCount}</dd></div><div><dt>剩余数量</dt><dd>{valueText(lot.remainingProductQuantity)}</dd></div><div><dt>剩余 CBM</dt><dd>{valueText(lot.remainingCbm)}</dd></div></dl>
                  {mixedProductDetails(lot.productDetails).length > 0 && <div className="mobile-record-note">{mixedProductDetails(lot.productDetails).map((detail) => <span key={detail.id}>{detail.productName || detail.sku}：{mixedNote(detail)}</span>)}</div>}
                  <div className="mobile-record-selection"><label className="mobile-checkbox-label"><input type="checkbox" checked={checked} disabled={available <= 0 || Boolean(busyKey)} onChange={(event) => toggleLot(lot, event.target.checked)} />选择本次装柜</label><label>本次装柜件数<input type="number" min={lot.productDetails.length > 1 ? available : 1} max={available} step="1" disabled={!checked || Boolean(busyKey) || lot.productDetails.length > 1} value={checked ? selectedLots[lot.id] : available} title={lot.productDetails.length > 1 ? '混装库存需整批装走，避免拆散同一混装箱内商品' : ''} onChange={(event) => setSelectedLots((current) => ({ ...current, [lot.id]: Number(event.target.value) }))} /></label></div>
                </article>;
              })}
            </div>
            <div className="record-form barcode-loading-submit">
              <label>{labels.containerDate}<input type="date" value={containerDate} onChange={(event) => setContainerDate(event.target.value)} /></label>
              <label>{labels.note}<input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} /></label>
              <div className="form-actions"><button type="button" disabled={selectableScannedLots.length === 0 || Boolean(busyKey)} onClick={toggleAllScannedLots}>{allScannedLotsSelected ? '取消当前 SKU 全部选择' : `选择当前 SKU 全部批次（${selectableScannedLots.length}）`}</button><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void submitLoading()}>{busyKey === 'submit-loading' ? '正在提交...' : '提交装柜审核'}</button></div>
            </div>
          </>}
        </div>
      )}

      {tab === 'inbound' && isLogistics && (
        <>
        <div className="table-wrap haichuan-table-wrap desktop-data-view">
          <table className="haichuan-table">
            <thead><tr><th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>{labels.purchaseTotalQuantity}</th><th>申报总件数</th><th>已入库件数</th><th>参考剩余件数</th><th>{labels.unitsPerCarton}</th><th>{labels.tailQuantity}</th><th>{labels.totalCbm}</th><th>采购备注</th><th>本次入库件数</th><th>海川备注</th><th>{labels.status}</th><th>{labels.actions}</th></tr></thead>
            <tbody>
              {pendingInbound.map((item) => {
                const mainDetail = mainProductDetail(item.productDetails);
                return <Fragment key={item.id}>
                  <tr>
                    {productCells(mainDetail, item)}
                    <td>{valueText(item.purchaseTotalQuantity)}</td><td>{item.declaredTotalCartonCount}</td><td>{item.actualReceivedCartonCount}</td><td>{Math.max(0, item.declaredTotalCartonCount - item.actualReceivedCartonCount)}</td>
                    <td>{valueText(item.declaredUnitsPerCarton)}</td><td>{valueText(item.declaredTailQuantity)}</td><td>{valueText(item.declaredTotalCbm)}</td>
                    <td><span className="cell-ellipsis" title={item.purchaseNote || '-'}>{item.purchaseNote || '-'}</span></td>
                    <td><input type="number" min="1" step="1" value={receiptDrafts[item.id] ?? Math.max(1, item.declaredTotalCartonCount - item.actualReceivedCartonCount)} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: Number(event.target.value) }))} /></td>
                    <td><input value={receiptNotes[item.id] ?? ''} onChange={(event) => setReceiptNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="本次入库备注" /></td>
                    <td>{item.actualReceivedCartonCount > 0 ? '部分已入库' : '待入仓'}</td>
                    <td className="row-actions"><button type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'partial')}>部分入库</button><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'complete')}>{busyKey === `receipt-${item.id}` ? '正在确认...' : '完成入库'}</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void openReceiptHistory(item.id)}>入库历史</button></td>
                  </tr>
                  {mixedProductDetails(item.productDetails).map((detail) => <tr className="mixed-child-row" key={`${item.id}:${detail.id}`}>
                    {productCells(detail, item)}<td>{valueText(detail.quantity)}</td><td /><td /><td /><td /><td /><td>{valueText(detail.totalCbm)}</td><td /><td /><td /><td>{mixedNote(detail)}</td><td />
                  </tr>)}
                </Fragment>;
              })}
              {pendingInbound.length === 0 && <tr><td colSpan={16}>暂无待入仓记录</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mobile-data-view mobile-card-list">
          {pendingInbound.map((item) => {
            const mainDetail = mainProductDetail(item.productDetails);
            const remainingCartons = Math.max(0, item.declaredTotalCartonCount - item.actualReceivedCartonCount);
            return <article className="mobile-record-card" key={item.id}>
              <div className="mobile-record-heading">
                <div>
                  <strong>{mainDetail?.productName || item.productName || '-'}</strong>
                  <span>{mainDetail?.sku || item.sku || '-'}</span>
                  <span>内部编码：{mainDetail?.internalCode || item.internalCode || '-'}</span>
                </div>
                <span className="mobile-status-chip">{item.actualReceivedCartonCount > 0 ? '部分已入库' : '待入仓'}</span>
              </div>
              <dl className="mobile-record-metrics">
                <div><dt>采购总数量</dt><dd>{valueText(item.purchaseTotalQuantity)}</dd></div>
                <div><dt>申报件数</dt><dd>{item.declaredTotalCartonCount}</dd></div>
                <div><dt>已入库</dt><dd>{item.actualReceivedCartonCount}</dd></div>
                <div><dt>剩余件数</dt><dd>{remainingCartons}</dd></div>
                <div><dt>每件数量</dt><dd>{valueText(item.declaredUnitsPerCarton)}</dd></div>
                <div><dt>总 CBM</dt><dd>{valueText(item.declaredTotalCbm)}</dd></div>
              </dl>
              {(item.purchaseNote || mixedProductDetails(item.productDetails).length > 0) && <div className="mobile-record-note">
                {item.purchaseNote && <span>采购备注：{item.purchaseNote}</span>}
                {mixedProductDetails(item.productDetails).map((detail) => <span key={detail.id}>{detail.productName || detail.sku}：{mixedNote(detail)}</span>)}
              </div>}
              <div className="mobile-record-form">
                <label>本次入库件数<input type="number" min="1" step="1" value={receiptDrafts[item.id] ?? Math.max(1, remainingCartons)} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [item.id]: Number(event.target.value) }))} /></label>
                <label>海川备注<input value={receiptNotes[item.id] ?? ''} onChange={(event) => setReceiptNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="本次入库备注" /></label>
              </div>
              <div className="mobile-record-actions">
                <button type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'partial')}>部分入库</button>
                <button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void confirmReceipt(item.id, 'complete')}>{busyKey === `receipt-${item.id}` ? '正在确认...' : '完成入库'}</button>
                <button type="button" disabled={Boolean(busyKey)} onClick={() => void openReceiptHistory(item.id)}>入库历史</button>
              </div>
            </article>;
          })}
          {pendingInbound.length === 0 && <div className="mobile-empty-state">暂无待入仓记录</div>}
        </div>
        </>
      )}

      {tab === 'warehouse' && (
        <>
          {isLogistics && (
            <div className="record-form">
              <label>{labels.containerDate}<input type="date" value={containerDate} onChange={(event) => setContainerDate(event.target.value)} /></label>
              <label>{labels.note}<input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} /></label>
              <div className="form-actions"><button type="button" disabled={selectableVisibleLots.length === 0 || Boolean(busyKey)} onClick={toggleAllVisibleLots}>{allVisibleLotsSelected ? '取消全部选择' : `全部选择（${selectableVisibleLots.length}）`}</button><button className="primary" type="button" disabled={Boolean(busyKey)} onClick={() => void submitLoading()}>{busyKey === 'submit-loading' ? '正在提交...' : '提交装柜审核'}</button></div>
            </div>
          )}
          <div className="table-wrap haichuan-table-wrap desktop-data-view">
            <table className="haichuan-table">
              <thead><tr>{isLogistics && <th>选择</th>}<th className="haichuan-pin haichuan-pin-product">{labels.productName}</th><th className="haichuan-pin haichuan-pin-english">英文名称</th><th className="haichuan-pin haichuan-pin-code">{labels.internalCode}</th><th className="haichuan-pin haichuan-pin-sku">{labels.sku}</th><th>{labels.purchaseTotalQuantity}</th><th>入仓总件数</th><th>剩余件数</th><th>冻结件数</th><th>{labels.unitsPerCarton}</th><th>{labels.tailQuantity}</th><th>剩余数量</th><th>剩余 CBM</th><th>{labels.status}</th>{isLogistics ? <th>本次装柜件数</th> : <th>{labels.actions}</th>}</tr></thead>
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
                        {isLogistics ? <td><input type="number" min={lot.productDetails.length > 1 ? available : 1} max={available} step="1" disabled={!checked || Boolean(busyKey) || lot.productDetails.length > 1} value={checked ? selectedLots[lot.id] : available} title={lot.productDetails.length > 1 ? '混装库存需整批装走，避免拆散同一混装箱内商品' : ''} onChange={(event) => setSelectedLots((current) => ({ ...current, [lot.id]: Number(event.target.value) }))} /></td> : <td className="row-actions"><button type="button" disabled={Boolean(busyKey)} onClick={() => openQuantityDialog(lot)}>修改数量</button><button className="danger" type="button" disabled={Boolean(busyKey)} onClick={() => setDeleteLot(lot)}>删除</button></td>}
                      </tr>
                      {mixedProductDetails(lot.productDetails).map((detail) => <tr className="mixed-child-row" key={`${lot.id}:${detail.id}`}>
                        {isLogistics && <td />}{productCells(detail, lot)}<td>{valueText(detail.quantity)}</td><td /><td /><td /><td /><td /><td>{valueText(detail.quantity)}</td><td>{valueText(detail.totalCbm)}</td><td>{mixedNote(detail)}</td><td />
                      </tr>)}
                    </Fragment>
                  );
                })}
                {visibleLots.length === 0 && <tr><td colSpan={15}>暂无海川仓库存货</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mobile-data-view mobile-card-list">
            {visibleLots.map((lot) => {
              const available = Math.max(0, lot.remainingCartonCount - lot.reservedCartonCount);
              const checked = selectedLots[lot.id] !== undefined;
              const mainDetail = mainProductDetail(lot.productDetails);
              return <article className={`mobile-record-card${checked ? ' selected' : ''}`} key={lot.id}>
                <div className="mobile-record-heading">
                  <div>
                    <strong>{mainDetail?.productName || lot.productName || '-'}</strong>
                    <span>{mainDetail?.sku || lot.sku || '-'}</span>
                    <span>内部编码：{mainDetail?.internalCode || lot.internalCode || '-'}</span>
                  </div>
                  <span className="mobile-status-chip">{lot.hasPackingVariance ? '包装件数有差异' : warehouseStatusLabel(lot)}</span>
                </div>
                <dl className="mobile-record-metrics">
                  <div><dt>采购总数量</dt><dd>{valueText(lot.initialProductQuantity)}</dd></div>
                  <div><dt>入仓件数</dt><dd>{lot.initialCartonCount}</dd></div>
                  <div><dt>剩余件数</dt><dd>{lot.remainingCartonCount}</dd></div>
                  <div><dt>冻结件数</dt><dd>{lot.reservedCartonCount}</dd></div>
                  <div><dt>剩余数量</dt><dd>{valueText(lot.remainingProductQuantity)}</dd></div>
                  <div><dt>剩余 CBM</dt><dd>{valueText(lot.remainingCbm)}</dd></div>
                </dl>
                {mixedProductDetails(lot.productDetails).length > 0 && <div className="mobile-record-note">
                  {mixedProductDetails(lot.productDetails).map((detail) => <span key={detail.id}>{detail.productName || detail.sku}：{mixedNote(detail)}</span>)}
                </div>}
                {isLogistics ? <div className="mobile-record-selection">
                  <label className="mobile-checkbox-label"><input type="checkbox" checked={checked} disabled={available <= 0 || Boolean(busyKey)} onChange={(event) => toggleLot(lot, event.target.checked)} />选择本次装柜</label>
                  <label>本次装柜件数<input type="number" min={lot.productDetails.length > 1 ? available : 1} max={available} step="1" disabled={!checked || Boolean(busyKey) || lot.productDetails.length > 1} value={checked ? selectedLots[lot.id] : available} title={lot.productDetails.length > 1 ? '混装库存需整批装走，避免拆散同一混装箱内商品' : ''} onChange={(event) => setSelectedLots((current) => ({ ...current, [lot.id]: Number(event.target.value) }))} /></label>
                </div> : <div className="mobile-record-actions">
                  <button type="button" disabled={Boolean(busyKey)} onClick={() => openQuantityDialog(lot)}>修改数量</button>
                  <button className="danger" type="button" disabled={Boolean(busyKey)} onClick={() => setDeleteLot(lot)}>删除</button>
                </div>}
              </article>;
            })}
            {visibleLots.length === 0 && <div className="mobile-empty-state">暂无海川仓库存货</div>}
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
        <>
        <div className="table-wrap haichuan-table-wrap desktop-data-view"><table className="haichuan-table">
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
        <div className="mobile-data-view mobile-card-list">
          {loadedProducts.map(({ batch, item }) => {
            const detail = mainProductDetail(item.productDetails);
            return <article className="mobile-record-card" key={`${batch.id}-${item.id}`}>
              <div className="mobile-record-heading">
                <div><strong>{detail?.productName || item.productName || '-'}</strong><span>{detail?.sku || item.sku || '-'}</span><span>内部编码：{detail?.internalCode || item.internalCode || '-'}</span></div>
                <span className="mobile-status-chip">{loadingStatusLabel(batch.status)}</span>
              </div>
              <dl className="mobile-record-metrics">
                <div><dt>{labels.containerDate}</dt><dd>{batch.containerDate || '-'}</dd></div>
                <div><dt>最终装柜件数</dt><dd>{item.approvedCartonCount ?? item.requestedCartonCount}</dd></div>
                <div><dt>最终装柜数量</dt><dd>{valueText(item.approvedProductQuantity ?? item.suggestedProductQuantity)}</dd></div>
                <div><dt>最终 CBM</dt><dd>{valueText(item.approvedCbm ?? item.suggestedCbm, 8)}</dd></div>
              </dl>
              <div className="mobile-record-note">
                <span>确认时间：{batch.reviewedAt ? new Date(batch.reviewedAt).toLocaleString() : '-'}</span>
                <span>备注：{item.note || batch.note || '-'}</span>
                {mixedProductDetails(item.productDetails).map((mixed) => <span key={mixed.id}>{mixed.productName || mixed.sku}：{mixedNote(mixed)}</span>)}
              </div>
            </article>;
          })}
          {loadedProducts.length === 0 && <div className="mobile-empty-state">暂无已装柜产品</div>}
        </div>
        </>
      )}

      {tab === 'binding' && !isLogistics && (
        <div className="table-wrap"><table>
          <thead><tr><th>显示名称</th><th>登录邮箱</th><th>角色</th><th>物流商类型</th><th>{labels.actions}</th></tr></thead>
          <tbody>{profiles.filter((item) => item.role === 'logistics').map((item) => <LogisticsBindingRow key={item.id} profile={item} busy={Boolean(busyKey)} onSave={async (next) => { await runAction(`profile-${item.id}`, () => onSaveProfile(next), '物流商账号绑定已保存。'); }} />)}{profiles.every((item) => item.role !== 'logistics') && <tr><td colSpan={5}>暂无物流商账号</td></tr>}</tbody>
        </table></div>
      )}

      {isLogistics && rejectedBatches.length > 0 && tab === 'warehouse' && (
        <>
        <div className="table-wrap desktop-data-view">
          <h3>已退回装柜批次</h3>
          <table>
            <thead><tr><th>批次</th><th>{labels.containerDate}</th><th>退回原因</th><th>我方调整结果</th></tr></thead>
            <tbody>{rejectedBatches.map((batch) => <tr key={batch.id}><td>{batch.id}</td><td>{batch.containerDate}</td><td>{batch.rejectionReason || '-'}</td><td>{batch.items.map((item) => `${item.internalCode || item.sku}：${item.approvedCartonCount ?? item.requestedCartonCount}件 / ${valueText(item.approvedProductQuantity ?? item.suggestedProductQuantity)}个`).join('；')}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="mobile-data-view mobile-card-list rejected-batch-cards">
          <h3>已退回装柜批次</h3>
          {rejectedBatches.map((batch) => <article className="mobile-record-card" key={batch.id}>
            <div className="mobile-record-heading"><div><strong>{batch.id}</strong><span>{batch.containerDate}</span></div><span className="mobile-status-chip">已退回</span></div>
            <div className="mobile-record-note"><span>退回原因：{batch.rejectionReason || '-'}</span><span>我方调整结果：{batch.items.map((item) => `${item.internalCode || item.sku}：${item.approvedCartonCount ?? item.requestedCartonCount}件 / ${valueText(item.approvedProductQuantity ?? item.suggestedProductQuantity)}个`).join('；')}</span></div>
          </article>)}
        </div>
        </>
      )}

      {quantityLot && (() => {
        const nextTotal = Number(quantityDraft);
        const preview = previewHaichuanWarehouseQuantity(quantityLot, nextTotal);
        return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyKey) setQuantityLot(null); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="haichuan-quantity-title">
            <h3 id="haichuan-quantity-title">修改采购总数量</h3>
            <p><strong>{quantityLot.productName || quantityLot.sku}</strong></p>
            <div className="confirm-summary">
              <span>原采购总数量<strong>{valueText(quantityLot.initialProductQuantity)}</strong></span>
              <span>已装柜数量<strong>{valueText(preview.consumed)}</strong></span>
              <span>修改后剩余数量<strong>{valueText(preview.remaining)}</strong></span>
              <span>修改后剩余 CBM<strong>{valueText(preview.remainingCbm, 8)}</strong></span>
            </div>
            <label>新采购总数量<input type="number" min={preview.consumed} step="1" value={quantityDraft} autoFocus onChange={(event) => setQuantityDraft(event.target.value)} /></label>
            {(quantityLot.reservedCartonCount > 0) && <div className="inline-error">该库存存在冻结件数，暂时不能修改。</div>}
            <div className="form-actions"><button type="button" disabled={Boolean(busyKey)} onClick={() => setQuantityLot(null)}>取消</button><button className="primary" type="button" disabled={Boolean(busyKey) || quantityLot.reservedCartonCount > 0 || !preview.valid} onClick={() => void saveWarehouseQuantity()}>{busyKey ? '正在保存...' : '确认修改'}</button></div>
          </div>
        </div>;
      })()}

      {deleteLot && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyKey) setDeleteLot(null); }}>
        <div className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="haichuan-delete-title">
          <h3 id="haichuan-delete-title">确认删除海川仓库记录？</h3>
          <p><strong>{deleteLot.productName || '-'}</strong></p>
          <p>SKU：{deleteLot.sku || '-'}</p>
          <div className="inline-error">删除后不可恢复；如果这是混装记录，主产品及全部混装子产品会整组删除，并将采购订单退回“我的采购订单”。</div>
          {(deleteLot.remainingProductQuantity !== deleteLot.initialProductQuantity || deleteLot.reservedCartonCount > 0) && <div className="inline-error">该记录已有装柜数量或冻结件数，当前不能删除。</div>}
          <div className="form-actions"><button type="button" disabled={Boolean(busyKey)} onClick={() => setDeleteLot(null)}>取消</button><button className="danger" type="button" disabled={Boolean(busyKey) || deleteLot.remainingProductQuantity !== deleteLot.initialProductQuantity || deleteLot.reservedCartonCount > 0} onClick={() => void confirmDeleteWarehouseLot()}>{busyKey ? '正在删除...' : '确认删除'}</button></div>
        </div>
      </div>}

      {historyItemId && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryItemId(''); }}>
        <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-history-title">
          <h3 id="receipt-history-title">入库历史</h3>
          <div className="table-wrap"><table><thead><tr><th>操作时间</th><th>类型</th><th>本次件数</th><th>累计件数</th><th>海川备注</th></tr></thead><tbody>
            {receiptHistory.map((event) => <tr key={event.id}><td>{event.createdAt ? new Date(event.createdAt).toLocaleString() : '-'}</td><td>{event.receiptType === 'complete' ? '完成入库' : '部分入库'}</td><td>{event.receivedCartonCount}</td><td>{event.cumulativeReceivedCartonCount}</td><td>{event.logisticsNote || '-'}</td></tr>)}
            {receiptHistory.length === 0 && <tr><td colSpan={5}>暂无入库历史</td></tr>}
          </tbody></table></div>
          <div className="form-actions"><button type="button" onClick={() => setHistoryItemId('')}>关闭</button></div>
        </div>
      </div>}
    </section>
  );
}

function LogisticsBindingRow({ profile, busy, onSave }: { profile: AppProfile; busy: boolean; onSave: (profile: AppProfile) => Promise<void> }) {
  const [providerType, setProviderType] = useState(profile.logisticsProviderType);
  useEffect(() => setProviderType(profile.logisticsProviderType), [profile.logisticsProviderType]);
  return <tr><td>{profile.displayName}</td><td>{profile.email}</td><td>物流商</td><td><select value={providerType} onChange={(event) => setProviderType(event.target.value as AppProfile['logisticsProviderType'])}><option value="">未绑定</option><option value="container">整柜物流商</option><option value="haichuan">海川物流商</option></select></td><td><button type="button" disabled={busy} onClick={() => void onSave({ ...profile, logisticsProviderType: providerType })}>保存</button></td></tr>;
}
