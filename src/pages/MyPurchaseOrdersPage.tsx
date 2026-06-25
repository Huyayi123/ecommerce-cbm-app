import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { AppProfile, MixedCartonGroup, MixedCartonLine, PurchaseRecord, PurchaseStatus, SkuItem } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { exportPurchaseRecords } from '../utils/exporters';
import { parsePurchaseRecordsFile } from '../utils/fileParsers';
import { round } from '../utils/number';
import { effectivePurchaseQuantity, mixedQuantityForOtherSkus, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from '../utils/purchaseRecords';

type Props = {
  records: PurchaseRecord[];
  skuItems: SkuItem[];
  profile: AppProfile;
  onChange: (records: PurchaseRecord[]) => void | Promise<void>;
  onSaveRecords?: (records: PurchaseRecord[]) => void | Promise<void>;
  onDeleteRecords?: (ids: string[]) => void | Promise<void>;
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

const statusFilterOptions: Array<{ value: PurchaseStatus | 'all'; label: string }> = [
  { value: 'pending', label: '待采购' },
  { value: 'in_transit', label: '海运在途' },
  { value: 'arrived', label: '已到货' },
  { value: 'all', label: '全部' },
];

const statusEditOptions: Array<{ value: PurchaseStatus; label: string }> = statusFilterOptions
  .filter((option): option is { value: PurchaseStatus; label: string } => option.value !== 'all');

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
  'unitCbm',
  'purchaseBatchName',
  'purchaseBatchDate',
  'status',
  'loadingType',
  'note',
] as const;

type EditableField = (typeof editableFields)[number];
type MixedLineField = 'sku' | 'productName' | 'quantity' | 'purchasePrice' | 'unitCbm';

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
    unitCbm: '',
    purchaseBatchId: '',
    purchaseBatchName: '',
    purchaseBatchDate: '',
    status: 'pending',
    loadingType: '整柜',
    note: '',
  };
}

function batchDisplay(record: Pick<PurchaseRecord, 'purchaseBatchDate' | 'purchaseBatchName'>): string {
  const name = record.purchaseBatchName.trim();
  const date = record.purchaseBatchDate.trim();
  if (date && name) return `${date} ${name}`;
  return name || date || '未分配批次';
}

function withBatchDefaults(record: PurchaseRecord): PurchaseRecord {
  return {
    ...record,
    purchaseBatchDate: record.purchaseBatchDate || record.purchaseDate,
    purchaseBatchName: record.purchaseBatchName || (record.purchaseBatchDate || record.purchaseDate ? `${record.purchaseBatchDate || record.purchaseDate} 批次` : ''),
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

export function MyPurchaseOrdersPage({ records, skuItems, profile, onChange, onSaveRecords, onDeleteRecords }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mixedDrafts, setMixedDrafts] = useState<Record<string, string>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [newOrder, setNewOrder] = useState<NewOrderDraft>(() => createEmptyDraft());
  const [message, setMessage] = useState('');
  const mixedAutoSaveTimer = useRef<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<PurchaseStatus | 'all'>('pending');
  const isAdmin = profile.role === 'admin';
  const isViewer = profile.role === 'viewer';
  const assignedRecords = useMemo(
    () => records.filter((record) => (
      record.status !== 'cancelled'
      && record.assignedBuyerEmail.trim().toLowerCase() === profile.email.trim().toLowerCase()
    )),
    [profile.email, records],
  );
  const recentBatch = useMemo(() => {
    return records
      .filter((record) => record.purchaseBatchId || record.purchaseBatchName || record.purchaseBatchDate)
      .sort((left, right) => (
        (right.purchaseBatchDate || '').localeCompare(left.purchaseBatchDate || '')
        || (right.createdAt || '').localeCompare(left.createdAt || '')
        || (right.purchaseBatchName || '').localeCompare(left.purchaseBatchName || '')
      ))[0];
  }, [records]);
  const visibleRecords = useMemo(
    () => statusFilter === 'all' ? assignedRecords : assignedRecords.filter((record) => record.status === statusFilter),
    [assignedRecords, statusFilter],
  );
  const imageUrlBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item.imageUrl])),
    [skuItems],
  );
  const skuBySku = useMemo(
    () => new Map(skuItems.map((item) => [item.sku.trim().toUpperCase(), item])),
    [skuItems],
  );
  const unconfirmedVisibleCount = visibleRecords.filter((record) => !record.isConfirmed && record.status === 'pending').length;

  useEffect(() => {
    if (newOrder.purchaseBatchId || newOrder.purchaseBatchName || newOrder.purchaseBatchDate) return;
    const fallbackDate = today();
    setNewOrder((current) => ({
      ...current,
      purchaseBatchId: recentBatch?.purchaseBatchId || '',
      purchaseBatchName: recentBatch?.purchaseBatchName || `${fallbackDate} 批次`,
      purchaseBatchDate: recentBatch?.purchaseBatchDate || fallbackDate,
    }));
  }, [newOrder.purchaseBatchDate, newOrder.purchaseBatchId, newOrder.purchaseBatchName, recentBatch]);

  const newCartonCount = parseNumber(newOrder.cartonCount);
  const newUnitsPerCarton = parseNumber(newOrder.unitsPerCarton);
  const newTailQuantity = parseNumber(newOrder.tailQuantity);
  const newQuantity = newCartonCount * newUnitsPerCarton + newTailQuantity;
  const newPrice = parseNumber(newOrder.purchasePrice);
  const newFreightCost = parseNumber(newOrder.freightCost);
  const newUnitCbm = parseNumber(newOrder.unitCbm);
  const newTotalAmount = round(newQuantity * newPrice + newFreightCost, 2);
  const newTotalCbm = round(newQuantity * newUnitCbm, 4);

  function imageUrlFor(record: PurchaseRecord): string {
    return record.imageUrl || imageUrlBySku.get(record.sku.trim().toUpperCase()) || '';
  }

  function recordWithSkuDefaults(record: PurchaseRecord): PurchaseRecord {
    const skuItem = skuBySku.get(record.sku.trim().toUpperCase());
    const withBatch = withBatchDefaults(record);
    if (!skuItem) return withBatch;
    return {
      ...withBatch,
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
    const skuItem = skuBySku.get(sku.trim().toUpperCase());
    if (!skuItem || skuItem.unitsPerCarton <= 0) return '未配置默认装箱数';
    return `默认装箱数：${skuItem.unitsPerCarton}`;
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

      const skuItem = skuBySku.get(value.trim().toUpperCase());
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
          const skuItem = skuBySku.get(nextLine.sku.trim().toUpperCase());
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
      purchaseBatchId: newOrder.purchaseBatchId.trim() || recentBatch?.purchaseBatchId || '',
      purchaseBatchName: newOrder.purchaseBatchName.trim() || recentBatch?.purchaseBatchName || '',
      purchaseBatchDate: newOrder.purchaseBatchDate.trim() || recentBatch?.purchaseBatchDate || '',
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
      const imported = (await parsePurchaseRecordsFile(file, profile)).map((record) => withPurchaseTotals({
        ...record,
        purchaseBatchId: record.purchaseBatchId || recentBatch?.purchaseBatchId || '',
        purchaseBatchName: record.purchaseBatchName || recentBatch?.purchaseBatchName || '',
        purchaseBatchDate: record.purchaseBatchDate || recentBatch?.purchaseBatchDate || '',
      }));
      if (imported.length === 0) {
        setMessage('没有识别到可导入的采购订单。');
        return;
      }
      if (onSaveRecords) await onSaveRecords(imported);
      else await onChange([...imported, ...records]);
      setMessage(`已导入 ${imported.length} 条采购订单。`);
    } catch (error) {
      console.error(error);
      setMessage(`导入失败：${formatErrorMessage(error)}`);
    }
  }

  function patchRecord(record: PurchaseRecord, field: EditableField, value: string): PurchaseRecord {
    const next: PurchaseRecord = { ...record };
    if (field === 'purchaseQuantity' || field === 'confirmedPurchaseQuantity' || field === 'purchasePrice' || field === 'freightCost' || field === 'unitCbm' || field === 'cartonCount' || field === 'unitsPerCarton' || field === 'tailQuantity') {
      next[field] = parseNumber(value);
    } else if (field === 'status') {
      next.status = value as PurchaseStatus;
    } else if (field === 'loadingType') {
      next.loadingType = value as PurchaseRecord['loadingType'];
    } else {
      next[field] = value;
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
    }
  }

  function confirmedRecord(record: PurchaseRecord): PurchaseRecord {
    const withMixedDrafts = applyMixedDraftsToRecord(recordWithLocalDrafts(record), mixedDrafts);
    const normalized = withPurchaseTotals(recordWithSkuDefaults(withMixedDrafts));
    return {
      ...normalized,
      isConfirmed: true,
      confirmedPurchaseQuantity: effectivePurchaseQuantity(normalized),
      status: normalized.status === 'pending' ? 'in_transit' : normalized.status,
    };
  }

  async function confirmVisiblePurchases() {
    if (isViewer) return;
    const visibleIds = new Set(visibleRecords.filter((record) => !record.isConfirmed && record.status === 'pending').map((record) => record.id));
    if (visibleIds.size === 0) return;
    try {
      const confirmedRecords = records
        .filter((item) => visibleIds.has(item.id))
        .map((item) => confirmedRecord(item));
      if (onSaveRecords) await onSaveRecords(confirmedRecords);
      else await onChange(records.map((item) => (visibleIds.has(item.id) ? confirmedRecord(item) : item)));
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !visibleIds.has(key.split(':')[0]))));
      setMixedDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !visibleIds.has(key.split(':')[0]))));
      setMessage(`已确认 ${visibleIds.size} 条采购订单，采购 / 在途库存将按回传数据统计。`);
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
      const skuItem = skuBySku.get(value.trim().toUpperCase());
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
    if (field === 'status') {
      return (
        <select
          value={valueFor(record, field)}
          onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
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
          onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
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
        title={placeholder}
        onChange={(event) => setDrafts((current) => ({ ...current, [draftKey(record.id, field)]: event.target.value }))}
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
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>我的采购订单</h2>
          <p>普通整箱只填整箱件数、每箱数量和尾箱数量；混装商品再单独新增混装组。</p>
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
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'xlsx', '我的采购订单')} disabled={visibleRecords.length === 0}>导出 Excel</button>
          <button type="button" onClick={() => exportPurchaseRecords(visibleRecords, 'csv', '我的采购订单')} disabled={visibleRecords.length === 0}>导出 CSV</button>
          {!isViewer && <button className="primary" type="button" onClick={() => void confirmVisiblePurchases()} disabled={unconfirmedVisibleCount === 0}>确认采购</button>}
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}

      <div className="order-filter-bar">
        <label>
          状态筛选
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as PurchaseStatus | 'all')}>
            {statusFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span>当前 {visibleRecords.length} 条 / 我的订单 {assignedRecords.length} 条</span>
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
          <label>批次日期<input type="date" value={newOrder.purchaseBatchDate} onChange={(event) => patchNewOrder('purchaseBatchDate', event.target.value)} /></label>
          <label>批次<input value={newOrder.purchaseBatchName} placeholder={recentBatch ? batchDisplay(recentBatch) : '未分配批次'} onChange={(event) => patchNewOrder('purchaseBatchName', event.target.value)} /></label>
          <label>整箱件数<input type="number" min="0" value={newOrder.cartonCount} onChange={(event) => patchNewOrder('cartonCount', event.target.value)} /></label>
          <label>每箱数量<input type="number" min="0" value={newOrder.unitsPerCarton} placeholder={defaultUnitsPerCartonText(newOrder.sku)} title={defaultUnitsPerCartonText(newOrder.sku)} onChange={(event) => patchNewOrder('unitsPerCarton', event.target.value)} /></label>
          <label>尾箱数量<input type="number" min="0" value={newOrder.tailQuantity} onChange={(event) => patchNewOrder('tailQuantity', event.target.value)} /></label>
          <label>采购单价<input type="number" min="0" step="0.01" value={newOrder.purchasePrice} onChange={(event) => patchNewOrder('purchasePrice', event.target.value)} /></label>
          <label>运费<input type="number" min="0" step="0.01" value={newOrder.freightCost} onChange={(event) => patchNewOrder('freightCost', event.target.value)} /></label>
          <label>实际数量<input value={newQuantity} readOnly /></label>
          <label>总金额<input value={newTotalAmount.toFixed(2)} readOnly /></label>
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

      <div className="table-wrap my-orders-table-wrap">
        <table className="my-orders-table">
          <thead>
            <tr>
              <th>图片</th><th>厂家名</th><th>SKU</th><th>产品名称</th><th>英文名称</th><th>店铺</th><th>采购人</th><th>批次日期</th><th>批次</th><th>计划采购数量</th><th>整箱件数</th><th>每箱数量</th><th>尾箱数量</th><th>总件数</th><th>实际数量</th><th>是否混装</th><th>采购单价</th><th>运费</th><th>总金额</th><th>单品CBM</th><th>总CBM</th><th>状态</th><th>装货方式</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.map((record) => {
              const normalized = withPurchaseTotals(recordWithSkuDefaults(record));
              const childRows = mixedChildRows(normalized);
              return (
                <Fragment key={record.id}>
                  <tr>
                    <td>{imageUrlFor(record) ? <img className="sku-thumb" src={imageUrlFor(record)} alt={record.productName || record.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                    <td>{input(normalized, 'manufacturerName')}</td>
                    <td>{isAdmin ? input(normalized, 'sku') : normalized.sku}</td>
                    <td>{input(normalized, 'productName')}</td>
                    <td>{input(normalized, 'englishName')}</td>
                    <td>{input(normalized, 'shopName')}</td>
                    <td>{isAdmin ? input(normalized, 'assignedBuyerName') : normalized.assignedBuyerName}</td>
                    <td>{input(normalized, 'purchaseBatchDate', 'date')}</td>
                    <td>{input(normalized, 'purchaseBatchName')}</td>
                    <td>{input(normalized, 'purchaseQuantity', 'number')}</td>
                    <td>{input(normalized, 'cartonCount', 'number')}</td>
                    <td>{input(normalized, 'unitsPerCarton', 'number')}</td>
                    <td>{input(normalized, 'tailQuantity', 'number')}</td>
                    <td>{packageCountFor(normalized)}</td>
                    <td>{purchaseQuantityForRecordSku(normalized)}</td>
                    <td>{normalized.isMixed ? '是' : '否'}</td>
                    <td>{input(normalized, 'purchasePrice', 'number')}</td>
                    <td>{input(normalized, 'freightCost', 'number')}</td>
                    <td>{normalized.totalAmount.toFixed(2)}</td>
                    <td>{input(normalized, 'unitCbm', 'number')}</td>
                    <td>{normalized.totalCbm.toFixed(4)}</td>
                    <td>{input(normalized, 'status')}</td>
                    <td>{input(normalized, 'loadingType')}</td>
                    <td>{input(normalized, 'note')}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => toggleExpanded(record.id)}>{expandedRows.has(record.id) ? '收起混装' : '混装'}</button>
                      {!isViewer && <button className="danger" type="button" onClick={() => void deleteRecord(record.id)}>删除</button>}
                    </td>
	                  </tr>
                  {childRows.map(({ group, line }) => (
                    <tr className="mixed-child-row" key={`${normalized.id}:${group.id}:${line.id}`}>
                      <td>{imageUrlBySku.get(line.sku.trim().toUpperCase()) ? <img className="sku-thumb" src={imageUrlBySku.get(line.sku.trim().toUpperCase())} alt={line.productName || line.sku || 'SKU'} loading="lazy" /> : '-'}</td>
                      <td>{normalized.manufacturerName}</td>
                      <td><strong>{line.sku}</strong></td>
                      <td><strong>{line.productName}</strong></td>
                      <td />
                      <td>{normalized.shopName}</td>
                      <td>{normalized.assignedBuyerName}</td>
                      <td>{normalized.purchaseBatchDate}</td>
                      <td>{normalized.purchaseBatchName}</td>
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
            {visibleRecords.length === 0 && <tr><td className="empty" colSpan={25}>暂无分配给你的采购订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
