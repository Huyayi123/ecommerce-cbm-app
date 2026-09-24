import { supabase } from '../lib/supabase';
import type {
  AppProfile,
  HaichuanData,
  HaichuanInboundItem,
  HaichuanLoadingBatch,
  HaichuanLoadingItem,
  HaichuanProductDetail,
  HaichuanWarehouseLot,
  PurchaseRecord,
  SkuItem,
} from '../types';
import { formatErrorMessage } from './errors';
import { declaredTotalCartonCount, haichuanProductDetails, haichuanPurchaseTotalQuantity } from './haichuan';

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

function productDetailsValue(value: unknown): HaichuanProductDetail[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      id: textValue(row.id) || `detail-${index}`,
      internalCode: textValue(row.internalCode ?? row.internal_code),
      sku: textValue(row.sku),
      productName: textValue(row.productName ?? row.product_name),
      englishName: textValue(row.englishName ?? row.english_name),
      quantity: numberValue(row.quantity),
      unitCbm: numberValue(row.unitCbm ?? row.unit_cbm),
      totalCbm: numberValue(row.totalCbm ?? row.total_cbm),
      isMixed: Boolean(row.isMixed ?? row.is_mixed),
      mixedGroupId: textValue(row.mixedGroupId ?? row.mixed_group_id),
      mixedGroupName: textValue(row.mixedGroupName ?? row.mixed_group_name),
      mixedGroupCartonCount: numberValue(row.mixedGroupCartonCount ?? row.mixed_group_carton_count),
    };
  });
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
    productDetails: productDetailsValue(row.product_details),
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
    productDetails: productDetailsValue(row.product_details),
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
    productDetails: productDetailsValue(row.product_details),
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

export async function createHaichuanInboundItems(records: PurchaseRecord[], logisticsProfile: AppProfile, skuItems: SkuItem[] = []): Promise<void> {
  if (records.length === 0) return;
  const now = new Date().toISOString();
  const rows = records.map((record) => {
    const productDetails = haichuanProductDetails(record, skuItems);
    const purchaseTotalQuantity = haichuanPurchaseTotalQuantity(record);
    return ({
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
    purchase_total_quantity: purchaseTotalQuantity,
    declared_carton_count: Math.max(0, Math.trunc(Number(record.cartonCount) || 0)),
    declared_units_per_carton: Math.max(0, Number(record.unitsPerCarton) || 0),
    declared_tail_quantity: Math.max(0, Number(record.tailQuantity) || 0),
    declared_total_carton_count: declaredTotalCartonCount(record),
    actual_received_carton_count: null,
    unit_cbm: purchaseTotalQuantity > 0 ? Math.max(0, Number(record.totalCbm) || 0) / purchaseTotalQuantity : 0,
    declared_total_cbm: Math.max(0, Number(record.totalCbm) || 0),
    product_details: productDetails,
    has_packing_variance: false,
    status: 'pending_receipt',
    created_at: now,
    updated_at: now,
    });
  });
  const { error } = await client().from('haichuan_inbound_items').upsert(rows, { onConflict: 'purchase_record_id', ignoreDuplicates: true });
  if (error) throw new Error(formatErrorMessage(error));
  const refreshResults = await Promise.all(rows.map((row) => client().from('haichuan_inbound_items').update({
    purchase_total_quantity: row.purchase_total_quantity,
    declared_total_cbm: row.declared_total_cbm,
    unit_cbm: row.unit_cbm,
    product_details: row.product_details,
    updated_at: now,
  }).eq('purchase_record_id', row.purchase_record_id).eq('status', 'pending_receipt')));
  const refreshError = refreshResults.find((result) => result.error)?.error;
  if (refreshError) throw new Error(formatErrorMessage(refreshError));
}

export async function deletePendingHaichuanInboundItems(purchaseRecordIds: string[]): Promise<void> {
  if (purchaseRecordIds.length === 0) return;
  for (let offset = 0; offset < purchaseRecordIds.length; offset += 100) {
    const { error } = await client().from('haichuan_inbound_items')
      .delete()
      .in('purchase_record_id', purchaseRecordIds.slice(offset, offset + 100))
      .eq('status', 'pending_receipt');
    if (error) throw new Error(formatErrorMessage(error));
  }
}

export async function confirmHaichuanReceipt(inboundId: string, actualCartonCount: number): Promise<void> {
  const { error } = await client().rpc('confirm_haichuan_receipt', {
    p_inbound_id: inboundId,
    p_actual_carton_count: actualCartonCount,
  });
  if (error) throw new Error(formatErrorMessage(error));
}

export async function updateHaichuanWarehouseQuantity(lotId: string, newTotal: number): Promise<void> {
  const { error } = await client().rpc('update_haichuan_warehouse_quantity', {
    p_lot_id: lotId,
    p_new_total: newTotal,
  });
  if (error) throw new Error(formatErrorMessage(error));
}

export async function deleteHaichuanWarehouseLot(lotId: string): Promise<void> {
  const { error } = await client().rpc('delete_haichuan_warehouse_lot', { p_lot_id: lotId });
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
