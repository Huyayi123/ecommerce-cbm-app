import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { AppProfile, MixedCartonGroup, MixedCartonLine, PurchasePool, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { exportPurchaseRecords } from '../utils/exporters';
import { parsePurchaseRecordsFile } from '../utils/fileParsers';
import { round } from '../utils/number';
import { openPurchaseUrl, purchaseUrlForRecord, skuLookupKey } from '../utils/purchaseLinks';
import { mergeImportedPurchaseOrders } from '../utils/purchaseOrderImports';
import { calculatedPurchaseTotalAmount, effectivePurchaseQuantity, mixedQuantityForOtherSkus, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  profile: AppProfile;
  onChange: (records: PurchaseRecord[]) => void | Promise<void>;
  onSaveRecords?: (records: PurchaseRecord[]) => void | Promise<void>;
  onDeleteRecords?: (ids: string[]) => void | Promise<void>;
  onSubmitToPool?: (pool: PurchasePool, records: PurchaseRecord[]) => void | Promise<void>;
};

type NewOrderDraft = {
  manufacturerName: string;
  sku: string;
  productName: string;
  englishName: string;
  imageUrl: string;
  shopName: string;
  cartonCount: string;
  unitsPerCarton: string;
  tailQuantity: string;
  purchasePrice: string;
  freightCost: string;
  totalAmount: string;
  unitCbm: string;
  purchaseBatchId: string;
  purchaseBatchName: string;
  purchaseBatchDate: string;
  status: PurchaseStatus;
  loadingType: PurchaseRecord['loadingType'];
  note: string;
};

const statusLabels: Record<PurchaseStatus, string> = {
  pending: '待采购',
  in_transit: '海运在途',
  arrived: '已到货',
  cancelled: '已取消',
};

type OrderFilterStatus = PurchaseStatus | 'submitted_to_pool' | 'all';

const statusFilterOptions: Array<{ value: OrderFilterStatus; label: string }> = [
  { value: 'pending', label: '待采购' },
  { value: 'submitted_to_pool', label: '采购池中' },
  { value: 'in_transit', label: '海运在途' },
  { value: 'arrived', label: '已到货' },
  { value: 'all', label: '全部' },
];

const statusEditOptions: Array<{ value: PurchaseStatus; label: string }> = statusFilterOptions
  .filter((option): option is { value: PurchaseStatus; label: string } => option.value !== 'all' && option.value !== 'submitted_to_pool');

const editableFields = [
  'manufacturerName',
  'sku',
  'productName',
  'englishName',
  'imageUrl',
  'shopName',
  'assignedBuyerName',
  'assignedBuyerEmail',
  'purchaseQuantity',
  'confirmedPurchaseQuantity',
  'cartonCount',
  'unitsPerCarton',
  'tailQuantity',
  'purchasePrice',
  'freightCost',
  'totalAmount',
  'unitCbm',
  'status',
  'loadingType',
  'note',
] as const;

type EditableField = (typeof editableFields)[number];
type MixedLineField = 'sku' | 'productName' | 'quantity' | 'purchasePrice' | 'unitCbm';
type ScrollSnapshot = {
  windowX: number;
  windowY: number;
  tableLeft: number;
  tableTop: number;
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function compareNullableText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function compareMyPurchaseOrders(left: PurchaseRecord, right: PurchaseRecord): number {
  const quantityDiff = right.purchaseQuantity - left.purchaseQuantity;
  if (quantityDiff !== 0) return quantityDiff;

  const leftSku = left.sku || '';
  const rightSku = right.sku || '';
  if (leftSku !== rightSku) return compareNullableText(leftSku, rightSku);

  return compareNullableText(left.id, right.id);
}

function createEmptyDraft(): NewOrderDraft {
  return {
    manufacturerName: '',
    sku: 'NEW',
    productName: '',
    englishName: '',
    imageUrl: '',
    shopName: '',
    cartonCount: '',
    unitsPerCarton: '',
    tailQuantity: '0',
    purchasePrice: '',
    freightCost: '',
    totalAmount: '',
    unitCbm: '',
    purchaseBatchId: '',
    purchaseBatchName: '',
    purchaseBatchDate: '',
    status: 'pending',
    loadingType: '整柜',
    note: '',
  };
}

function poolFromRecord(record: PurchaseRecord, profile: AppProfile): PurchasePool {
  const id = record.purchasePoolId || record.purchaseBatchId || 'current-open-purchase-pool';
  return {
    id,
    name: record.purchasePoolName || record.purchaseBatchName || '当前采购订单池',
    containerDate: record.purchasePoolDate || record.purchaseBatchDate || record.containerDate || '',
    status: 'open',
    createdBy: profile.id,
    createdAt: new Date().toISOString(),
    sentBy: '',
    sentAt: '',
    note: '',
    records: [],
  };
}

function isNewSkuValue(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return !normalized || normalized === 'NEW';
}

function recalcMixedLine(line: MixedCartonLine): MixedCartonLine {
  return {
    ...line,
    totalAmount: round(line.quantity * line.purchasePrice, 2),
    totalCbm: round(line.quantity * line.unitCbm, 4),
  };
}

function createMixedLine(): MixedCartonLine {
  return {
    id: crypto.randomUUID(),
    sku: '',
    productName: '',
    quantity: 0,
    purchasePrice: 0,
    unitCbm: 0,
    totalAmount: 0,
    totalCbm: 0,
  };
}

function createMixedGroup(index: number): MixedCartonGroup {
  return {
    id: crypto.randomUUID(),
    groupName: `混装${index + 1}`,
    cartonCount: 1,
    lines: [createMixedLine()],
  };
}

export function MyPurchaseOrdersPage({ records, skuItems, profile, onChange, onSaveRecords, onDeleteRecords, onSubmitToPool }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mixedDrafts, setMixedDrafts] = useState<Record<string, string>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [newOrder, setNewOrder] = useState<NewOrderDraft>(() => createEmptyDraft());
  const [message, setMessage] = useState('');
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<ScrollSnapshot | null>(null);
  const mixedAutoSaveTimer = useRef<number | null>(null);
  const internalCodeRepairSignatureRef = useRef('');
  const [statusFilter, setStatusFilter] = useState<OrderFilterStatus>('pending');
  const [orderSearch, setOrderSearch] = useState('');
  const isAdmin = profile.role === 'admin' || profile.role === 'owner';
  const isViewer = profile.role === 'viewer';
  const assignedRecords = useMemo(
    () => {
      const assigned = records.filter((record) => (
        record.status !== 'cancelled'
        && record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()
      ));
      return [...assigned].sort(compareMyPurchaseOrders);
    },
    [profile.email, records],
  );
  const imageUrlBySku = useMemo(
    () => new Map(skuItems
      .filter((item) => item.sku.trim() && !isNewSkuValue(item.sku))
      .map((item) => [skuLookupKey(item.sku), item.imageUrl])),
    [skuItems],
  );
  const skuBySku = useMemo(
    () => new Map(skuItems
      .filter((item) => item.sku.trim() && !isNewSkuValue(item.sku))
      .map((item) => [skuLookupKey(item.sku), item])),
    [skuItems],
  );
  const skuItemsBySku = useMemo(() => {
    const result = new Map<string, SkuItem[]>();
    for (const item of skuItems) {
      if (!item.sku.trim() || isNewSkuValue(item.sku)) continue;
      const key = skuLookupKey(item.sku);
      result.set(key, [...(result.get(key) ?? []), item]);
    }
    return result;
  }, [skuItems]);
  const visibleRecords = useMemo(
    () => {
      let statusRecords = assignedRecords;
      if (statusFilter === 'submitted_to_pool') {
        statusRecords = assignedRecords.filter((record) => record.poolStatus === 'submitted_to_pool');
      } else if (statusFilter === 'pending') {
        statusRecords = assignedRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase');
      } else if (statusFilter !== 'all') {
        statusRecords = assignedRecords.filter((record) => record.status === statusFilter);
      }

      const search = orderSearch.trim().toLowerCase();
      if (!search) return statusRecords;
      return statusRecords.filter((record) => {
        const skuItem = skuBySku.get(skuLookupKey(record.sku));
        const searchable = [
          record.sku,
          record.manufacturerName,
          skuItem?.sku ?? '',
          skuItem?.manufacturerName ?? '',
        ].join(' ').toLowerCase();
        return searchable.includes(search);
      });
    },
    [assignedRecords, orderSearch, skuBySku, statusFilter],
  );
  const submittableAssignedRecords = useMemo(
    () => assignedRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase'),
    [assignedRecords],
  );
  const unconfirmedVisibleCount = visibleRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase').length;

  useEffect(() => {
    if (isViewer || !onSaveRecords) return;
    const repairs = assignedRecords.flatMap((record) => {
      if (record.internalCode.trim() || isNewSkuValue(record.sku)) return [];
      const candidates = skuItemsBySku.get(skuLookupKey(record.sku)) ?? [];
      const shopName = record.shopName.trim().toLowerCase();
      const matched = (shopName
        ? candidates.find((item) => item.shopName.trim().toLowerCase() === shopName)
        : undefined) ?? candidates[0];
      const internalCode = matched?.internalCode.trim() ?? '';
      return internalCode ? [{ ...record, internalCode }] : [];
    });
    if (repairs.length === 0) return;

    const signature = repairs.map((record) => `${record.id}:${record.internalCode}`).sort().join('|');
    if (signature === internalCodeRepairSignatureRef.current) return;
    internalCodeRepairSignatureRef.current = signature;

    void (async () => {
      try {
        await onSaveRecords(repairs);
        setMessage(`已自动补全 ${repairs.length} 条历史采购订单内部编号。`);
      } catch (error) {
        internalCodeRepairSignatureRef.current = '';
        console.error(error);
        setMessage(`内部编号自动补全失败：${formatErrorMessage(error)}`);
      }
    })();
  }, [assignedRecords, isViewer, onSaveRecords, skuItemsBySku]);

  const newCartonCount = parseNumber(newOrder.cartonCount);
  const newUnitsPerCarton = parseNumber(newOrder.unitsPerCarton);
  const newTailQuantity = parseNumber(newOrder.tailQuantity);
  const newQuantity = newCartonCount * newUnitsPerCarton + newTailQuantity;
  const newPrice = parseNumber(newOrder.purchasePrice);
  const newFreightCost = parseNumber(newOrder.freightCost);
  const newUnitCbm = parseNumber(newOrder.unitCbm);
  const calculatedNewTotalAmount = round(newQuantity * newPrice + newFreightCost, 2);
  const newTotalAmount = newOrder.totalAmount.trim() ? parseNumber(newOrder.totalAmount) : calculatedNewTotalAmount;
  const newTotalCbm = round(newQuantity * newUnitCbm, 4);
  const visibleTotalCbm = round(
    visibleRecords.reduce((sum, record) => sum + withPurchaseTotals(recordWithSkuDefaults(record)).totalCbm, 0),
    4,
  );

  function imageUrlFor(record: PurchaseRecord): string {
    return record.imageUrl || imageUrlBySku.get(skuLookupKey(record.sku)) || '';
  }

  function recordWithSkuDefaults(record: PurchaseRecord): PurchaseRecord {
    const candidates = skuItemsBySku.get(skuLookupKey(record.sku)) ?? [];
    const shopName = record.shopName.trim().toLowerCase();
    const skuItem = (shopName
      ? candidates.find((item) => item.shopName.trim().toLowerCase() === shopName)
      : undefined) ?? candidates[0];
    const withPoolStatus = {
      ...record,
      poolStatus: record.poolStatus || 'pending_purchase',
    };
    if (!skuItem) return withPoolStatus;
    return {
      ...withPoolStatus,
      internalCode: record.internalCode || skuItem.internalCode,
      purchasePrice: record.purchasePrice || skuItem.purchasePrice,
      unitCbm: record.unitCbm || skuItem.unitCbm,
      imageUrl: record.imageUrl || skuItem.imageUrl,
      productName: record.productName || skuItem.productName,
      englishName: record.englishName || skuItem.englishName,
      manufacturerName: record.manufacturerName || skuItem.manufacturerName,
      shopName: record.shopName || skuItem.shopName,
    };
  }

  function defaultUnitsPerCartonText(sku: string): string {
    const skuItem = skuBySku.get(skuLookupKey(sku));
    if (!skuItem || skuItem.unitsPerCarton <= 0) return '';
    return String(skuItem.unitsPerCarton);
  }

  function defaultUnitsPerCartonTitle(sku: string): string {
    const defaultQuantity = defaultUnitsPerCartonText(sku);
    return defaultQuantity ? `默认装箱数：${defaultQuantity}` : '未配置默认装箱数';
  }

  function draftKey(recordId: string, field: EditableField): string {
    return `${recordId}:${field}`;
  }

  function mixedKey(recordId: string, groupId: string, lineId: string, field: MixedLineField): string {
    return `${recordId}:${groupId}:${lineId}:${field}`;
  }

  function groupKey(recordId: string, groupId: string, field: 'groupName' | 'cartonCount'): string {
    return `${recordId}:${groupId}:${field}`;
  }

  function valueFor(record: PurchaseRecord, field: EditableField): string {
    const key = draftKey(record.id, field);
    if (key in drafts) return drafts[key];
    return String(record[field] ?? '');
  }

  function rememberScrollPosition() {
    pendingScrollRef.current = {
      windowX: window.scrollX,
      windowY: window.scrollY,
      tableLeft: tableWrapRef.current?.scrollLeft ?? 0,
      tableTop: tableWrapRef.current?.scrollTop ?? 0,
    };
  }

  function restoreRememberedScroll() {
    const snapshot = pendingScrollRef.current;
    if (!snapshot) return;
    window.requestAnimationFrame(() => {
      if (tableWrapRef.current) {
        tableWrapRef.current.scrollLeft = snapshot.tableLeft;
        tableWrapRef.current.scrollTop = snapshot.tableTop;
      }
      window.scrollTo(snapshot.windowX, snapshot.windowY);
      window.requestAnimationFrame(() => {
        if (tableWrapRef.current) {
          tableWrapRef.current.scrollLeft = snapshot.tableLeft;
          tableWrapRef.current.scrollTop = snapshot.tableTop;
        }
        window.scrollTo(snapshot.windowX, snapshot.windowY);
        pendingScrollRef.current = null;
      });
    });
  }

  function patchDraftValue(recordId: string, field: EditableField, value: string) {
    rememberScrollPosition();
    setDrafts((current) => ({ ...current, [draftKey(recordId, field)]: value }));
    restoreRememberedScroll();
  }

  function mixedValueFor(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField): string {
    const key = mixedKey(record.id, group.id, line.id, field);
    if (key in mixedDrafts) return mixedDrafts[key];
    return String(line[field] ?? '');
  }

  function groupValueFor(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount'): string {
    const key = groupKey(record.id, group.id, field);
    if (key in mixedDrafts) return mixedDrafts[key];
    return String(group[field] ?? '');
  }

  function patchNewOrder<K extends keyof NewOrderDraft>(field: K, value: NewOrderDraft[K]) {
    setNewOrder((current) => {
      const next = { ...current, [field]: value };
      if (field !== 'sku' || typeof value !== 'string') return next;
      if (!value.trim() || isNewSkuValue(value)) return next;

      const skuItem = skuBySku.get(skuLookupKey(value));
      if (!skuItem) return next;

      return {
        ...next,
        sku: skuItem.sku || value,
        manufacturerName: skuItem.manufacturerName,
        productName: skuItem.productName,
        englishName: skuItem.englishName,
        imageUrl: skuItem.imageUrl,
        shopName: skuItem.shopName,
        purchasePrice: skuItem.purchasePrice > 0 ? String(skuItem.purchasePrice) : next.purchasePrice,
        unitCbm: skuItem.unitCbm > 0 ? String(skuItem.unitCbm) : next.unitCbm,
      };
    });
  }

  async function saveRecord(nextRecord: PurchaseRecord) {
    const normalized = withPurchaseTotals(nextRecord);
    if (onSaveRecords) {
      await onSaveRecords([normalized]);
      return;
    }
    await onChange(records.map((item) => (item.id === normalized.id ? normalized : item)));
  }

  function applyMixedDraftsToRecord(record: PurchaseRecord, draftSnapshot: Record<string, string>): PurchaseRecord {
    let hasChanges = false;
    const mixedGroups = record.mixedGroups.map((group) => {
      const nextGroup = { ...group };
      const groupNameKey = groupKey(record.id, group.id, 'groupName');
      const cartonCountKey = groupKey(record.id, group.id, 'cartonCount');
      if (groupNameKey in draftSnapshot) {
        nextGroup.groupName = draftSnapshot[groupNameKey];
        hasChanges = true;
      }
      if (cartonCountKey in draftSnapshot) {
        nextGroup.cartonCount = parseNumber(draftSnapshot[cartonCountKey]);
        hasChanges = true;
      }

      nextGroup.lines = group.lines.map((line) => {
        let nextLine = { ...line };
        let lineChanged = false;
        for (const field of ['sku', 'productName', 'quantity', 'purchasePrice', 'unitCbm'] as MixedLineField[]) {
          const key = mixedKey(record.id, group.id, line.id, field);
          if (!(key in draftSnapshot)) continue;
          const value = draftSnapshot[key];
          if (field === 'quantity' || field === 'purchasePrice' || field === 'unitCbm') nextLine[field] = parseNumber(value);
          else nextLine[field] = value;
          lineChanged = true;
          hasChanges = true;
        }
        if (lineChanged) {
          const skuItem = skuBySku.get(skuLookupKey(nextLine.sku));
          if (skuItem && !nextLine.productName.trim()) nextLine.productName = skuItem.productName;
          if (skuItem && nextLine.purchasePrice === 0) nextLine.purchasePrice = skuItem.purchasePrice;
          if (skuItem && nextLine.unitCbm === 0) nextLine.unitCbm = skuItem.unitCbm;
          nextLine = recalcMixedLine(nextLine);
        }
        return nextLine;
      });
      return nextGroup;
    });

    return hasChanges ? withPurchaseTotals({ ...record, mixedGroups, isMixed: mixedGroups.length > 0 }) : record;
  }

  async function flushMixedDrafts(draftSnapshot: Record<string, string>) {
    if (isViewer || Object.keys(draftSnapshot).length === 0) return;
    try {
      const changedRecords = records
        .map((record) => applyMixedDraftsToRecord(record, draftSnapshot))
        .filter((record, index) => record !== records[index]);
      if (onSaveRecords) await onSaveRecords(changedRecords);
      else await onChange(records.map((record) => applyMixedDraftsToRecord(record, draftSnapshot)));
      setMixedDrafts((current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(draftSnapshot)) {
          if (next[key] === value) delete next[key];
        }
        return next;
      });
      setMessage('混装已自动保存');
    } catch (error) {
      console.error(error);
      setMessage(`混装自动保存失败：${formatErrorMessage(error)}`);
    }
  }

  useEffect(() => {
    if (mixedAutoSaveTimer.current !== null) window.clearTimeout(mixedAutoSaveTimer.current);
    const draftSnapshot = { ...mixedDrafts };
    if (Object.keys(draftSnapshot).length === 0) return;
    mixedAutoSaveTimer.current = window.setTimeout(() => {
      void flushMixedDrafts(draftSnapshot);
    }, 700);
    return () => {
      if (mixedAutoSaveTimer.current !== null) window.clearTimeout(mixedAutoSaveTimer.current);
    };
  }, [mixedDrafts]);

  async function addNewOrder() {
    if (isViewer) return;
    if (!profile.buyerName.trim()) {
      setMessage('请先在“账号采购人绑定”里填写采购人，再新增个人采购订单。');
      return;
    }

    const sku = newOrder.sku.trim() || 'NEW';
    if (isNewSkuValue(sku) && !newOrder.productName.trim() && !newOrder.englishName.trim()) {
      setMessage('新品 NEW 至少需要填写产品名称或英文名称。');
      return;
    }

    const record: PurchaseRecord = withPurchaseTotals({
      id: crypto.randomUUID(),
      internalCode: '',
      manufacturerName: newOrder.manufacturerName.trim(),
      sku,
      productName: newOrder.productName.trim(),
      englishName: newOrder.englishName.trim(),
      imageUrl: newOrder.imageUrl.trim(),
      shopName: newOrder.shopName.trim(),
      buyerName: profile.buyerName.trim(),
      assignedBuyerName: profile.buyerName.trim(),
      assignedBuyerEmail: profile.email.trim(),
      isConfirmed: false,
      purchaseQuantity: newQuantity,
      confirmedPurchaseQuantity: null,
      purchasePrice: newPrice,
      freightCost: newFreightCost,
      totalAmount: newTotalAmount,
      purchaseDate: today(),
      purchasePoolId: '',
      purchasePoolName: '',
      purchasePoolDate: '',
      poolStatus: 'pending_purchase',
      purchaseBatchId: '',
      purchaseBatchName: '',
      purchaseBatchDate: '',
      estimatedArrivalDate: '',
      status: newOrder.status,
      unitCbm: newUnitCbm,
      totalCbm: newTotalCbm,
      loadingType: newOrder.loadingType || '整柜',
      containerDate: '',
      totalWeightKg: null,
      cartonCount: newOrder.cartonCount.trim() ? newCartonCount : null,
      unitsPerCarton: newOrder.unitsPerCarton.trim() ? newUnitsPerCarton : null,
      tailQuantity: newTailQuantity,
      isMixed: false,
      mixedGroups: [],
      logisticsTotalCbm: null,
      logisticsBatchId: '',
      logisticsConfirmationStatus: 'unassigned',
      logisticsLoadedCartonCount: null,
      logisticsLoadedTailQuantity: 0,
      logisticsLeftCartonCount: null,
      logisticsLeftTailQuantity: 0,
      logisticsSourceRecordId: '',
      note: newOrder.note.trim(),
    });

    try {
      if (onSaveRecords) await onSaveRecords([record]);
      else await onChange([record, ...records]);
      setNewOrder(createEmptyDraft());
      setMessage('已新增采购订单。');
    } catch (error) {
      console.error(error);
      setMessage(`新增失败：${formatErrorMessage(error)}`);
    }
  }

  async function importOrders(file: File | undefined) {
    if (!file || isViewer) return;
    try {
      const imported = (await parsePurchaseRecordsFile(file, profile)).map((entry) => ({
        ...entry,
        record: withPurchaseTotals({
          ...entry.record,
          purchasePoolId: entry.record.purchasePoolId || entry.record.purchaseBatchId || '',
          purchasePoolName: entry.record.purchasePoolName || entry.record.purchaseBatchName || '',
          purchasePoolDate: entry.record.purchasePoolDate || entry.record.purchaseBatchDate || '',
          poolStatus: entry.record.poolStatus || 'pending_purchase',
          purchaseBatchId: entry.record.purchaseBatchId || '',
          purchaseBatchName: entry.record.purchaseBatchName || '',
          purchaseBatchDate: entry.record.purchaseBatchDate || '',
        }),
      }));
      if (imported.length === 0) {
        setMessage('没有识别到可导入的采购订单。');
        return;
      }
      const result = mergeImportedPurchaseOrders(records, imported, profile.email);
      if (onSaveRecords) {
        await onSaveRecords(result.records);
      } else {
        const changedById = new Map(result.records.map((record) => [record.id, record]));
        const existingIds = new Set(records.map((record) => record.id));
        const created = result.records.filter((record) => !existingIds.has(record.id));
        await onChange([...created, ...records.map((record) => changedById.get(record.id) ?? record)]);
      }
      setMessage(`导入完成：更新 ${result.updatedCount} 条，新增 ${result.createdCount} 条。`);
    } catch (error) {
      console.error(error);
      setMessage(`导入失败：${formatErrorMessage(error)}`);
    }
  }

  function patchRecord(record: PurchaseRecord, field: EditableField, value: string): PurchaseRecord {
    const next: PurchaseRecord = { ...record };
    if (field === 'purchaseQuantity' || field === 'confirmedPurchaseQuantity' || field === 'purchasePrice' || field === 'freightCost' || field === 'unitCbm' || field === 'cartonCount' || field === 'unitsPerCarton' || field === 'tailQuantity' || field === 'totalAmount') {
      next[field] = parseNumber(value);
    } else if (field === 'status') {
      next.status = value as PurchaseStatus;
    } else if (field === 'loadingType') {
      next.loadingType = value as PurchaseRecord['loadingType'];
    } else {
      next[field] = value;
    }
    if (field === 'totalAmount') return withPurchaseTotals(next);
    if (field === 'purchaseQuantity' || field === 'confirmedPurchaseQuantity' || field === 'purchasePrice' || field === 'freightCost' || field === 'cartonCount' || field === 'unitsPerCarton' || field === 'tailQuantity') {
      return withPurchaseTotals({ ...next, totalAmount: calculatedPurchaseTotalAmount(next) }, { recalculateAmount: true });
    }
    return withPurchaseTotals(next);
  }

  function recordWithLocalDrafts(record: PurchaseRecord): PurchaseRecord {
    return editableFields.reduce((current, field) => {
      const key = draftKey(record.id, field);
      return key in drafts ? patchRecord(current, field, drafts[key]) : current;
    }, record);
  }

  function mixedChildRows(record: PurchaseRecord) {
    const mainSku = record.sku.trim().toUpperCase();
    return record.mixedGroups.flatMap((group) => group.lines
      .filter((line) => line.sku.trim().toUpperCase() && line.sku.trim().toUpperCase() !== mainSku)
      .map((line) => ({ group, line })));
  }

  async function commit(record: PurchaseRecord, field: EditableField) {
    const key = draftKey(record.id, field);
    if (!(key in drafts)) return;
    const nextRecord = patchRecord(record, field, drafts[key]);
    rememberScrollPosition();
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await saveRecord(nextRecord);
      setMessage('已保存');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    } finally {
      restoreRememberedScroll();
    }
  }

  function confirmedRecord(record: PurchaseRecord): PurchaseRecord {
    const withMixedDrafts = applyMixedDraftsToRecord(recordWithLocalDrafts(record), mixedDrafts);
    const normalized = withPurchaseTotals(recordWithSkuDefaults(withMixedDrafts));
    return {
      ...normalized,
      isConfirmed: true,
      confirmedPurchaseQuantity: effectivePurchaseQuantity(normalized),
      status: normalized.status === 'cancelled' ? 'cancelled' : 'pending',
      purchasePoolId: normalized.purchasePoolId || normalized.purchaseBatchId,
      purchasePoolName: normalized.purchasePoolName || normalized.purchaseBatchName,
      purchasePoolDate: normalized.purchasePoolDate || normalized.purchaseBatchDate,
      poolStatus: 'submitted_to_pool',
    };
  }

  async function confirmVisiblePurchases() {
    if (isViewer) return;
    const visibleTargets = visibleRecords.filter((record) => record.status === 'pending' && record.poolStatus === 'pending_purchase');
    const targetRecords = visibleTargets.length > 0 ? visibleTargets : submittableAssignedRecords;
    const visibleIds = new Set(targetRecords.map((record) => record.id));
    if (visibleIds.size === 0) {
      setMessage('没有可提交到采购订单池的待采购订单。');
      return;
    }
    try {
      const confirmedRecords = records
        .filter((item) => visibleIds.has(item.id))
        .map((item) => confirmedRecord(item));
      if (onSubmitToPool) {
        const recordsByPool = new Map<string, { pool: PurchasePool; records: PurchaseRecord[] }>();
        for (const record of confirmedRecords) {
          const pool = poolFromRecord(record, profile);
          const existing = recordsByPool.get(pool.id);
          if (existing) existing.records.push(record);
          else recordsByPool.set(pool.id, { pool, records: [record] });
        }
        for (const group of recordsByPool.values()) {
          await onSubmitToPool(group.pool, group.records);
        }
      } else if (onSaveRecords) await onSaveRecords(confirmedRecords);
      else await onChange(records.map((item) => (visibleIds.has(item.id) ? confirmedRecord(item) : item)));
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !visibleIds.has(key.split(':')[0]))));
      setMixedDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !visibleIds.has(key.split(':')[0]))));
      setMessage(`已提交 ${visibleIds.size} 条采购订单到采购订单池，等待 admin 统一发送到采购 / 在途库存。`);
    } catch (error) {
      console.error(error);
      setMessage(`确认失败：${formatErrorMessage(error)}`);
    }
  }

  async function deleteRecord(recordId: string) {
    if (isViewer) return;
    try {
      if (onDeleteRecords) await onDeleteRecords([recordId]);
      else await onChange(records.filter((record) => record.id !== recordId));
      setMessage('已删除采购订单。');
    } catch (error) {
      console.error(error);
      setMessage(`删除失败：${formatErrorMessage(error)}`);
    }
  }

  async function addMixedGroup(record: PurchaseRecord) {
    if (isViewer) return;
    const nextRecord = {
      ...record,
      isMixed: true,
      mixedGroups: [...record.mixedGroups, createMixedGroup(record.mixedGroups.length)],
    };
    await saveRecord(nextRecord);
    setExpandedRows((current) => new Set(current).add(record.id));
  }

  async function deleteMixedGroup(record: PurchaseRecord, groupId: string) {
    if (isViewer) return;
    const mixedGroups = record.mixedGroups.filter((group) => group.id !== groupId);
    await saveRecord({ ...record, mixedGroups, isMixed: mixedGroups.length > 0 });
  }

  async function addMixedLine(record: PurchaseRecord, groupId: string) {
    if (isViewer) return;
    await saveRecord({
      ...record,
      isMixed: true,
      mixedGroups: record.mixedGroups.map((group) => group.id === groupId ? { ...group, lines: [...group.lines, createMixedLine()] } : group),
    });
  }

  async function deleteMixedLine(record: PurchaseRecord, groupId: string, lineId: string) {
    if (isViewer) return;
    await saveRecord({
      ...record,
      mixedGroups: record.mixedGroups.map((group) => group.id === groupId ? { ...group, lines: group.lines.filter((line) => line.id !== lineId) } : group),
    });
  }

  async function commitGroup(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount') {
    const key = groupKey(record.id, group.id, field);
    if (!(key in mixedDrafts)) return;
    const value = mixedDrafts[key];
    const nextGroup = { ...group, [field]: field === 'cartonCount' ? parseNumber(value) : value };
    setMixedDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    await saveRecord({ ...record, mixedGroups: record.mixedGroups.map((item) => item.id === group.id ? nextGroup : item) });
  }

  async function commitLine(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField) {
    const key = mixedKey(record.id, group.id, line.id, field);
    if (!(key in mixedDrafts)) return;
    const value = mixedDrafts[key];
    let nextLine: MixedCartonLine = { ...line };
    if (field === 'quantity' || field === 'purchasePrice' || field === 'unitCbm') nextLine[field] = parseNumber(value);
    else nextLine[field] = value;
    if (field === 'sku') {
      const skuItem = skuBySku.get(skuLookupKey(value));
      if (skuItem) {
        nextLine = { ...nextLine, productName: skuItem.productName, purchasePrice: skuItem.purchasePrice, unitCbm: skuItem.unitCbm };
      }
    }
    nextLine = recalcMixedLine(nextLine);
    setMixedDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    await saveRecord({
      ...record,
      mixedGroups: record.mixedGroups.map((item) => item.id === group.id ? { ...group, lines: group.lines.map((current) => current.id === line.id ? nextLine : current) } : item),
    });
  }

  function toggleExpanded(recordId: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }

  function canEditField(field: EditableField): boolean {
    if (isViewer) return false;
    if (field === 'purchaseQuantity') return false;
    if (isAdmin) return true;
    return field !== 'sku' && field !== 'assignedBuyerName' && field !== 'assignedBuyerEmail';
  }

  function input(record: PurchaseRecord, field: EditableField, type = 'text') {
    if (!canEditField(field)) return <span>{String(record[field] ?? '')}</span>;
    const placeholder = field === 'unitsPerCarton' ? defaultUnitsPerCartonText(record.sku) : undefined;
    const title = field === 'unitsPerCarton' ? defaultUnitsPerCartonTitle(record.sku) : placeholder;
    if (field === 'status') {
      return (
        <select
          value={valueFor(record, field)}
          onChange={(event) => patchDraftValue(record.id, field, event.target.value)}
          onBlur={() => void commit(record, field)}
        >
          {statusEditOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    if (field === 'loadingType') {
      return (
        <select
          value={valueFor(record, field) || '整柜'}
          onChange={(event) => patchDraftValue(record.id, field, event.target.value)}
          onBlur={() => void commit(record, field)}
        >
          <option value="整柜">整柜</option>
          <option value="冠通">冠通</option>
        </select>
      );
    }
    return (
      <input
        type={type}
        value={valueFor(record, field)}
        placeholder={placeholder}
        title={title}
        onChange={(event) => patchDraftValue(record.id, field, event.target.value)}
        onBlur={() => void commit(record, field)}
      />
    );
  }

  function groupInput(record: PurchaseRecord, group: MixedCartonGroup, field: 'groupName' | 'cartonCount', type = 'text') {
    if (isViewer) return <span>{String(group[field])}</span>;
    return (
      <input
        type={type}
        value={groupValueFor(record, group, field)}
        onChange={(event) => setMixedDrafts((current) => ({ ...current, [groupKey(record.id, group.id, field)]: event.target.value }))}
        onBlur={() => void commitGroup(record, group, field)}
      />
    );
  }

  function lineInput(record: PurchaseRecord, group: MixedCartonGroup, line: MixedCartonLine, field: MixedLineField, type = 'text') {
    if (isViewer) return <span>{String(line[field] ?? '')}</span>;
    return (
      <input
        type={type}
        value={mixedValueFor(record, group, line, field)}
        onChange={(event) => setMixedDrafts((current) => ({ ...current, [mixedKey(record.id, group.id, line.id, field)]: event.target.value }))}
        onBlur={() => void commitLine(record, group, line, field)}
      />
    );
  }

  function renderMixedPanel(record: PurchaseRecord) {
    const normalized = withPurchaseTotals(record);
    return (
      <tr className="packing-detail-row">
        <td colSpan={24}>
          <div className="packing-panel">
            <div className="packing-summary">
              <strong>主SKU数量：{purchaseQuantityForRecordSku(normalized)}</strong>
              <strong>其他SKU混装数量：{mixedQuantityForOtherSkus(normalized)}</strong>
              <strong>总件数：{packageCountFor(normalized)}</strong>
              {!isViewer && <button type="button" onClick={() => void addMixedGroup(normalized)}>新增混装组</button>}
            </div>
            {normalized.mixedGroups.length === 0 && <div className="empty">普通整箱不用填写这里；只有混装时新增混装组。</div>}
            {normalized.mixedGroups.map((group) => (
              <div className="mixed-group-card" key={group.id}>
                <div className="packing-summary">
                  <label>混装组{groupInput(normalized, group, 'groupName')}</label>
                  <label>件数{groupInput(normalized, group, 'cartonCount', 'number')}</label>
                  {!isViewer && <button type="button" onClick={() => void addMixedLine(normalized, group.id)}>添加SKU行</button>}
                  {!isViewer && <button className="danger" type="button" onClick={() => void deleteMixedGroup(normalized, group.id)}>删除混装组</button>}
                </div>
                <table className="packing-table">
                  <thead>
                    <tr><th>SKU</th><th>产品名称</th><th>数量</th><th>采购单价</th><th>单品CBM</th><th>金额</th><th>CBM</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {group.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{lineInput(normalized, group, line, 'sku')}</td>
                        <td>{lineInput(normalized, group, line, 'productName')}</td>
                        <td>{lineInput(normalized, group, line, 'quantity', 'number')}</td>
                        <td>{lineInput(normalized, group, line, 'purchasePrice', 'number')}</td>
                        <td>{lineInput(normalized, group, line, 'unitCbm', 'number')}</td>
                        <td>{line.totalAmount.toFixed(2)}</td>
                        <td>{line.totalCbm.toFixed(4)}</td>
                        <td>{!isViewer && <button className="danger" type="button" onClick={() => void deleteMixedLine(normalized, group.id, line.id)}>删除</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <section className="panel my-orders-panel">
      <div className="section-heading my-orders-heading">
        <div className="my-orders-title-block">
          <h2>我的采购订单</h2>
          <p>普通整箱只填整箱件数、每箱数量和尾箱数量；混装商品再单独新增混装组。</p>
          <div className="metric order-cbm-metric">
            <span>当前总立方数</span>
            <strong>{visibleTotalCbm.toFixed(4)} CBM</strong>
          </div>
        </div>
        <div className="export-actions">
          {!isViewer && (
            <label className="secondary-file-button">
              导入订单
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => {
                  void importOrders(event.target.files?.[0]);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          )}
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'xlsx', '我的采购订单', skuItems)} disabled={visibleRecords.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'csv', '我的采购订单')} disabled={visibleRecords.length === 0}>导出 CSV</button>
          {!isViewer && <button className="primary" type="button" onClick={() => void confirmVisiblePurchases()}>提交采购订单池{submittableAssignedRecords.length > 0 ? ` (${unconfirmedVisibleCount || submittableAssignedRecords.length})` : ''}</button>}
        </div>
      </div>
      {message && <div className="inline-notice order-save-notice" role="status">{message}</div>}

      <div className="order-filter-bar">
        <label>
          状态筛选
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as OrderFilterStatus)}>
            {statusFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="order-search-field">
          搜索
          <input
            value={orderSearch}
            placeholder="搜索 SKU、厂家名"
            onChange={(event) => setOrderSearch(event.target.value)}
          />
        </label>
        <span className="order-count-text">当前 {visibleRecords.length} 条 / 我的订单 {assignedRecords.length} 条</span>
      </div>

      {!isViewer && (
        <div className="record-form">
          <label>厂家名<input value={newOrder.manufacturerName} onChange={(event) => patchNewOrder('manufacturerName', event.target.value)} /></label>
          <label>SKU<input value={newOrder.sku} onChange={(event) => patchNewOrder('sku', event.target.value)} /></label>
          <label>产品名称<input value={newOrder.productName} onChange={(event) => patchNewOrder('productName', event.target.value)} /></label>
          <label>英文名称<input value={newOrder.englishName} onChange={(event) => patchNewOrder('englishName', event.target.value)} /></label>
          <label>图片链接<input value={newOrder.imageUrl} onChange={(event) => patchNewOrder('imageUrl', event.target.value)} /></label>
          <label>店铺<input value={newOrder.shopName} onChange={(event) => patchNewOrder('shopName', event.target.value)} /></label>
          <label>采购人<input value={profile.buyerName} readOnly /></label>
          <label>整箱件数<input type="number" min="0" value={newOrder.cartonCount} onChange={(event) => patchNewOrder('cartonCount', event.target.value)} /></label>
          <label>每箱数量<input type="number" min="0" value={newOrder.unitsPerCarton} placeholder={defaultUnitsPerCartonText(newOrder.sku)} title={defaultUnitsPerCartonTitle(newOrder.sku)} onChange={(event) => patchNewOrder('unitsPerCarton', event.target.value)} /></label>
          <label>尾箱数量<input type="number" min="0" value={newOrder.tailQuantity} onChange={(event) => patchNewOrder('tailQuantity', event.target.value)} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={newOrder.purchasePrice} onChange={(event) => patchNewOrder('purchasePrice', event.target.value)} /></label>
          <label>运费<input type="number" min="0" step="0.01" value={newOrder.freightCost} onChange={(event) => patchNewOrder('freightCost', event.target.value)} /></label>
          <label>实际数量<input value={newQuantity} readOnly /></label>
          <label>总金额<input type="number" min="0" step="0.01" value={newOrder.totalAmount} placeholder={newTotalAmount.toFixed(2)} onChange={(event) => patchNewOrder('totalAmount', event.target.value)} /></label>
          <label>单品CBM<input type="number" min="0" step="0.00000001" value={newOrder.unitCbm} onChange={(event) => patchNewOrder('unitCbm', event.target.value)} /></label>
          <label>总CBM<input value={newTotalCbm.toFixed(4)} readOnly /></label>
          <label>状态<select value={newOrder.status} onChange={(event) => patchNewOrder('status', event.target.value as PurchaseStatus)}>{statusEditOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>装货方式<select value={newOrder.loadingType || '整柜'} onChange={(event) => patchNewOrder('loadingType', event.target.value as PurchaseRecord['loadingType'])}><option value="整柜">整柜</option><option value="冠通">冠通</option></select></label>
          <label className="wide">备注<input value={newOrder.note} onChange={(event) => patchNewOrder('note', event.target.value)} /></label>
          <div className="form-actions">
            <button className="primary" type="button" onClick={() => void addNewOrder()}>新增采购订单</button>
            <button type="button" onClick={() => setNewOrder(createEmptyDraft())}>清空</button>
          </div>
        </div>
      )}

      <div className="table-wrap my-orders-table-wrap" ref={tableWrapRef}>
        <table className="my-orders-table">
          <thead>
            <tr>
              <th className="image-sticky-col">图片</th><th>厂家名</th><th>内部编号</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th className="my-orders-compact-text">店铺</th><th className="my-orders-compact-text">采购人</th><th>计划采购数量</th><th className="my-orders-narrow-number">整箱件数</th><th className="my-orders-narrow-number">每箱数量</th><th className="my-orders-narrow-number">尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th className="my-orders-narrow-number">采购单价</th><th className="my-orders-narrow-number my-orders-medium-number">运费</th><th className="my-orders-narrow-number my-orders-medium-number">总金额</th><th className="my-orders-narrow-number my-orders-medium-number">单品CBM</th><th>总CBM</th><th>状态</th><th>装货方式</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.map((record) => {
              const normalized = withPurchaseTotals(recordWithSkuDefaults(record));
              const childRows = mixedChildRows(normalized);
              const purchaseUrl = purchaseUrlForRecord(normalized, skuBySku);
              return (
                <Fragment key={record.id}>
                  <tr>
                    <td className="image-sticky-col">{imageUrlFor(record) ? <img className="sku-thumb" src={imageUrlFor(record)} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                    <td>{input(normalized, 'manufacturerName')}</td>
                    <td><strong>{normalized.internalCode || '-'}</strong></td>
                    <td>{isAdmin ? input(normalized, 'sku') : normalized.sku}</td>
                    <td>{input(normalized, 'productName')}</td>
                    <td>{input(normalized, 'englishName')}</td>
                    <td className="my-orders-compact-text">{input(normalized, 'shopName')}</td>
                    <td className="my-orders-compact-text">{isAdmin ? input(normalized, 'assignedBuyerName') : normalized.assignedBuyerName}</td>
                    <td>{input(normalized, 'purchaseQuantity', 'number')}</td>
                    <td className="my-orders-narrow-number">{input(normalized, 'cartonCount', 'number')}</td>
                    <td className="my-orders-narrow-number">{input(normalized, 'unitsPerCarton', 'number')}</td>
                    <td className="my-orders-narrow-number">{input(normalized, 'tailQuantity', 'number')}</td>
                    <td>{packageCountFor(normalized)}</td>
                    <td>{purchaseQuantityForRecordSku(normalized)}</td>
                    <td>{normalized.isMixed ? '是' : '否'}</td>
                    <td className="my-orders-narrow-number">{input(normalized, 'purchasePrice', 'number')}</td>
                    <td className="my-orders-narrow-number my-orders-medium-number">{input(normalized, 'freightCost', 'number')}</td>
                    <td className="my-orders-narrow-number my-orders-medium-number">{input(normalized, 'totalAmount', 'number')}</td>
                    <td className="my-orders-narrow-number my-orders-medium-number">{input(normalized, 'unitCbm', 'number')}</td>
                    <td>{normalized.totalCbm.toFixed(4)}</td>
                    <td>{input(normalized, 'status')}</td>
                    <td>{input(normalized, 'loadingType')}</td>
                    <td>{input(normalized, 'note')}</td>
                    <td className="row-actions">
                      {purchaseUrl ? (
                        <button type="button" onClick={() => openPurchaseUrl(purchaseUrl)}>1688下单</button>
                      ) : (
                        <span className="muted-action">无采购链接</span>
                      )}
                      <button type="button" onClick={() => toggleExpanded(record.id)}>{expandedRows.has(record.id) ? '收起混装' : '混装'}</button>
                      {!isViewer && <button className="danger" type="button" onClick={() => void deleteRecord(record.id)}>删除</button>}
                    </td>
	                  </tr>
                  {childRows.map(({ group, line }) => (
                    <tr className="mixed-child-row" key={`${normalized.id}:${group.id}:${line.id}`}>
                      <td className="image-sticky-col">{imageUrlBySku.get(skuLookupKey(line.sku)) ? <img className="sku-thumb" src={imageUrlBySku.get(skuLookupKey(line.sku))} alt={line.productName || line.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                      <td>{normalized.manufacturerName}</td>
                      <td>{normalized.internalCode || '-'}</td>
                      <td><strong>{line.sku}</strong></td>
                      <td><strong>{line.productName}</strong></td>
                      <td />
                      <td>{normalized.shopName}</td>
                      <td>{normalized.assignedBuyerName}</td>
                      <td />
                      <td />
                      <td />
                      <td />
                      <td>{group.cartonCount}</td>
                      <td>{line.quantity}</td>
                      <td>混装子行</td>
                      <td>{line.purchasePrice}</td>
                      <td />
                      <td>{line.totalAmount.toFixed(2)}</td>
                      <td>{line.unitCbm.toFixed(8)}</td>
                      <td>{line.totalCbm.toFixed(4)}</td>
                      <td>{statusLabels[normalized.status]}</td>
                      <td>{normalized.loadingType || '整柜'}</td>
                      <td>{`${group.groupName} ${group.cartonCount}件，与 ${normalized.sku || normalized.productName || '主商品'} 混装`}</td>
                      <td />
                    </tr>
                  ))}
	                  {expandedRows.has(record.id) && renderMixedPanel(normalized)}
                </Fragment>
              );
            })}
            {visibleRecords.length === 0 && <tr><td className="empty" colSpan={24}>暂无分配给你的采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
