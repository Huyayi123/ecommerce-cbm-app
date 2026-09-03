import { supabase } from '../lib/supabase';
import type { AdAnalysisRow, AdAnalysisRun, AppProfile, AuditAction, AuditLog, CommissionBuyerSummary, CommissionDetailRow, CommissionRun, LogisticsBatch, LogisticsBatchItem, LogisticsBatchStatus, MonthlyProfitSummary, ProfitAnalysisRow, ProfitAnalysisRun, PurchasePool, PurchasePoolStatus, PurchaseRecord, PurchaseRecordPoolStatus, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem, UserRole } from '../types';
import { formatErrorMessage } from './errors';
import { findMatchingSkuItem, getSkuMatchKey } from './calculations';
import { assignNewInternalCodes, ensureInternalCodes, formatInternalCode, parseInternalCode } from './internalCodes';
import { calculateProfitTotalCost } from './profitCalculations';
import { normalizeMixedGroups, withPurchaseTotals } from './purchaseRecords';
import { frontendSkuToSupabase, supabaseSkuToFrontend, type SupabaseSkuRow } from './skuFieldMapping';

const SKU_SELECT_COLUMNS = [
  'id',
  'internal_code',
  'manufacturer_name',
  'sku',
  'tsin',
  'product_name',
  'english_name',
  'image_url',
  'storage_location',
  'purchase_url',
  'purchase_price',
  'unit_cbm',
  'total_cbm',
  'total_quantity',
  'shop_name',
  'buyer_name',
  'is_seasonal',
  'box_length_cm',
  'box_width_cm',
  'box_height_cm',
  'units_per_carton',
  'notes',
  'cbm_source',
  'updated_at',
].join(',');

type PurchaseRecordRow = {
  id: string;
  internal_code?: string | null;
  manufacturer_name: string | null;
  sku: string;
  product_name: string | null;
  image_url?: string | null;
  freight_cost?: number | null;
  shop_name: string | null;
  buyer_name: string | null;
  assigned_buyer_name: string | null;
  assigned_buyer_email: string | null;
  is_confirmed?: boolean | null;
  purchase_quantity: number | null;
  confirmed_purchase_quantity?: number | null;
  purchase_price: number | null;
  total_amount: number | null;
  purchase_date: string | null;
  purchase_pool_id?: string | null;
  purchase_pool_name?: string | null;
  purchase_pool_date?: string | null;
  pool_status?: string | null;
  purchase_batch_id?: string | null;
  purchase_batch_name?: string | null;
  purchase_batch_date?: string | null;
  estimated_arrival_date: string | null;
  status: string | null;
  english_name: string | null;
  unit_cbm: number | null;
  total_cbm: number | null;
  loading_type?: PurchaseRecord['loadingType'] | null;
  container_date?: string | null;
  total_weight_kg?: number | null;
  carton_count?: number | null;
  units_per_carton?: number | null;
  tail_quantity?: number | null;
  is_mixed?: boolean | null;
  mixed_groups?: unknown;
  logistics_total_cbm?: number | null;
  logistics_batch_id?: string | null;
  logistics_confirmation_status?: string | null;
  logistics_loaded_carton_count?: number | null;
  logistics_loaded_tail_quantity?: number | null;
  logistics_left_carton_count?: number | null;
  logistics_left_tail_quantity?: number | null;
  logistics_source_record_id?: string | null;
  note: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type PurchasePoolRow = {
  id: string;
  name: string | null;
  container_date: string | null;
  status: string | null;
  created_by: string | null;
  created_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  note: string | null;
  records?: unknown;
};

type LogisticsBatchRow = {
  id: string;
  container_date: string | null;
  logistics_user_id: string | null;
  logistics_email: string | null;
  status: string | null;
  created_by: string | null;
  created_at: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
};

type LogisticsBatchItemRow = {
  id: string;
  batch_id: string;
  purchase_record_id: string | null;
  internal_code: string | null;
  manufacturer_name: string | null;
  sku: string | null;
  product_name: string | null;
  english_name: string | null;
  image_url: string | null;
  shop_name: string | null;
  container_date: string | null;
  carton_count: number | null;
  units_per_carton: number | null;
  tail_quantity: number | null;
  total_quantity?: number | null;
  loading_type: PurchaseRecord['loadingType'] | null;
  is_mixed: boolean | null;
  mixed_groups_summary: string | null;
  loaded_carton_count: number | null;
  loaded_tail_quantity: number | null;
  left_carton_count: number | null;
  left_tail_quantity: number | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type LogisticsBatchItemRowWithoutTotalQuantity = Omit<LogisticsBatchItemRow, 'total_quantity'>;

type ContainerRow = {
  id: string;
  row_number: number | null;
  internal_code?: string | null;
  sku: string | null;
  product_name: string | null;
  english_name: string | null;
  manufacturer_name: string | null;
  image_url?: string | null;
  purchase_quantity: number | null;
  raw: Record<string, unknown> | null;
};

type AuditLogRow = {
  id: string;
  actor_id: string;
  actor_email: string;
  actor_role: UserRole;
  action: AuditAction;
  entity_type: AuditLog['entityType'];
  entity_id: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type RepricingAlertRow = {
  id: string;
  shop_name: string | null;
  store_id: string | null;
  sku: string | null;
  title: string | null;
  my_price: number | null;
  buy_box_price: number | null;
  lowest_competitor_price: number | null;
  lowest_competitor_seller: string | null;
  price_gap: number | null;
  alert_level: string | null;
  alert_type: string | null;
  alert_message: string | null;
  is_active: boolean | null;
  checked_at: string | null;
  updated_at: string | null;
};

type AdAnalysisRunRow = {
  id: string;
  created_at: string;
  created_by: string | null;
  source_file_name: string | null;
  row_count: number | null;
  summary: Record<string, number> | null;
};

type AdAnalysisDetailRow = {
  id: string;
  run_id: string;
  sku: string | null;
  product_id: string | null;
  product_name: string | null;
  shop_name: string | null;
  image_url: string | null;
  ad_spend: number | null;
  ad_sales_quantity: number | null;
  roas: number | null;
  sale_price: number | null;
  platform_fee: number | null;
  platform_fee_source: string | null;
  purchase_cost_rmb: number | null;
  purchase_cost_zar: number | null;
  unit_cbm: number | null;
  sea_freight_cost: number | null;
  warehouse_fee: number | null;
  ad_cost_per_sale: number | null;
  profit_rate: number | null;
  sku_rank: number | null;
  product_age_status: AdAnalysisRow['productAgeStatus'] | null;
  strategy_label: AdAnalysisRow['strategyLabel'] | null;
  strategy_name: string | null;
  action_suggestion: string | null;
  messages: string[] | null;
};

type ProfitAnalysisRunRow = { id: string; shop_name: string; created_at: string; created_by: string | null; row_count: number | null; is_complete: boolean | null };
type MonthlyProfitSummaryRow = {
  id: string; shop_name: string; month: string; date_from?: string | null; date_to?: string | null; data_cutoff_date: string; is_current_month: boolean;
  sales_revenue: number; sales_quantity: number; sales_profit: number; return_quantity: number;
  return_profit_reversal: number; return_net_fees: number; advertising_cost: number; salary_cost?: number | null; final_profit: number;
  missing_sales_quantity: number; missing_sales_revenue: number; missing_return_quantity: number;
  status: 'complete' | 'incomplete'; note: string | null; created_by: string | null; updated_at: string;
};

type CommissionRunRow = {
  id: string;
  shop_name: string;
  date_from: string;
  date_to: string;
  created_at: string;
  created_by: string | null;
  row_count: number | null;
  total_sales_quantity: number | null;
  total_sales_revenue_zar: number | null;
  total_sales_revenue_rmb: number | null;
  total_commission_rmb: number | null;
  buyer_summaries: CommissionBuyerSummary[] | null;
  rows: CommissionDetailRow[] | null;
  exceptions: CommissionDetailRow[] | null;
};

type ProfitAnalysisDetailRow = {
  id: string; run_id: string; shop_name: string; sku: string; product_name: string | null; image_url: string | null;
  latest_order_date: string | null; selling_price: number | null; purchase_cost_rmb: number | null; purchase_cost_zar: number | null;
  unit_cbm: number | null; sea_freight_cost: number | null; domestic_freight_cost?: number | null; warehouse_fee: number | null; total_fees: number | null;
  profit: number | null; status: ProfitAnalysisRow['status']; messages: string[] | null; synced_at: string;
};

type LegacySkuRow = {
  id: string;
  internal_code?: string | null;
  sku: string | null;
  product_name: string;
  english_name: string;
  manufacturer_name: string;
  shop_name: string;
  buyer_name: string;
  purchase_price: number;
  carton_length_cm: number;
  carton_width_cm: number;
  carton_height_cm: number;
  units_per_carton: number;
  total_quantity: number;
  total_cbm: number;
  manual_unit_cbm: number;
  updated_at: string;
};

function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

function throwSupabaseError(error: unknown): never {
  console.error(error);
  throw new Error(formatErrorMessage(error));
}

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const payload = error as { code?: string; message?: string };
  return payload.code === 'PGRST204' || /column|schema cache/i.test(payload.message ?? '');
}

function frontendSkuToLegacySupabase(item: SkuItem): LegacySkuRow {
  return {
    id: item.id,
    internal_code: item.internalCode || null,
    sku: item.sku.trim() || null,
    product_name: item.productName,
    english_name: item.englishName,
    manufacturer_name: item.manufacturerName,
    shop_name: item.shopName,
    buyer_name: item.buyerName,
    purchase_price: item.purchasePrice,
    carton_length_cm: item.cartonLengthCm,
    carton_width_cm: item.cartonWidthCm,
    carton_height_cm: item.cartonHeightCm,
    units_per_carton: item.unitsPerCarton,
    total_quantity: item.totalQuantity,
    total_cbm: item.totalCbm,
    manual_unit_cbm: item.unitCbm || item.manualUnitCbm,
    updated_at: item.updatedAt || new Date().toISOString(),
  };
}

function skuRecordScore(item: SkuItem): number {
  let score = 0;
  if (item.imageUrl.trim()) score += 100;
  if (item.shopName.trim()) score += 30;
  if (item.englishName.trim()) score += 20;
  if (item.manufacturerName.trim()) score += 10;
  if (item.productName.trim()) score += 10;
  if (item.id.startsWith('takealot-')) score += 8;
  return score;
}

function pickPreferredSkuRecord(left: SkuItem, right: SkuItem): SkuItem {
  const leftScore = skuRecordScore(left);
  const rightScore = skuRecordScore(right);
  if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  const leftTime = Date.parse(left.updatedAt || '');
  const rightTime = Date.parse(right.updatedAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime > rightTime ? left : right;
  }
  return left.id <= right.id ? left : right;
}

function buildSkuByKey(items: SkuItem[]): Map<string, SkuItem> {
  const byKey = new Map<string, SkuItem>();
  for (const item of items) {
    const key = getSkuMatchKey(item) || item.id;
    const existing = byKey.get(key);
    byKey.set(key, existing ? pickPreferredSkuRecord(existing, item) : item);
  }
  return byKey;
}

function mergeSkuItemsForSave(items: SkuItem[], remote: SkuItem[]): SkuItem[] {
  const remoteByKey = buildSkuByKey(remote);
  const merged = new Map<string, SkuItem>();

  for (const item of items) {
    const key = getSkuMatchKey(item) || item.id;
    const remoteItem = remoteByKey.get(key);
    const baseItem = remoteItem ?? merged.get(key);
    merged.set(key, {
      ...item,
      id: baseItem?.id ?? item.id,
      internalCode: remoteItem ? remoteItem.internalCode : item.internalCode.trim() || baseItem?.internalCode || '',
      manufacturerName: item.manufacturerName.trim() || baseItem?.manufacturerName || '',
      sku: item.sku.trim() || baseItem?.sku || '',
      tsin: item.tsin.trim() || baseItem?.tsin || '',
      productName: item.productName.trim() || baseItem?.productName || '',
      englishName: item.englishName.trim() || baseItem?.englishName || '',
      imageUrl: item.imageUrl.trim() || baseItem?.imageUrl || '',
      storageLocation: item.storageLocation.trim() || baseItem?.storageLocation || '',
      purchaseUrl: item.purchaseUrl.trim() || baseItem?.purchaseUrl || '',
      shopName: item.shopName.trim() || baseItem?.shopName || '',
      buyerName: item.buyerName.trim() || baseItem?.buyerName || '',
      purchasePrice: item.purchasePrice > 0 ? item.purchasePrice : baseItem?.purchasePrice ?? 0,
      manualUnitCbm: item.manualUnitCbm > 0 ? item.manualUnitCbm : baseItem?.manualUnitCbm ?? 0,
      totalCbm: item.totalCbm > 0 ? item.totalCbm : baseItem?.totalCbm ?? 0,
      totalQuantity: item.totalQuantity > 0 ? item.totalQuantity : baseItem?.totalQuantity ?? 0,
      cartonLengthCm: item.cartonLengthCm > 0 ? item.cartonLengthCm : baseItem?.cartonLengthCm ?? 0,
      cartonWidthCm: item.cartonWidthCm > 0 ? item.cartonWidthCm : baseItem?.cartonWidthCm ?? 0,
      cartonHeightCm: item.cartonHeightCm > 0 ? item.cartonHeightCm : baseItem?.cartonHeightCm ?? 0,
      unitsPerCarton: item.unitsPerCarton > 0 ? item.unitsPerCarton : baseItem?.unitsPerCarton ?? 0,
      notes: item.notes.trim() || baseItem?.notes || '',
      updatedAt: item.updatedAt || new Date().toISOString(),
    });
  }

  return Array.from(merged.values());
}

export async function fetchSkuItemsForImport(importItems: SkuItem[]): Promise<SkuItem[]> {
  const client = requireSupabase();
  const matched = new Map<string, SkuItem>();
  const skuValues = Array.from(new Set(importItems.map((item) => item.sku.trim()).filter(Boolean)));

  for (let index = 0; index < skuValues.length; index += 100) {
    const chunk = skuValues.slice(index, index + 100);
    const { data, error } = await client
      .from('sku_items')
      .select('*')
      .in('sku', chunk);
    if (error) throwSupabaseError(error);
    for (const row of (data ?? []) as SupabaseSkuRow[]) {
      const item = supabaseSkuToFrontend(row);
      matched.set(item.id, item);
    }
  }

  const rowsWithoutSku = importItems.filter((item) => !item.sku.trim());
  if (rowsWithoutSku.length > 0) {
    const remote = await fetchSkuItems();
    for (const row of rowsWithoutSku) {
      const existing = findMatchingSkuItem(row, remote);
      if (existing) matched.set(existing.id, existing);
    }
  }

  return Array.from(matched.values());
}

function mapPurchaseRecord(row: PurchaseRecordRow): PurchaseRecord {
  const status = row.status === 'ordered' ? 'in_transit' : row.status;
  const isLegacyInventory = Boolean(row.is_confirmed ?? (row.status !== 'pending')) && (status === 'in_transit' || status === 'arrived');
  const rawPoolStatus: PurchaseRecordPoolStatus | undefined = row.pool_status === 'submitted_to_pool' || row.pool_status === 'sent_to_inventory' || row.pool_status === 'pending_purchase'
    ? row.pool_status
    : undefined;
  const poolStatus: PurchaseRecordPoolStatus = isLegacyInventory ? 'sent_to_inventory' : rawPoolStatus ?? 'pending_purchase';
  return withPurchaseTotals({
    id: row.id,
    internalCode: row.internal_code ?? '',
    manufacturerName: row.manufacturer_name ?? '',
    sku: row.sku,
    productName: row.product_name ?? '',
    imageUrl: row.image_url ?? '',
    shopName: row.shop_name ?? '',
    buyerName: row.buyer_name ?? '',
    assignedBuyerName: row.assigned_buyer_name ?? row.buyer_name ?? '',
    assignedBuyerEmail: row.assigned_buyer_email ?? '',
    isConfirmed: Boolean(row.is_confirmed ?? (row.status !== 'pending')),
    englishName: row.english_name ?? '',
    purchaseQuantity: Number(row.purchase_quantity ?? 0),
    confirmedPurchaseQuantity: row.confirmed_purchase_quantity === null || row.confirmed_purchase_quantity === undefined ? null : Number(row.confirmed_purchase_quantity),
    purchasePrice: Number(row.purchase_price ?? 0),
    freightCost: Number(row.freight_cost ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    purchaseDate: row.purchase_date ?? '',
    purchasePoolId: row.purchase_pool_id ?? row.purchase_batch_id ?? '',
    purchasePoolName: row.purchase_pool_name ?? row.purchase_batch_name ?? '',
    purchasePoolDate: row.purchase_pool_date ?? row.purchase_batch_date ?? '',
    poolStatus,
    purchaseBatchId: row.purchase_batch_id ?? '',
    purchaseBatchName: row.purchase_batch_name ?? '',
    purchaseBatchDate: row.purchase_batch_date ?? '',
    estimatedArrivalDate: row.estimated_arrival_date ?? '',
    status: status === 'in_transit' || status === 'arrived' || status === 'cancelled' ? status : 'pending',
    unitCbm: Number(row.unit_cbm ?? 0),
    totalCbm: Number(row.total_cbm ?? 0),
    loadingType: row.loading_type ?? '',
    containerDate: row.container_date ?? '',
    totalWeightKg: row.total_weight_kg === null || row.total_weight_kg === undefined ? null : Number(row.total_weight_kg),
    cartonCount: row.carton_count === null || row.carton_count === undefined ? null : Number(row.carton_count),
    unitsPerCarton: row.units_per_carton === null || row.units_per_carton === undefined ? null : Number(row.units_per_carton),
    tailQuantity: Number(row.tail_quantity ?? 0),
    isMixed: Boolean(row.is_mixed ?? false),
    mixedGroups: normalizeMixedGroups(row.mixed_groups),
    logisticsTotalCbm: row.logistics_total_cbm === null || row.logistics_total_cbm === undefined ? null : Number(row.logistics_total_cbm),
    logisticsBatchId: row.logistics_batch_id ?? '',
    logisticsConfirmationStatus: row.logistics_confirmation_status === 'draft' || row.logistics_confirmation_status === 'submitted' || row.logistics_confirmation_status === 'approved' || row.logistics_confirmation_status === 'rejected'
      ? row.logistics_confirmation_status
      : 'unassigned',
    logisticsLoadedCartonCount: row.logistics_loaded_carton_count === null || row.logistics_loaded_carton_count === undefined ? null : Number(row.logistics_loaded_carton_count),
    logisticsLoadedTailQuantity: Number(row.logistics_loaded_tail_quantity ?? 0),
    logisticsLeftCartonCount: row.logistics_left_carton_count === null || row.logistics_left_carton_count === undefined ? null : Number(row.logistics_left_carton_count),
    logisticsLeftTailQuantity: Number(row.logistics_left_tail_quantity ?? 0),
    logisticsSourceRecordId: row.logistics_source_record_id ?? '',
    note: row.note ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  });
}

function dateOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mapPurchasePool(row: PurchasePoolRow): PurchasePool {
  const status: PurchasePoolStatus = row.status === 'sent' || row.status === 'closed' ? row.status : 'open';
  return {
    id: row.id,
    name: row.name ?? '',
    containerDate: row.container_date ?? '',
    status,
    createdBy: row.created_by ?? '',
    createdAt: row.created_at ?? '',
    sentBy: row.sent_by ?? '',
    sentAt: row.sent_at ?? '',
    note: row.note ?? '',
    records: normalizePoolRecords(row.records),
  };
}

function logisticsStatus(value: string | null | undefined): LogisticsBatchStatus {
  return value === 'submitted' || value === 'approved' || value === 'rejected' ? value : 'draft';
}

function mapLogisticsBatchItem(row: LogisticsBatchItemRow): LogisticsBatchItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    purchaseRecordId: row.purchase_record_id ?? '',
    internalCode: row.internal_code ?? '',
    manufacturerName: row.manufacturer_name ?? '',
    sku: row.sku ?? '',
    productName: row.product_name ?? '',
    englishName: row.english_name ?? '',
    imageUrl: row.image_url ?? '',
    shopName: row.shop_name ?? '',
    containerDate: row.container_date ?? '',
    cartonCount: row.carton_count === null || row.carton_count === undefined ? null : Number(row.carton_count),
    unitsPerCarton: row.units_per_carton === null || row.units_per_carton === undefined ? null : Number(row.units_per_carton),
    tailQuantity: Number(row.tail_quantity ?? 0),
    totalQuantity: Number(row.total_quantity ?? 0),
    loadingType: row.loading_type ?? '',
    isMixed: Boolean(row.is_mixed ?? false),
    mixedGroupsSummary: row.mixed_groups_summary ?? '',
    loadedCartonCount: row.loaded_carton_count === null || row.loaded_carton_count === undefined ? null : Number(row.loaded_carton_count),
    loadedTailQuantity: Number(row.loaded_tail_quantity ?? 0),
    leftCartonCount: row.left_carton_count === null || row.left_carton_count === undefined ? null : Number(row.left_carton_count),
    leftTailQuantity: Number(row.left_tail_quantity ?? 0),
    note: row.note ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

function mapLogisticsBatch(row: LogisticsBatchRow, items: LogisticsBatchItem[]): LogisticsBatch {
  return {
    id: row.id,
    containerDate: row.container_date ?? '',
    logisticsUserId: row.logistics_user_id ?? '',
    logisticsEmail: row.logistics_email ?? '',
    status: logisticsStatus(row.status),
    createdBy: row.created_by ?? '',
    createdAt: row.created_at ?? '',
    submittedAt: row.submitted_at ?? '',
    reviewedBy: row.reviewed_by ?? '',
    reviewedAt: row.reviewed_at ?? '',
    note: row.note ?? '',
    items,
  };
}

function toLogisticsBatchRow(batch: LogisticsBatch): LogisticsBatchRow {
  return {
    id: batch.id,
    container_date: dateOrNull(batch.containerDate),
    logistics_user_id: batch.logisticsUserId || null,
    logistics_email: batch.logisticsEmail || null,
    status: batch.status,
    created_by: batch.createdBy || null,
    created_at: batch.createdAt || new Date().toISOString(),
    submitted_at: batch.submittedAt || null,
    reviewed_by: batch.reviewedBy || null,
    reviewed_at: batch.reviewedAt || null,
    note: batch.note,
  };
}

function toLogisticsBatchItemRow(item: LogisticsBatchItem): LogisticsBatchItemRow {
  return {
    id: item.id,
    batch_id: item.batchId,
    purchase_record_id: item.purchaseRecordId || null,
    internal_code: item.internalCode,
    manufacturer_name: item.manufacturerName,
    sku: item.sku,
    product_name: item.productName,
    english_name: item.englishName,
    image_url: item.imageUrl,
    shop_name: item.shopName,
    container_date: dateOrNull(item.containerDate),
    carton_count: item.cartonCount,
    units_per_carton: item.unitsPerCarton,
    tail_quantity: item.tailQuantity,
    total_quantity: item.totalQuantity,
    loading_type: item.loadingType || null,
    is_mixed: item.isMixed,
    mixed_groups_summary: item.mixedGroupsSummary,
    loaded_carton_count: item.loadedCartonCount,
    loaded_tail_quantity: item.loadedTailQuantity,
    left_carton_count: item.leftCartonCount,
    left_tail_quantity: item.leftTailQuantity,
    note: item.note,
    created_at: item.createdAt || null,
    updated_at: item.updatedAt || null,
  };
}

function withoutLogisticsTotalQuantity(row: LogisticsBatchItemRow): LogisticsBatchItemRowWithoutTotalQuantity {
  const rest = { ...row };
  delete rest.total_quantity;
  return rest;
}

function toPurchasePoolRow(pool: PurchasePool): PurchasePoolRow {
  return {
    id: pool.id,
    name: pool.name,
    container_date: dateOrNull(pool.containerDate),
    status: pool.status,
    created_by: pool.createdBy || null,
    created_at: pool.createdAt || null,
    sent_by: pool.sentBy || null,
    sent_at: pool.sentAt || null,
    note: pool.note,
    records: pool.records.map((record) => withPurchaseTotals(record)),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePoolRecord(value: unknown): PurchaseRecord {
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return mapPurchaseRecord({
    id: String(payload.id ?? crypto.randomUUID()),
    internal_code: String(payload.internalCode ?? payload.internal_code ?? ''),
    manufacturer_name: String(payload.manufacturerName ?? payload.manufacturer_name ?? ''),
    sku: String(payload.sku ?? ''),
    product_name: String(payload.productName ?? payload.product_name ?? ''),
    image_url: String(payload.imageUrl ?? payload.image_url ?? ''),
    shop_name: String(payload.shopName ?? payload.shop_name ?? ''),
    buyer_name: String(payload.buyerName ?? payload.buyer_name ?? ''),
    assigned_buyer_name: String(payload.assignedBuyerName ?? payload.assigned_buyer_name ?? ''),
    assigned_buyer_email: String(payload.assignedBuyerEmail ?? payload.assigned_buyer_email ?? ''),
    is_confirmed: Boolean(payload.isConfirmed ?? payload.is_confirmed ?? false),
    purchase_quantity: Number(payload.purchaseQuantity ?? payload.purchase_quantity ?? 0),
    confirmed_purchase_quantity: nullableNumber(payload.confirmedPurchaseQuantity ?? payload.confirmed_purchase_quantity),
    purchase_price: Number(payload.purchasePrice ?? payload.purchase_price ?? 0),
    freight_cost: Number(payload.freightCost ?? payload.freight_cost ?? 0),
    total_amount: Number(payload.totalAmount ?? payload.total_amount ?? 0),
    purchase_date: String(payload.purchaseDate ?? payload.purchase_date ?? ''),
    purchase_pool_id: String(payload.purchasePoolId ?? payload.purchase_pool_id ?? ''),
    purchase_pool_name: String(payload.purchasePoolName ?? payload.purchase_pool_name ?? ''),
    purchase_pool_date: String(payload.purchasePoolDate ?? payload.purchase_pool_date ?? ''),
    pool_status: String(payload.poolStatus ?? payload.pool_status ?? 'submitted_to_pool'),
    purchase_batch_id: String(payload.purchaseBatchId ?? payload.purchase_batch_id ?? ''),
    purchase_batch_name: String(payload.purchaseBatchName ?? payload.purchase_batch_name ?? ''),
    purchase_batch_date: String(payload.purchaseBatchDate ?? payload.purchase_batch_date ?? ''),
    estimated_arrival_date: String(payload.estimatedArrivalDate ?? payload.estimated_arrival_date ?? ''),
    status: String(payload.status ?? 'pending'),
    english_name: String(payload.englishName ?? payload.english_name ?? ''),
    unit_cbm: Number(payload.unitCbm ?? payload.unit_cbm ?? 0),
    total_cbm: Number(payload.totalCbm ?? payload.total_cbm ?? 0),
    loading_type: String(payload.loadingType ?? payload.loading_type ?? '') as PurchaseRecord['loadingType'],
    container_date: String(payload.containerDate ?? payload.container_date ?? ''),
    total_weight_kg: nullableNumber(payload.totalWeightKg ?? payload.total_weight_kg),
    carton_count: nullableNumber(payload.cartonCount ?? payload.carton_count),
    units_per_carton: nullableNumber(payload.unitsPerCarton ?? payload.units_per_carton),
    tail_quantity: Number(payload.tailQuantity ?? payload.tail_quantity ?? 0),
    is_mixed: Boolean(payload.isMixed ?? payload.is_mixed ?? false),
    mixed_groups: payload.mixedGroups ?? payload.mixed_groups,
    logistics_total_cbm: nullableNumber(payload.logisticsTotalCbm ?? payload.logistics_total_cbm),
    logistics_batch_id: String(payload.logisticsBatchId ?? payload.logistics_batch_id ?? ''),
    logistics_confirmation_status: String(payload.logisticsConfirmationStatus ?? payload.logistics_confirmation_status ?? 'unassigned'),
    logistics_loaded_carton_count: nullableNumber(payload.logisticsLoadedCartonCount ?? payload.logistics_loaded_carton_count),
    logistics_loaded_tail_quantity: Number(payload.logisticsLoadedTailQuantity ?? payload.logistics_loaded_tail_quantity ?? 0),
    logistics_left_carton_count: nullableNumber(payload.logisticsLeftCartonCount ?? payload.logistics_left_carton_count),
    logistics_left_tail_quantity: Number(payload.logisticsLeftTailQuantity ?? payload.logistics_left_tail_quantity ?? 0),
    logistics_source_record_id: String(payload.logisticsSourceRecordId ?? payload.logistics_source_record_id ?? ''),
    note: String(payload.note ?? ''),
    created_at: String(payload.createdAt ?? payload.created_at ?? ''),
    updated_at: String(payload.updatedAt ?? payload.updated_at ?? ''),
  });
}

function normalizePoolRecords(value: unknown): PurchaseRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((record) => normalizePoolRecord(record));
}

function toPurchaseRecordRow(record: PurchaseRecord): PurchaseRecordRow {
  const normalized = withPurchaseTotals(record);
  return {
    id: normalized.id,
    internal_code: normalized.internalCode || null,
    manufacturer_name: normalized.manufacturerName,
    sku: normalized.sku,
    product_name: normalized.productName,
    image_url: normalized.imageUrl,
    shop_name: normalized.shopName,
    buyer_name: normalized.buyerName,
    assigned_buyer_name: normalized.assignedBuyerName,
    assigned_buyer_email: normalized.assignedBuyerEmail,
    is_confirmed: normalized.isConfirmed,
    purchase_quantity: normalized.purchaseQuantity,
    confirmed_purchase_quantity: normalized.confirmedPurchaseQuantity,
    purchase_price: normalized.purchasePrice,
    freight_cost: normalized.freightCost,
    total_amount: normalized.totalAmount,
    purchase_date: dateOrNull(normalized.purchaseDate),
    purchase_pool_id: normalized.purchasePoolId || normalized.purchaseBatchId || null,
    purchase_pool_name: normalized.purchasePoolName || normalized.purchaseBatchName || null,
    purchase_pool_date: dateOrNull(normalized.purchasePoolDate || normalized.purchaseBatchDate),
    pool_status: normalized.poolStatus,
    purchase_batch_id: normalized.purchaseBatchId || null,
    purchase_batch_name: normalized.purchaseBatchName || null,
    purchase_batch_date: dateOrNull(normalized.purchaseBatchDate),
    estimated_arrival_date: dateOrNull(normalized.estimatedArrivalDate),
    status: normalized.status,
    english_name: normalized.englishName,
    unit_cbm: normalized.unitCbm,
    total_cbm: normalized.totalCbm,
    loading_type: normalized.loadingType || null,
    container_date: dateOrNull(normalized.containerDate),
    total_weight_kg: normalized.totalWeightKg,
    carton_count: normalized.cartonCount,
    units_per_carton: normalized.unitsPerCarton,
    tail_quantity: normalized.tailQuantity,
    is_mixed: normalized.isMixed,
    mixed_groups: normalized.mixedGroups,
    logistics_total_cbm: normalized.logisticsTotalCbm,
    logistics_batch_id: normalized.logisticsBatchId || null,
    logistics_confirmation_status: normalized.logisticsConfirmationStatus || 'unassigned',
    logistics_loaded_carton_count: normalized.logisticsLoadedCartonCount,
    logistics_loaded_tail_quantity: normalized.logisticsLoadedTailQuantity,
    logistics_left_carton_count: normalized.logisticsLeftCartonCount,
    logistics_left_tail_quantity: normalized.logisticsLeftTailQuantity,
    logistics_source_record_id: normalized.logisticsSourceRecordId || null,
    note: normalized.note,
  };
}

function mapContainerRow(row: ContainerRow): PurchaseRow {
  return {
    rowId: row.id,
    rowNumber: Number(row.row_number ?? 0),
    internalCode: row.internal_code ?? (typeof row.raw?.internalCode === 'string' ? row.raw.internalCode : ''),
    sku: row.sku ?? '',
    productName: row.product_name ?? '',
    englishName: row.english_name ?? '',
    imageUrl: typeof row.raw?.imageUrl === 'string' ? row.raw.imageUrl : '',
    manufacturerName: row.manufacturer_name ?? '',
    shopName: typeof row.raw?.shopName === 'string' ? row.raw.shopName : '',
    purchaseQuantity: row.purchase_quantity,
    manualTotalCbm: typeof row.raw?.manualTotalCbm === 'number' ? row.raw.manualTotalCbm : null,
    raw: row.raw ?? {},
  };
}

function toContainerRow(row: PurchaseRow): ContainerRow {
  return {
    id: row.rowId,
    row_number: row.rowNumber,
    internal_code: row.internalCode ?? null,
    sku: row.sku,
    product_name: row.productName,
    english_name: row.englishName,
    manufacturer_name: row.manufacturerName,
    purchase_quantity: row.purchaseQuantity,
    raw: { ...row.raw, internalCode: row.internalCode ?? row.raw.internalCode ?? '', shopName: row.shopName ?? row.raw.shopName ?? '', imageUrl: row.imageUrl ?? row.raw.imageUrl ?? '', manualTotalCbm: row.manualTotalCbm ?? null },
  };
}

export async function fetchProfile(userId: string, email: string): Promise<AppProfile> {
  const client = requireSupabase();
  const { data, error } = await client
    .from('profiles')
    .select('id,email,role,display_name,buyer_name')
    .eq('id', userId)
    .maybeSingle();

  if (error) throwSupabaseError(error);
  if (!data) {
    return { id: userId, email, role: 'viewer', displayName: email, buyerName: '' };
  }

  return {
    id: data.id,
    email: data.email ?? email,
    role: (data.role ?? 'viewer') as UserRole,
    displayName: data.display_name ?? data.email ?? email,
    buyerName: data.buyer_name ?? '',
  };
}

export async function fetchProfiles(): Promise<AppProfile[]> {
  const { data, error } = await requireSupabase()
    .from('profiles')
    .select('id,email,role,display_name,buyer_name')
    .order('email');
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    role: (row.role ?? 'viewer') as UserRole,
    displayName: row.display_name ?? row.email,
    buyerName: row.buyer_name ?? '',
  }));
}

export async function updateProfileBinding(profile: AppProfile): Promise<AppProfile> {
  const { data, error } = await requireSupabase()
    .from('profiles')
    .upsert({
      id: profile.id,
      email: profile.email,
      display_name: profile.displayName,
      buyer_name: profile.buyerName,
    }, { onConflict: 'id' })
    .select('id,email,role,display_name,buyer_name')
    .single();
  if (error) throwSupabaseError(error);
  if (!data) throw new Error('账号绑定保存失败：数据库没有返回保存结果');

  return {
    id: data.id,
    email: data.email ?? profile.email,
    role: (data.role ?? profile.role) as UserRole,
    displayName: data.display_name ?? data.email ?? profile.email,
    buyerName: data.buyer_name ?? '',
  };
}

export async function fetchSkuItems(): Promise<SkuItem[]> {
  return ensureInternalCodes(await fetchRawSkuItems());
}

async function fetchRawSkuItems(): Promise<SkuItem[]> {
  const client = requireSupabase();
  const pageSize = 1000;
  const rows: SupabaseSkuRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('sku_items')
      .select(SKU_SELECT_COLUMNS)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throwSupabaseError(error);
    rows.push(...((data ?? []) as unknown as SupabaseSkuRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows.map((row) => supabaseSkuToFrontend(row));
}

export async function replaceSkuItems(items: SkuItem[]): Promise<void> {
  const client = requireSupabase();
  const remote = await fetchRawSkuItems();
  const normalizedItems = assignNewInternalCodes(mergeSkuItemsForSave(items, remote), remote);
  const nextIds = new Set(normalizedItems.map((item) => item.id));
  const deleteIds = remote.map((item) => item.id).filter((id) => !nextIds.has(id));

  if (normalizedItems.length > 0) {
    const { error } = await client.from('sku_items').upsert(normalizedItems.map(frontendSkuToSupabase), { onConflict: 'id' });
    if (error) {
      console.error(error);
      if (!isMissingColumnError(error)) throw new Error(formatErrorMessage(error));
      const { error: legacyError } = await client.from('sku_items').upsert(normalizedItems.map(frontendSkuToLegacySupabase), { onConflict: 'id' });
      if (legacyError) throwSupabaseError(legacyError);
    }
  }
  if (deleteIds.length > 0) {
    const { error } = await client.from('sku_items').delete().in('id', deleteIds);
    if (error) throwSupabaseError(error);
  }
}

export async function upsertSkuItem(item: SkuItem, localItems: SkuItem[] = []): Promise<SkuItem> {
  const client = requireSupabase();
  let normalized = item;

  if (parseInternalCode(normalized.internalCode) === 0) {
    const localMaxCode = localItems.reduce((max, current) => Math.max(max, parseInternalCode(current.internalCode)), 0);
    const { data, error } = await client
      .from('sku_items')
      .select('internal_code')
      .not('internal_code', 'is', null)
      .neq('internal_code', '')
      .order('internal_code', { ascending: false })
      .limit(1);
    if (error) throwSupabaseError(error);
    const remoteMaxCode = parseInternalCode(String(data?.[0]?.internal_code ?? ''));
    normalized = {
      ...normalized,
      internalCode: formatInternalCode(Math.max(localMaxCode, remoteMaxCode) + 1),
    };
  }

  const { data, error } = await client
    .from('sku_items')
    .upsert(frontendSkuToSupabase(normalized), { onConflict: 'id' })
    .select(SKU_SELECT_COLUMNS)
    .single();
  if (error) {
    console.error(error);
    throw new Error(formatErrorMessage(error));
  }
  if (!data) throw new Error('SKU 保存失败：云端没有返回保存结果');
  return supabaseSkuToFrontend(data as unknown as SupabaseSkuRow);
}

export async function fetchPurchaseRecords(): Promise<PurchaseRecord[]> {
  const client = requireSupabase();
  const pageSize = 1000;
  const rows: PurchaseRecordRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('purchase_records')
      .select('*')
      .order('purchase_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throwSupabaseError(error);
    rows.push(...((data ?? []) as PurchaseRecordRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows.map((row) => mapPurchaseRecord(row));
}

export async function fetchLogisticsBatches(): Promise<LogisticsBatch[]> {
  const client = requireSupabase();
  const { data: batchData, error: batchError } = await client
    .from('logistics_batches')
    .select('*')
    .order('container_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (batchError) {
    console.error(batchError);
    if (isMissingColumnError(batchError) || /logistics_batches/i.test(formatErrorMessage(batchError))) {
      throw new Error(`物流装柜确认表还没有创建，请先在 Supabase SQL Editor 执行 supabase.sql 中的物流模块 SQL。原始错误：${formatErrorMessage(batchError)}`);
    }
    throw new Error(formatErrorMessage(batchError));
  }

  const rows = (batchData ?? []) as LogisticsBatchRow[];
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const { data: itemData, error: itemError } = await client
    .from('logistics_batch_items')
    .select('*')
    .in('batch_id', ids)
    .order('internal_code', { ascending: true });
  if (itemError) throwSupabaseError(itemError);

  const itemsByBatch = new Map<string, LogisticsBatchItem[]>();
  for (const row of (itemData ?? []) as LogisticsBatchItemRow[]) {
    const item = mapLogisticsBatchItem(row);
    itemsByBatch.set(item.batchId, [...(itemsByBatch.get(item.batchId) ?? []), item]);
  }

  return rows.map((row) => mapLogisticsBatch(row, itemsByBatch.get(row.id) ?? []));
}

export async function upsertLogisticsBatch(batch: LogisticsBatch): Promise<void> {
  const client = requireSupabase();
  const now = new Date().toISOString();
  const normalized: LogisticsBatch = {
    ...batch,
    createdAt: batch.createdAt || now,
    items: batch.items.map((item) => ({ ...item, batchId: batch.id, createdAt: item.createdAt || now, updatedAt: now })),
  };

  const { error: batchError } = await client.from('logistics_batches').upsert(toLogisticsBatchRow(normalized));
  if (batchError) throwSupabaseError(batchError);

  const { error: deleteError } = await client.from('logistics_batch_items').delete().eq('batch_id', normalized.id);
  if (deleteError) throwSupabaseError(deleteError);

  if (normalized.items.length > 0) {
    const itemRows = normalized.items.map(toLogisticsBatchItemRow);
    const { error: itemsError } = await client.from('logistics_batch_items').insert(itemRows);
    if (itemsError) {
      if (!isMissingColumnError(itemsError)) throwSupabaseError(itemsError);
      const { error: retryError } = await client.from('logistics_batch_items').insert(itemRows.map(withoutLogisticsTotalQuantity));
      if (retryError) throwSupabaseError(retryError);
    }
  }
}

export async function updateLogisticsBatchStatus(batch: LogisticsBatch): Promise<void> {
  const { error } = await requireSupabase().from('logistics_batches').upsert(toLogisticsBatchRow(batch));
  if (error) throwSupabaseError(error);
}

export async function submitLogisticsBatch(batch: LogisticsBatch): Promise<void> {
  const client = requireSupabase();
  const submittedAt = batch.submittedAt || new Date().toISOString();
  for (const item of batch.items) {
    const { error } = await client
      .from('logistics_batch_items')
      .update({
        loaded_carton_count: item.loadedCartonCount,
        loaded_tail_quantity: item.loadedTailQuantity,
        left_carton_count: item.leftCartonCount,
        left_tail_quantity: item.leftTailQuantity,
        note: item.note,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id);
    if (error) throwSupabaseError(error);
  }

  const { error: batchError } = await client
    .from('logistics_batches')
    .update({ status: 'submitted', submitted_at: submittedAt, note: batch.note })
    .eq('id', batch.id);
  if (batchError) throwSupabaseError(batchError);
}

export async function clearLogisticsConfirmations(): Promise<void> {
  const client = requireSupabase();
  const { error: deleteError } = await client
    .from('logistics_batches')
    .delete()
    .neq('id', '');
  if (deleteError) throwSupabaseError(deleteError);

  const { error: resetError } = await client
    .from('purchase_records')
    .update({
      logistics_batch_id: null,
      logistics_confirmation_status: 'unassigned',
      logistics_loaded_carton_count: null,
      logistics_loaded_tail_quantity: 0,
      logistics_left_carton_count: null,
      logistics_left_tail_quantity: 0,
      logistics_source_record_id: null,
    })
    .neq('id', '');
  if (resetError) throwSupabaseError(resetError);
}

export async function fetchPurchasePools(): Promise<PurchasePool[]> {
  const { data, error } = await requireSupabase()
    .from('purchase_pools')
    .select('*')
    .order('container_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => mapPurchasePool(row as PurchasePoolRow));
}

export async function upsertPurchasePools(pools: PurchasePool[]): Promise<void> {
  if (pools.length === 0) return;
  const { error } = await requireSupabase().from('purchase_pools').upsert(pools.map(toPurchasePoolRow));
  if (error) {
    console.error(error);
    if (isMissingColumnError(error)) {
      throw new Error(`purchase_pools 表不存在或字段缺失。请先在 Supabase SQL Editor 执行采购订单池迁移 SQL。原始错误：${formatErrorMessage(error)}`);
    }
    throw new Error(formatErrorMessage(error));
  }
}

export async function appendPurchaseRecordsToPool(pool: PurchasePool, records: PurchaseRecord[]): Promise<PurchasePool> {
  const client = requireSupabase();
  const { data, error } = await client
    .from('purchase_pools')
    .select('*')
    .eq('id', pool.id)
    .maybeSingle();
  if (error) {
    console.error(error);
    if (isMissingColumnError(error)) {
      throw new Error(`purchase_pools 表缺少 records 字段。请先执行 SQL：alter table public.purchase_pools add column if not exists records jsonb not null default '[]'::jsonb; 原始错误：${formatErrorMessage(error)}`);
    }
    throw new Error(formatErrorMessage(error));
  }

  const remotePool = data ? mapPurchasePool(data as PurchasePoolRow) : null;
  const mergedById = new Map<string, PurchaseRecord>();
  for (const record of remotePool?.records ?? []) {
    mergedById.set(record.id, record);
  }
  for (const record of records) {
    mergedById.set(record.id, withPurchaseTotals({
      ...record,
      isConfirmed: true,
      poolStatus: 'submitted_to_pool',
      status: 'pending',
      purchasePoolId: record.purchasePoolId || pool.id,
      purchasePoolName: record.purchasePoolName || pool.name,
      purchasePoolDate: record.purchasePoolDate || pool.containerDate,
    }));
  }

  const nextPool: PurchasePool = {
    ...(remotePool ?? pool),
    id: pool.id,
    name: remotePool?.name || pool.name,
    containerDate: remotePool?.containerDate || pool.containerDate,
    status: 'open',
    createdBy: remotePool?.createdBy || pool.createdBy,
    createdAt: remotePool?.createdAt || pool.createdAt || new Date().toISOString(),
    sentBy: remotePool?.sentBy || '',
    sentAt: remotePool?.sentAt || '',
    note: remotePool?.note || pool.note,
    records: Array.from(mergedById.values()),
  };

  const { error: upsertError } = await client.from('purchase_pools').upsert(toPurchasePoolRow(nextPool));
  if (upsertError) {
    console.error(upsertError);
    if (isMissingColumnError(upsertError)) {
      throw new Error(`purchase_pools 表缺少 records 字段。请先执行 SQL：alter table public.purchase_pools add column if not exists records jsonb not null default '[]'::jsonb; 原始错误：${formatErrorMessage(upsertError)}`);
    }
    throw new Error(formatErrorMessage(upsertError));
  }

  return nextPool;
}

export async function replacePurchaseRecords(records: PurchaseRecord[]): Promise<void> {
  const client = requireSupabase();

  if (records.length > 0) {
    const { error } = await client.from('purchase_records').upsert(records.map(toPurchaseRecordRow));
    if (error) {
      console.error(error);
      if (isMissingColumnError(error)) {
        throw new Error(`purchase_records 表缺少新字段，混装/箱规数据无法保存。请先在 Supabase SQL Editor 执行采购记录字段迁移 SQL。原始错误：${formatErrorMessage(error)}`);
      }
      throw new Error(formatErrorMessage(error));
    }
  }
}

export async function upsertPurchaseRecords(records: PurchaseRecord[]): Promise<void> {
  if (records.length === 0) return;
  const expectedIds = new Set(records.map((record) => record.id));
  const { data, error } = await requireSupabase()
    .from('purchase_records')
    .upsert(records.map(toPurchaseRecordRow))
    .select('id');
  if (error) {
    console.error(error);
    if (isMissingColumnError(error)) {
      throw new Error(`purchase_records 表缺少新字段，采购记录无法保存。请先在 Supabase SQL Editor 执行采购记录字段迁移 SQL。原始错误：${formatErrorMessage(error)}`);
    }
    throw new Error(formatErrorMessage(error));
  }
  const savedIds = new Set((data ?? []).map((row) => String(row.id)));
  const missingIds = Array.from(expectedIds).filter((id) => !savedIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`采购订单保存未被云端确认：${missingIds.length} 条记录没有返回保存结果。请检查网络/VPN 或 Supabase RLS 写入权限后重试。`);
  }
}

export async function deletePurchaseRecords(ids: string[]): Promise<void> {
  const deleteIds = ids.map((id) => id.trim()).filter(Boolean);
  if (deleteIds.length === 0) return;
  const { data, error } = await requireSupabase().from('purchase_records').delete().in('id', deleteIds).select('id');
  if (error) throwSupabaseError(error);
  const deletedCount = data?.length ?? 0;
  if (deletedCount !== deleteIds.length) {
    throw new Error(`删除失败：云端只删除了 ${deletedCount}/${deleteIds.length} 条采购订单。请检查 purchase_records 的删除权限，buyer 需要允许删除分配给自己的订单。`);
  }
}

export async function fetchContainerRows(): Promise<PurchaseRow[]> {
  const { data, error } = await requireSupabase().from('container_rows').select('*').order('row_number');
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => mapContainerRow(row as ContainerRow));
}

export async function replaceContainerRows(rows: PurchaseRow[]): Promise<void> {
  const client = requireSupabase();
  const { error: deleteError } = await client.from('container_rows').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (deleteError) throwSupabaseError(deleteError);
  if (rows.length === 0) return;
  const { error } = await client.from('container_rows').insert(rows.map(toContainerRow));
  if (error) throwSupabaseError(error);
}

export async function replaceSalesSuggestions(rows: SalesSuggestionRow[]): Promise<void> {
  const client = requireSupabase();
  const { error: deleteError } = await client.from('sales_suggestions').delete().neq('id', 'never-match');
  if (deleteError) throwSupabaseError(deleteError);
  if (rows.length === 0) return;

  const { error } = await client.from('sales_suggestions').insert(
    rows.map((row) => ({
      id: row.rowId,
      sku: row.sku,
      product_name: row.productName,
      shop_name: row.shopName,
      manufacturer_name: row.manufacturerName,
      buyer_name: row.buyerName,
      monthly_sales: row.monthlySales,
      stock_months: row.stockMonths,
      target_quantity: row.targetQuantity,
      local_stock_quantity: row.localStockQuantity,
      takealot_stock_quantity: row.takealotStockQuantity,
      stock_on_way_quantity: row.stockOnWayQuantity,
      in_transit_quantity: row.inTransitQuantity,
      suggested_quantity: row.suggestedQuantity,
      units_per_carton: row.unitsPerCarton,
      estimated_cartons: row.estimatedCartons,
      estimated_cbm: row.estimatedCbm,
      messages: row.messages,
    })),
  );
  if (error) throwSupabaseError(error);
}

export async function fetchSalesSuggestions(): Promise<SalesSuggestionRow[]> {
  const client = requireSupabase();
  const pageSize = 1000;
  const allRows: Array<{
    id: string;
    sku: string | null;
    product_name: string | null;
    shop_name: string | null;
    manufacturer_name: string | null;
    buyer_name: string | null;
    monthly_sales: number | null;
    stock_months: number | null;
    target_quantity: number | null;
    local_stock_quantity: number | null;
    takealot_stock_quantity: number | null;
    stock_on_way_quantity: number | null;
    in_transit_quantity: number | null;
    suggested_quantity: number | null;
    units_per_carton: number | null;
    estimated_cartons: number | null;
    estimated_cbm: number | null;
    messages: unknown;
  }> = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('sales_suggestions')
      .select('id,sku,product_name,shop_name,manufacturer_name,buyer_name,monthly_sales,stock_months,target_quantity,local_stock_quantity,takealot_stock_quantity,stock_on_way_quantity,in_transit_quantity,suggested_quantity,units_per_carton,estimated_cartons,estimated_cbm,messages')
      .order('shop_name', { ascending: true })
      .order('sku', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throwSupabaseError(error);
    const rows = data ?? [];
    allRows.push(...rows);
    if (rows.length < pageSize) break;
  }

  return allRows.map((row) => ({
    rowId: row.id,
    sku: row.sku ?? '',
    productName: row.product_name ?? '',
    shopName: row.shop_name ?? '',
    manufacturerName: row.manufacturer_name ?? '',
    buyerName: row.buyer_name ?? '',
    monthlySales: Number(row.monthly_sales ?? 0),
    stockMonths: Number(row.stock_months ?? 2),
    targetQuantity: Number(row.target_quantity ?? 0),
    localStockQuantity: Number(row.local_stock_quantity ?? 0),
    takealotStockQuantity: Number(row.takealot_stock_quantity ?? 0),
    stockOnWayQuantity: Number(row.stock_on_way_quantity ?? 0),
    inTransitQuantity: Number(row.in_transit_quantity ?? 0),
    suggestedQuantity: Number(row.suggested_quantity ?? 0),
    unitsPerCarton: row.units_per_carton === null ? null : Number(row.units_per_carton ?? 0),
    estimatedCartons: row.estimated_cartons === null ? null : Number(row.estimated_cartons ?? 0),
    estimatedCbm: row.estimated_cbm === null ? null : Number(row.estimated_cbm ?? 0),
    messages: Array.isArray(row.messages) ? row.messages : [],
  }));
}

function mapRepricingAlert(row: RepricingAlertRow): RepricingAlert {
  const level = row.alert_level === 'high' || row.alert_level === 'medium' || row.alert_level === 'review' ? row.alert_level : 'none';
  return {
    id: row.id,
    shopName: row.shop_name ?? '',
    storeId: row.store_id ?? '',
    sku: row.sku ?? '',
    title: row.title ?? '',
    imageUrl: '',
    productName: '',
    myPrice: row.my_price === null || row.my_price === undefined ? null : Number(row.my_price),
    buyBoxPrice: row.buy_box_price === null || row.buy_box_price === undefined ? null : Number(row.buy_box_price),
    lowestCompetitorPrice: row.lowest_competitor_price === null || row.lowest_competitor_price === undefined ? null : Number(row.lowest_competitor_price),
    lowestCompetitorSeller: row.lowest_competitor_seller ?? '',
    priceGap: row.price_gap === null || row.price_gap === undefined ? null : Number(row.price_gap),
    alertLevel: level,
    alertType: row.alert_type ?? 'none',
    alertMessage: row.alert_message ?? '',
    isActive: Boolean(row.is_active),
    checkedAt: row.checked_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

function mapAdAnalysisRow(row: AdAnalysisDetailRow): AdAnalysisRow {
  return {
    id: row.id,
    runId: row.run_id,
    sku: row.sku ?? '',
    productId: row.product_id ?? '',
    productName: row.product_name ?? '',
    shopName: row.shop_name ?? '',
    imageUrl: row.image_url ?? '',
    adSpend: Number(row.ad_spend ?? 0),
    adSalesQuantity: Number(row.ad_sales_quantity ?? 0),
    roas: row.roas === null || row.roas === undefined ? null : Number(row.roas),
    salePrice: Number(row.sale_price ?? 0),
    platformFee: Number(row.platform_fee ?? 0),
    platformFeeSource: row.platform_fee_source === 'api' || row.platform_fee_source === 'fallback' ? row.platform_fee_source : 'missing',
    purchaseCostRmb: Number(row.purchase_cost_rmb ?? 0),
    purchaseCostZar: Number(row.purchase_cost_zar ?? 0),
    unitCbm: Number(row.unit_cbm ?? 0),
    seaFreightCost: Number(row.sea_freight_cost ?? 0),
    warehouseFee: Number(row.warehouse_fee ?? 0),
    adCostPerSale: Number(row.ad_cost_per_sale ?? 0),
    profitRate: row.profit_rate === null || row.profit_rate === undefined ? null : Number(row.profit_rate),
    skuRank: row.sku_rank === null || row.sku_rank === undefined ? null : Number(row.sku_rank),
    productAgeStatus: row.product_age_status ?? 'unknown',
    strategyLabel: row.strategy_label ?? 'missing_data',
    strategyName: row.strategy_name ?? '',
    actionSuggestion: row.action_suggestion ?? '',
    messages: Array.isArray(row.messages) ? row.messages : [],
  };
}

function toAdAnalysisDetailRow(row: AdAnalysisRow): AdAnalysisDetailRow {
  return {
    id: row.id,
    run_id: row.runId,
    sku: row.sku,
    product_id: row.productId,
    product_name: row.productName,
    shop_name: row.shopName,
    image_url: row.imageUrl,
    ad_spend: row.adSpend,
    ad_sales_quantity: row.adSalesQuantity,
    roas: row.roas,
    sale_price: row.salePrice,
    platform_fee: row.platformFee,
    platform_fee_source: row.platformFeeSource,
    purchase_cost_rmb: row.purchaseCostRmb,
    purchase_cost_zar: row.purchaseCostZar,
    unit_cbm: row.unitCbm,
    sea_freight_cost: row.seaFreightCost,
    warehouse_fee: row.warehouseFee,
    ad_cost_per_sale: row.adCostPerSale,
    profit_rate: row.profitRate,
    sku_rank: row.skuRank,
    product_age_status: row.productAgeStatus,
    strategy_label: row.strategyLabel,
    strategy_name: row.strategyName,
    action_suggestion: row.actionSuggestion,
    messages: row.messages,
  };
}

function mapAdAnalysisRun(row: AdAnalysisRunRow, rows: AdAnalysisRow[]): AdAnalysisRun {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdBy: row.created_by ?? '',
    sourceFileName: row.source_file_name ?? '',
    rowCount: Number(row.row_count ?? rows.length),
    summary: row.summary ?? {},
    rows,
  };
}

export async function fetchRepricingAlerts(): Promise<RepricingAlert[]> {
  const { data, error } = await requireSupabase()
    .from('repricing_alerts')
    .select('*')
    .eq('is_active', true)
    .order('alert_level', { ascending: true })
    .order('checked_at', { ascending: false });
  if (error) {
    console.error(error);
    if (isMissingColumnError(error) || /repricing_alerts/i.test(formatErrorMessage(error))) {
      throw new Error(`价格预警表还没有创建，请先在 Supabase SQL Editor 执行 repricing 表结构 SQL。原始错误：${formatErrorMessage(error)}`);
    }
    throw new Error(formatErrorMessage(error));
  }
  return (data ?? []).map((row) => mapRepricingAlert(row as RepricingAlertRow));
}

export async function fetchAdAnalysisRuns(): Promise<AdAnalysisRun[]> {
  const client = requireSupabase();
  const { data: runsData, error: runsError } = await client
    .from('ad_analysis_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(6);
  if (runsError) {
    console.error(runsError);
    if (isMissingColumnError(runsError) || /ad_analysis_runs/i.test(formatErrorMessage(runsError))) {
      throw new Error(`广告分析表还没有创建，请先在 Supabase SQL Editor 执行 supabase.sql 中的广告分析表结构。原始错误：${formatErrorMessage(runsError)}`);
    }
    throw new Error(formatErrorMessage(runsError));
  }

  const runRows = (runsData ?? []) as AdAnalysisRunRow[];
  const runIds = runRows.slice(0, 3).map((row) => row.id);
  if (runIds.length === 0) return [];

  const rowsByRun = new Map<string, AdAnalysisRow[]>();
  const pageSize = 500;
  for (const runId of runIds) {
    const rows: AdAnalysisRow[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('ad_analysis_rows')
        .select('*')
        .eq('run_id', runId)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throwSupabaseError(error);
      const page = (data ?? []) as AdAnalysisDetailRow[];
      rows.push(...page.map(mapAdAnalysisRow));
      if (page.length < pageSize) break;
    }
    rowsByRun.set(runId, rows);
  }

  return runRows
    .map((run) => mapAdAnalysisRun(run, rowsByRun.get(run.id) ?? []))
    .filter((run) => run.rows.length > 0)
    .slice(0, 3);
}

export async function saveAdAnalysisRun(run: AdAnalysisRun): Promise<void> {
  const client = requireSupabase();
  const { error: runError } = await client.from('ad_analysis_runs').upsert({
    id: run.id,
    created_at: run.createdAt,
    created_by: run.createdBy,
    source_file_name: run.sourceFileName,
    row_count: run.rowCount,
    summary: run.summary,
  });
  if (runError) throwSupabaseError(runError);

  if (run.rows.length > 0) {
    const { error: rowsError } = await client.from('ad_analysis_rows').upsert(run.rows.map(toAdAnalysisDetailRow));
    if (rowsError) {
      await client.from('ad_analysis_rows').delete().eq('run_id', run.id);
      await client.from('ad_analysis_runs').delete().eq('id', run.id);
      throwSupabaseError(rowsError);
    }
  }

  const { data: allRuns, error: listError } = await client
    .from('ad_analysis_runs')
    .select('id,created_at')
    .order('created_at', { ascending: false });
  if (listError) throwSupabaseError(listError);

  const allRunIds = ((allRuns ?? []) as Array<{ id: string }>).map((item) => item.id);
  if (allRunIds.length === 0) return;

  const { data: savedRows, error: savedRowsError } = await client
    .from('ad_analysis_rows')
    .select('run_id')
    .in('run_id', allRunIds);
  if (savedRowsError) throwSupabaseError(savedRowsError);

  const runsWithRows = new Set(((savedRows ?? []) as Array<{ run_id: string }>).map((item) => item.run_id));
  const completeRunIds = allRunIds.filter((id) => runsWithRows.has(id));
  const staleIds = allRunIds.filter((id) => !runsWithRows.has(id)).concat(completeRunIds.slice(3));
  if (staleIds.length === 0) return;

  const { error: deleteRowsError } = await client.from('ad_analysis_rows').delete().in('run_id', staleIds);
  if (deleteRowsError) throwSupabaseError(deleteRowsError);
  const { error: deleteRunsError } = await client.from('ad_analysis_runs').delete().in('id', staleIds);
  if (deleteRunsError) throwSupabaseError(deleteRunsError);
}

function mapProfitRow(row: ProfitAnalysisDetailRow): ProfitAnalysisRow {
  const purchaseCostZar = row.purchase_cost_zar === null ? null : Number(row.purchase_cost_zar);
  const seaFreightCost = row.sea_freight_cost === null ? null : Number(row.sea_freight_cost);
  const domesticFreightCost = row.domestic_freight_cost == null ? null : Number(row.domestic_freight_cost);
  const warehouseFee = row.warehouse_fee === null ? null : Number(row.warehouse_fee);
  const totalFees = row.total_fees === null ? null : Number(row.total_fees);
  return {
    id: row.id, runId: row.run_id, shopName: row.shop_name, sku: row.sku, productName: row.product_name ?? '', imageUrl: row.image_url ?? '',
    latestOrderDate: row.latest_order_date ?? '', sellingPrice: row.selling_price === null ? null : Number(row.selling_price),
    purchaseCostRmb: row.purchase_cost_rmb === null ? null : Number(row.purchase_cost_rmb), purchaseCostZar,
    unitCbm: row.unit_cbm === null ? null : Number(row.unit_cbm), seaFreightCost,
    domesticFreightCost,
    warehouseFee, totalFees,
    totalCost: calculateProfitTotalCost({ purchaseCostZar, seaFreightCost, domesticFreightCost, totalFees, warehouseFee }),
    profit: row.profit === null ? null : Number(row.profit), status: row.status, messages: Array.isArray(row.messages) ? row.messages : [], syncedAt: row.synced_at,
  };
}

function toProfitRow(row: ProfitAnalysisRow): ProfitAnalysisDetailRow {
  return {
    id: row.id, run_id: row.runId, shop_name: row.shopName, sku: row.sku, product_name: row.productName, image_url: row.imageUrl,
    latest_order_date: row.latestOrderDate || null, selling_price: row.sellingPrice, purchase_cost_rmb: row.purchaseCostRmb, purchase_cost_zar: row.purchaseCostZar,
    unit_cbm: row.unitCbm, sea_freight_cost: row.seaFreightCost, domestic_freight_cost: row.domesticFreightCost, warehouse_fee: row.warehouseFee, total_fees: row.totalFees,
    profit: row.profit, status: row.status, messages: row.messages, synced_at: row.syncedAt,
  };
}

export async function fetchProfitAnalysisRuns(): Promise<ProfitAnalysisRun[]> {
  const client = requireSupabase();
  const { data: runData, error: runError } = await client
    .from('profit_analysis_runs')
    .select('*')
    .eq('is_complete', true)
    .order('created_at', { ascending: false })
    .limit(36);
  if (runError) {
    if (/profit_analysis_runs|schema cache|does not exist/i.test(formatErrorMessage(runError))) return [];
    throwSupabaseError(runError);
  }
  const allRuns = (runData ?? []) as ProfitAnalysisRunRow[];
  const latestByShop = new Map<string, ProfitAnalysisRunRow>();
  for (const run of allRuns) if (!latestByShop.has(run.shop_name)) latestByShop.set(run.shop_name, run);
  const latestRuns = [...latestByShop.values()];
  if (!latestRuns.length) return [];
  const pageSize = 500;
  const rowGroups = await Promise.all(latestRuns.map(async (run) => {
    const rows: ProfitAnalysisDetailRow[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client.from('profit_analysis_rows')
        .select('*')
        .eq('run_id', run.id)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throwSupabaseError(error);
      const page = (data ?? []) as ProfitAnalysisDetailRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }));
  const rowsByRun = new Map<string, ProfitAnalysisRow[]>();
  for (const group of rowGroups) {
    for (const raw of group) {
      const row = mapProfitRow(raw);
      rowsByRun.set(row.runId, [...(rowsByRun.get(row.runId) ?? []), row]);
    }
  }
  return latestRuns.map((run) => ({ id: run.id, shopName: run.shop_name, createdAt: run.created_at, createdBy: run.created_by ?? '', rowCount: Number(run.row_count ?? 0), rows: rowsByRun.get(run.id) ?? [] }));
}

export async function saveProfitAnalysisRun(run: ProfitAnalysisRun): Promise<void> {
  const client = requireSupabase();
  const { error: runError } = await client.from('profit_analysis_runs').insert({ id: run.id, shop_name: run.shopName, created_at: run.createdAt, created_by: run.createdBy, row_count: run.rowCount, is_complete: false });
  if (runError) throwSupabaseError(runError);
  const { error: rowsError } = run.rows.length
    ? await client.from('profit_analysis_rows').insert(run.rows.map(toProfitRow))
    : { error: null };
  if (rowsError) {
    await client.from('profit_analysis_runs').delete().eq('id', run.id);
    throwSupabaseError(rowsError);
  }
  const { error: completeError } = await client.from('profit_analysis_runs').update({ is_complete: true }).eq('id', run.id);
  if (completeError) {
    await client.from('profit_analysis_runs').delete().eq('id', run.id);
    throwSupabaseError(completeError);
  }
  const { data: staleRuns, error: staleError } = await client.from('profit_analysis_runs').select('id').eq('shop_name', run.shopName).neq('id', run.id);
  if (staleError) throwSupabaseError(staleError);
  const staleIds = ((staleRuns ?? []) as Array<{ id: string }>).map((item) => item.id);
  if (staleIds.length) {
    const { error } = await client.from('profit_analysis_runs').delete().in('id', staleIds);
    if (error) throwSupabaseError(error);
  }
}

function mapMonthlyProfitSummary(row: MonthlyProfitSummaryRow): MonthlyProfitSummary {
  return {
    id: row.id, shopName: row.shop_name, month: row.month, dateFrom: row.date_from ?? `${row.month}-01`, dateTo: row.date_to ?? row.data_cutoff_date, dataCutoffDate: row.data_cutoff_date,
    isCurrentMonth: row.is_current_month, salesRevenue: Number(row.sales_revenue), salesQuantity: Number(row.sales_quantity),
    salesProfit: Number(row.sales_profit), returnQuantity: Number(row.return_quantity), returnProfitReversal: Number(row.return_profit_reversal),
    returnNetFees: Number(row.return_net_fees), advertisingCost: Number(row.advertising_cost), salaryCost: Number(row.salary_cost ?? 0), finalProfit: Number(row.final_profit),
    missingSalesQuantity: Number(row.missing_sales_quantity), missingSalesRevenue: Number(row.missing_sales_revenue),
    missingReturnQuantity: Number(row.missing_return_quantity), status: row.status, note: row.note ?? '', createdBy: row.created_by ?? '', updatedAt: row.updated_at,
  };
}

export async function fetchMonthlyProfitSummaries(): Promise<MonthlyProfitSummary[]> {
  const { data, error } = await requireSupabase().from('monthly_profit_summaries').select('*').order('month', { ascending: false });
  if (error) {
    if (/monthly_profit_summaries|schema cache|does not exist/i.test(formatErrorMessage(error))) return [];
    throwSupabaseError(error);
  }
  return ((data ?? []) as MonthlyProfitSummaryRow[]).map(mapMonthlyProfitSummary);
}

export async function upsertMonthlyProfitSummary(summary: MonthlyProfitSummary): Promise<void> {
  const { error } = await requireSupabase().from('monthly_profit_summaries').upsert({
    id: summary.id, shop_name: summary.shopName, month: summary.month, date_from: summary.dateFrom, date_to: summary.dateTo, data_cutoff_date: summary.dataCutoffDate,
    is_current_month: summary.isCurrentMonth, sales_revenue: summary.salesRevenue, sales_quantity: summary.salesQuantity,
    sales_profit: summary.salesProfit, return_quantity: summary.returnQuantity, return_profit_reversal: summary.returnProfitReversal,
    return_net_fees: summary.returnNetFees, advertising_cost: summary.advertisingCost, salary_cost: summary.salaryCost, final_profit: summary.finalProfit,
    missing_sales_quantity: summary.missingSalesQuantity, missing_sales_revenue: summary.missingSalesRevenue,
    missing_return_quantity: summary.missingReturnQuantity, status: summary.status, note: summary.note,
    created_by: summary.createdBy, updated_at: summary.updatedAt,
  }, { onConflict: 'shop_name,date_from,date_to' });
  if (error) throwSupabaseError(error);
}

function mapCommissionRun(row: CommissionRunRow): CommissionRun {
  const buyerSummaries = Array.isArray(row.buyer_summaries) ? row.buyer_summaries : [];
  const rows = Array.isArray(row.rows) ? row.rows : [];
  const exceptions = Array.isArray(row.exceptions) ? row.exceptions : [];
  return {
    id: row.id,
    shopName: row.shop_name,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    createdAt: row.created_at,
    createdBy: row.created_by ?? '',
    rowCount: Number(row.row_count ?? rows.length),
    totalSalesQuantity: Number(row.total_sales_quantity ?? 0),
    totalSalesRevenueZar: Number(row.total_sales_revenue_zar ?? 0),
    totalSalesRevenueRmb: Number(row.total_sales_revenue_rmb ?? 0),
    totalCommissionRmb: Number(row.total_commission_rmb ?? 0),
    buyerSummaries,
    rows,
    exceptions,
  };
}

export async function fetchCommissionRuns(): Promise<CommissionRun[]> {
  const { data, error } = await requireSupabase()
    .from('commission_runs')
    .select('id,shop_name,date_from,date_to,created_at,created_by,row_count,total_sales_quantity,total_sales_revenue_zar,total_sales_revenue_rmb,total_commission_rmb,buyer_summaries')
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) {
    if (/commission_runs|schema cache|does not exist/i.test(formatErrorMessage(error))) return [];
    throwSupabaseError(error);
  }
  return ((data ?? []) as CommissionRunRow[]).map(mapCommissionRun);
}

export async function fetchCommissionRun(runId: string): Promise<CommissionRun | null> {
  if (!runId) return null;
  const { data, error } = await requireSupabase()
    .from('commission_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (error) {
    if (/commission_runs|schema cache|does not exist/i.test(formatErrorMessage(error))) return null;
    throwSupabaseError(error);
  }
  return data ? mapCommissionRun(data as CommissionRunRow) : null;
}

export async function saveCommissionRun(run: CommissionRun): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from('commission_runs').upsert({
    id: run.id,
    shop_name: run.shopName,
    date_from: run.dateFrom,
    date_to: run.dateTo,
    created_at: run.createdAt,
    created_by: run.createdBy,
    row_count: run.rowCount,
    total_sales_quantity: run.totalSalesQuantity,
    total_sales_revenue_zar: run.totalSalesRevenueZar,
    total_sales_revenue_rmb: run.totalSalesRevenueRmb,
    total_commission_rmb: run.totalCommissionRmb,
    buyer_summaries: run.buyerSummaries,
    rows: run.rows,
    exceptions: run.exceptions,
  });
  if (error) throwSupabaseError(error);

  const { data: staleRuns, error: staleError } = await client
    .from('commission_runs')
    .select('id')
    .order('created_at', { ascending: false })
    .range(12, 1000);
  if (staleError) throwSupabaseError(staleError);
  const staleIds = ((staleRuns ?? []) as Array<{ id: string }>).map((item) => item.id);
  if (staleIds.length) {
    const { error: deleteError } = await client.from('commission_runs').delete().in('id', staleIds);
    if (deleteError) throwSupabaseError(deleteError);
  }
}

function mapAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function fetchAuditLogs(): Promise<AuditLog[]> {
  const { data, error } = await requireSupabase()
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => mapAuditLog(row as AuditLogRow));
}

export async function createAuditLog(input: Omit<AuditLog, 'id' | 'createdAt'>): Promise<void> {
  const { error } = await requireSupabase().from('audit_logs').insert({
    id: crypto.randomUUID(),
    actor_id: input.actorId,
    actor_email: input.actorEmail,
    actor_role: input.actorRole,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    summary: input.summary,
    metadata: input.metadata,
  });
  if (error) throwSupabaseError(error);
}

export function subscribeToSharedTables(onChange: () => void): () => void {
  if (!supabase) return () => undefined;
  const client = supabase;
  const channel = client
    .channel('shared-data')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sku_items' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_records' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_pools' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'container_rows' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_suggestions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'repricing_alerts' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ad_analysis_runs' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_runs' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logistics_batches' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logistics_batch_items' }, onChange)
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
