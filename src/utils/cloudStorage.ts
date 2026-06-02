import { supabase } from '../lib/supabase';
import type { AppProfile, AuditAction, AuditLog, PurchaseRecord, PurchaseRow, SalesSuggestionRow, SkuItem, UserRole } from '../types';
import { formatErrorMessage } from './errors';
import { getSkuMatchKey } from './calculations';
import { frontendSkuToSupabase, supabaseSkuToFrontend, type SupabaseSkuRow } from './skuFieldMapping';

type PurchaseRecordRow = {
  id: string;
  manufacturer_name: string | null;
  sku: string;
  product_name: string | null;
  image_url?: string | null;
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
  logistics_total_cbm?: number | null;
  note: string | null;
};

type LegacyPurchaseRecordRow = Omit<
  PurchaseRecordRow,
  | 'image_url'
  | 'is_confirmed'
  | 'confirmed_purchase_quantity'
  | 'loading_type'
  | 'container_date'
  | 'total_weight_kg'
  | 'carton_count'
  | 'logistics_total_cbm'
>;

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

function mergeSkuItemsForSave(items: SkuItem[], remote: SkuItem[]): SkuItem[] {
  const remoteByKey = new Map(remote.map((item) => [getSkuMatchKey(item) || item.id, item]));
  const merged = new Map<string, SkuItem>();

  for (const item of items) {
    const key = getSkuMatchKey(item) || item.id;
    const remoteItem = remoteByKey.get(key);
    merged.set(key, {
      ...item,
      id: remoteItem?.id ?? merged.get(key)?.id ?? item.id,
      updatedAt: item.updatedAt || new Date().toISOString(),
    });
  }

  return Array.from(merged.values());
}

function mapPurchaseRecord(row: PurchaseRecordRow): PurchaseRecord {
  const status = row.status === 'ordered' ? 'in_transit' : row.status;
  return {
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
    logisticsTotalCbm: row.logistics_total_cbm === null || row.logistics_total_cbm === undefined ? null : Number(row.logistics_total_cbm),
    note: row.note ?? '',
  };
}

function dateOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPurchaseRecordRow(record: PurchaseRecord): PurchaseRecordRow {
  return {
    id: record.id,
    manufacturer_name: record.manufacturerName,
    sku: record.sku,
    product_name: record.productName,
    image_url: record.imageUrl,
    shop_name: record.shopName,
    buyer_name: record.buyerName,
    assigned_buyer_name: record.assignedBuyerName,
    assigned_buyer_email: record.assignedBuyerEmail,
    is_confirmed: record.isConfirmed,
    purchase_quantity: record.purchaseQuantity,
    confirmed_purchase_quantity: record.confirmedPurchaseQuantity,
    purchase_price: record.purchasePrice,
    total_amount: record.totalAmount,
    purchase_date: dateOrNull(record.purchaseDate),
    estimated_arrival_date: dateOrNull(record.estimatedArrivalDate),
    status: record.status,
    english_name: record.englishName,
    unit_cbm: record.unitCbm,
    total_cbm: record.totalCbm,
    loading_type: record.loadingType || null,
    container_date: dateOrNull(record.containerDate),
    total_weight_kg: record.totalWeightKg,
    carton_count: record.cartonCount,
    logistics_total_cbm: record.logisticsTotalCbm,
    note: record.note,
  };
}

function toLegacyPurchaseRecordRow(record: PurchaseRecord): LegacyPurchaseRecordRow {
  return {
    id: record.id,
    manufacturer_name: record.manufacturerName,
    sku: record.sku,
    product_name: record.productName,
    shop_name: record.shopName,
    buyer_name: record.buyerName,
    assigned_buyer_name: record.assignedBuyerName,
    assigned_buyer_email: record.assignedBuyerEmail,
    purchase_quantity: record.confirmedPurchaseQuantity ?? record.purchaseQuantity,
    purchase_price: record.purchasePrice,
    total_amount: record.totalAmount,
    purchase_date: dateOrNull(record.purchaseDate),
    estimated_arrival_date: dateOrNull(record.estimatedArrivalDate),
    status: record.status,
    english_name: record.englishName,
    unit_cbm: record.unitCbm,
    total_cbm: record.totalCbm,
    note: record.note,
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
  const { data, error } = await requireSupabase().from('sku_items').select('*').order('manufacturer_name');
  if (error) throwSupabaseError(error);
  return (data ?? []).map((row) => supabaseSkuToFrontend(row as SupabaseSkuRow));
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
      if (!isMissingColumnError(error)) throw new Error(formatErrorMessage(error));
      const { error: legacyError } = await client.from('purchase_records').upsert(records.map(toLegacyPurchaseRecordRow));
      if (legacyError) throwSupabaseError(legacyError);
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_suggestions' }, onChange)
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
