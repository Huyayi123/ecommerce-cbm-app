import { supabase } from '../lib/supabase';
import type { AppProfile, AuditAction, AuditLog, PurchaseRecord, PurchaseRow, RepricingAlert, SalesSuggestionRow, SkuItem, UserRole } from '../types';
import { formatErrorMessage } from './errors';
import { findMatchingSkuItem, getSkuMatchKey } from './calculations';
import { normalizeMixedGroups, withPurchaseTotals } from './purchaseRecords';
import { frontendSkuToSupabase, supabaseSkuToFrontend, type SupabaseSkuRow } from './skuFieldMapping';

type PurchaseRecordRow = {
  id: string;
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
  note: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type ContainerRow = {
  id: string;
  row_number: number | null;
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

type LegacySkuRow = {
  id: string;
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
      manufacturerName: item.manufacturerName.trim() || baseItem?.manufacturerName || '',
      sku: item.sku.trim() || baseItem?.sku || '',
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
  return withPurchaseTotals({
    id: row.id,
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
    note: row.note ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  });
}

function dateOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPurchaseRecordRow(record: PurchaseRecord): PurchaseRecordRow {
  const normalized = withPurchaseTotals(record);
  return {
    id: normalized.id,
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
    note: normalized.note,
  };
}

function mapContainerRow(row: ContainerRow): PurchaseRow {
  return {
    rowId: row.id,
    rowNumber: Number(row.row_number ?? 0),
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
    sku: row.sku,
    product_name: row.productName,
    english_name: row.englishName,
    manufacturer_name: row.manufacturerName,
    purchase_quantity: row.purchaseQuantity,
    raw: { ...row.raw, shopName: row.shopName ?? row.raw.shopName ?? '', imageUrl: row.imageUrl ?? row.raw.imageUrl ?? '', manualTotalCbm: row.manualTotalCbm ?? null },
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
  const client = requireSupabase();
  const pageSize = 1000;
  const rows: SupabaseSkuRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('sku_items')
      .select('*')
      .order('manufacturer_name')
      .range(from, from + pageSize - 1);
    if (error) throwSupabaseError(error);
    rows.push(...((data ?? []) as SupabaseSkuRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows.map((row) => supabaseSkuToFrontend(row));
}

export async function replaceSkuItems(items: SkuItem[]): Promise<void> {
  const client = requireSupabase();
  const remote = await fetchSkuItems();
  const normalizedItems = mergeSkuItemsForSave(items, remote);
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

export async function fetchPurchaseRecords(): Promise<PurchaseRecord[]> {
  const { data, error } = await requireSupabase().from('purchase_records').select('*').order('purchase_date', { ascending: false });
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => mapPurchaseRecord(row as PurchaseRecordRow));
}

export async function replacePurchaseRecords(records: PurchaseRecord[]): Promise<void> {
  const client = requireSupabase();
  const remote = await fetchPurchaseRecords();
  const nextIds = new Set(records.map((record) => record.id));
  const deleteIds = remote.map((record) => record.id).filter((id) => !nextIds.has(id));

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
  if (deleteIds.length > 0) {
    const { error } = await client.from('purchase_records').delete().in('id', deleteIds);
    if (error) throwSupabaseError(error);
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'container_rows' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_suggestions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'repricing_alerts' }, onChange)
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
