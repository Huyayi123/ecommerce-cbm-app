import { supabase } from '../lib/supabase';
import type {
  AppProfile,
  HaichuanData,
  HaichuanInboundItem,
  HaichuanLoadingBatch,
  HaichuanLoadingItem,
  HaichuanWarehouseLot,
  PurchaseRecord,
} from '../types';
import { formatErrorMessage } from './errors';
import { declaredTotalCartonCount, haichuanPurchaseTotalQuantity } from './haichuan';

function client() {
  if (!supabase) throw new Error('Supabase 尚未配置');
  return supabase;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function mapInbound(row: Record<string, unknown>): HaichuanInboundItem {
  return {
    id: textValue(row.id),
    purchaseRecordId: textValue(row.purchase_record_id),
    logisticsUserId: textValue(row.logistics_user_id),
    logisticsEmail: textValue(row.logistics_email),
    internalCode: textValue(row.internal_code),
    manufacturerName: textValue(row.manufacturer_name),
    sku: textValue(row.sku),
    productName: textValue(row.product_name),
    englishName: textValue(row.english_name),
    imageUrl: textValue(row.image_url),
    shopName: textValue(row.shop_name),
    buyerName: textValue(row.buyer_name),
    purchaseTotalQuantity: numberValue(row.purchase_total_quantity),
    declaredCartonCount: numberValue(row.declared_carton_count),
    declaredUnitsPerCarton: numberValue(row.declared_units_per_carton),
    declaredTailQuantity: numberValue(row.declared_tail_quantity),
    declaredTotalCartonCount: numberValue(row.declared_total_carton_count),
    actualReceivedCartonCount: numberValue(row.actual_received_carton_count),
    unitCbm: numberValue(row.unit_cbm),
    declaredTotalCbm: numberValue(row.declared_total_cbm),
    hasPackingVariance: Boolean(row.has_packing_variance),
    status: row.status === 'received' ? 'received' : 'pending_receipt',
    receivedBy: textValue(row.received_by),
    receivedAt: textValue(row.received_at),
    createdAt: textValue(row.created_at),
    updatedAt: textValue(row.updated_at),
  };
}

function mapWarehouseLot(row: Record<string, unknown>): HaichuanWarehouseLot {
  const rawStatus = textValue(row.status);
  const status: HaichuanWarehouseLot['status'] = rawStatus === 'partially_reserved' || rawStatus === 'fully_reserved' || rawStatus === 'depleted'
    ? rawStatus
    : 'available';
  return {
    id: textValue(row.id), inboundItemId: textValue(row.inbound_item_id), purchaseRecordId: textValue(row.purchase_record_id),
    logisticsUserId: textValue(row.logistics_user_id), logisticsEmail: textValue(row.logistics_email),
    internalCode: textValue(row.internal_code), manufacturerName: textValue(row.manufacturer_name), sku: textValue(row.sku),
    productName: textValue(row.product_name), englishName: textValue(row.english_name), imageUrl: textValue(row.image_url),
    shopName: textValue(row.shop_name), buyerName: textValue(row.buyer_name),
    declaredCartonCount: numberValue(row.declared_carton_count), declaredUnitsPerCarton: numberValue(row.declared_units_per_carton),
    declaredTailQuantity: numberValue(row.declared_tail_quantity), initialCartonCount: numberValue(row.initial_carton_count),
    remainingCartonCount: numberValue(row.remaining_carton_count), reservedCartonCount: numberValue(row.reserved_carton_count),
    initialProductQuantity: numberValue(row.initial_product_quantity), remainingProductQuantity: numberValue(row.remaining_product_quantity),
    initialCbm: numberValue(row.initial_cbm), remainingCbm: numberValue(row.remaining_cbm), unitCbm: numberValue(row.unit_cbm),
    hasPackingVariance: Boolean(row.has_packing_variance), status, version: numberValue(row.version),
    createdAt: textValue(row.created_at), updatedAt: textValue(row.updated_at),
  };
}

function mapLoadingItem(row: Record<string, unknown>): HaichuanLoadingItem {
  return {
    id: textValue(row.id), batchId: textValue(row.batch_id), warehouseLotId: textValue(row.warehouse_lot_id),
    purchaseRecordId: textValue(row.purchase_record_id), internalCode: textValue(row.internal_code), sku: textValue(row.sku),
    productName: textValue(row.product_name), requestedCartonCount: numberValue(row.requested_carton_count),
    suggestedProductQuantity: numberValue(row.suggested_product_quantity), suggestedCbm: numberValue(row.suggested_cbm),
    isEstimated: Boolean(row.is_estimated),
    approvedCartonCount: row.approved_carton_count == null ? null : numberValue(row.approved_carton_count),
    approvedProductQuantity: row.approved_product_quantity == null ? null : numberValue(row.approved_product_quantity),
    approvedCbm: row.approved_cbm == null ? null : numberValue(row.approved_cbm),
    warehouseVersion: numberValue(row.warehouse_version), note: textValue(row.note),
    createdAt: textValue(row.created_at), updatedAt: textValue(row.updated_at),
  };
}

function mapLoadingBatch(row: Record<string, unknown>, items: HaichuanLoadingItem[]): HaichuanLoadingBatch {
  const rawStatus = textValue(row.status);
  const status: HaichuanLoadingBatch['status'] = rawStatus === 'submitted' || rawStatus === 'approved' || rawStatus === 'rejected'
    ? rawStatus
    : 'draft';
  return {
    id: textValue(row.id), containerDate: textValue(row.container_date), logisticsUserId: textValue(row.logistics_user_id),
    logisticsEmail: textValue(row.logistics_email), status, createdBy: textValue(row.created_by), createdAt: textValue(row.created_at),
    submittedAt: textValue(row.submitted_at), reviewedBy: textValue(row.reviewed_by), reviewedAt: textValue(row.reviewed_at),
    note: textValue(row.note), rejectionReason: textValue(row.rejection_reason), items,
  };
}

export async function fetchHaichuanData(): Promise<HaichuanData> {
  const db = client();
  const [inboundResult, lotsResult, batchesResult] = await Promise.all([
    db.from('haichuan_inbound_items').select('*').order('created_at', { ascending: false }),
    db.from('haichuan_warehouse_lots').select('*').order('created_at', { ascending: false }),
    db.from('haichuan_loading_batches').select('*').order('container_date', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  if (inboundResult.error) throw new Error(formatErrorMessage(inboundResult.error));
  if (lotsResult.error) throw new Error(formatErrorMessage(lotsResult.error));
  if (batchesResult.error) throw new Error(formatErrorMessage(batchesResult.error));

  const batchRows = (batchesResult.data ?? []) as Array<Record<string, unknown>>;
  const batchIds = batchRows.map((row) => textValue(row.id)).filter(Boolean);
  let itemRows: Array<Record<string, unknown>> = [];
  if (batchIds.length > 0) {
    const { data, error } = await db.from('haichuan_loading_items').select('*').in('batch_id', batchIds).order('created_at');
    if (error) throw new Error(formatErrorMessage(error));
    itemRows = (data ?? []) as Array<Record<string, unknown>>;
  }
  const itemsByBatch = new Map<string, HaichuanLoadingItem[]>();
  for (const row of itemRows) {
    const item = mapLoadingItem(row);
    itemsByBatch.set(item.batchId, [...(itemsByBatch.get(item.batchId) ?? []), item]);
  }
  return {
    inboundItems: ((inboundResult.data ?? []) as Array<Record<string, unknown>>).map(mapInbound),
    warehouseLots: ((lotsResult.data ?? []) as Array<Record<string, unknown>>).map(mapWarehouseLot),
    loadingBatches: batchRows.map((row) => mapLoadingBatch(row, itemsByBatch.get(textValue(row.id)) ?? [])),
  };
}

export async function createHaichuanInboundItems(records: PurchaseRecord[], logisticsProfile: AppProfile): Promise<void> {
  if (records.length === 0) return;
  const now = new Date().toISOString();
  const rows = records.map((record) => ({
    id: `hc-inbound-${record.id}`,
    purchase_record_id: record.id,
    logistics_user_id: logisticsProfile.id,
    logistics_email: logisticsProfile.email,
    internal_code: record.internalCode,
    manufacturer_name: record.manufacturerName,
    sku: record.sku,
    product_name: record.productName,
    english_name: record.englishName,
    image_url: record.imageUrl,
    shop_name: record.shopName,
    buyer_name: record.buyerName,
    purchase_total_quantity: haichuanPurchaseTotalQuantity(record),
    declared_carton_count: Math.max(0, Math.trunc(Number(record.cartonCount) || 0)),
    declared_units_per_carton: Math.max(0, Number(record.unitsPerCarton) || 0),
    declared_tail_quantity: Math.max(0, Number(record.tailQuantity) || 0),
    declared_total_carton_count: declaredTotalCartonCount(record),
    actual_received_carton_count: null,
    unit_cbm: Math.max(0, Number(record.unitCbm) || 0),
    declared_total_cbm: Math.max(0, Number(record.totalCbm) || 0),
    has_packing_variance: false,
    status: 'pending_receipt',
    created_at: now,
    updated_at: now,
  }));
  const { error } = await client().from('haichuan_inbound_items').upsert(rows, { onConflict: 'purchase_record_id', ignoreDuplicates: true });
  if (error) throw new Error(formatErrorMessage(error));
}

export async function deletePendingHaichuanInboundItems(purchaseRecordIds: string[]): Promise<void> {
  if (purchaseRecordIds.length === 0) return;
  const { error } = await client().from('haichuan_inbound_items')
    .delete()
    .in('purchase_record_id', purchaseRecordIds)
    .eq('status', 'pending_receipt');
  if (error) throw new Error(formatErrorMessage(error));
}

export async function confirmHaichuanReceipt(inboundId: string, actualCartonCount: number): Promise<void> {
  const { error } = await client().rpc('confirm_haichuan_receipt', {
    p_inbound_id: inboundId,
    p_actual_carton_count: actualCartonCount,
  });
  if (error) throw new Error(formatErrorMessage(error));
}

export async function submitHaichuanLoadingBatch(input: {
  id: string;
  containerDate: string;
  note: string;
  items: Array<{ warehouseLotId: string; requestedCartonCount: number; note?: string }>;
}): Promise<void> {
  const { error } = await client().rpc('submit_haichuan_loading_batch', {
    p_batch_id: input.id,
    p_container_date: input.containerDate,
    p_note: input.note,
    p_items: input.items,
  });
  if (error) throw new Error(formatErrorMessage(error));
}

export async function reviewHaichuanLoadingBatch(input: {
  batchId: string;
  containerDate: string;
  note: string;
  approve: boolean;
  rejectionReason?: string;
  items: Array<{
    id: string;
    approvedCartonCount: number;
    approvedProductQuantity: number;
    approvedCbm: number;
    note?: string;
  }>;
}): Promise<void> {
  const { error } = await client().rpc('review_haichuan_loading_batch', {
    p_batch_id: input.batchId,
    p_container_date: input.containerDate,
    p_note: input.note,
    p_items: input.items,
    p_approve: input.approve,
    p_rejection_reason: input.rejectionReason ?? '',
  });
  if (error) throw new Error(formatErrorMessage(error));
}
