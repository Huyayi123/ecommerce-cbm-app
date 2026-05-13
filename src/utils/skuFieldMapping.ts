import type { SkuItem } from '../types';
import { hydrateSku } from './calculations';
import { toNumber } from './number';

export const SKU_FIELD_ALIASES = {
  manufacturerName: ['厂家名', '厂家', '供应商', 'manufacturer_name'],
  sku: ['SKU', 'sku', '货号', '产品编码', '商品编码', '条码'],
  productName: ['产品名称', '品名', '中文名称', 'product_name'],
  englishName: ['英文名称', '英文名', 'English Name', 'english_name'],
  purchasePrice: ['采购单价', '单价', '成本价', 'purchase_price'],
  manualUnitCbm: ['单品CBM', '单品 CBM', 'unit_cbm', '单个体积'],
  totalCbm: ['总CBM', '总 CBM', 'total_cbm'],
  totalQuantity: ['总数量', '数量', 'total_quantity'],
  shopName: ['店铺', '店铺名', 'shop_name'],
  buyerName: ['采购人', '买手', 'buyer_name'],
  cartonLengthCm: ['长cm', '长 cm', '长', 'box_length_cm'],
  cartonWidthCm: ['宽cm', '宽 cm', '宽', 'box_width_cm'],
  cartonHeightCm: ['高cm', '高 cm', '高', 'box_height_cm'],
  unitsPerCarton: ['每箱数量', '装箱数', '箱规', 'units_per_carton'],
  notes: ['备注', 'remark', 'notes'],
} as const;

export type SkuFrontendField = keyof typeof SKU_FIELD_ALIASES;

export type SupabaseSkuRow = {
  id: string;
  manufacturer_name: string | null;
  sku: string | null;
  product_name: string | null;
  english_name: string | null;
  purchase_price: number | null;
  unit_cbm: number | null;
  total_cbm: number | null;
  total_quantity: number | null;
  shop_name: string | null;
  buyer_name: string | null;
  box_length_cm: number | null;
  box_width_cm: number | null;
  box_height_cm: number | null;
  units_per_carton: number | null;
  notes: string | null;
  cbm_source?: SkuItem['cbmSource'] | null;
  updated_at: string | null;
  carton_length_cm?: number | null;
  carton_width_cm?: number | null;
  carton_height_cm?: number | null;
  manual_unit_cbm?: number | null;
};

export function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase();
}

export function findSkuHeader(headers: string[], field: SkuFrontendField): string | undefined {
  const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  for (const alias of SKU_FIELD_ALIASES[field]) {
    const match = normalized.get(normalizeHeader(alias));
    if (match) return match;
  }
  return undefined;
}

export function pickSkuExcelField(row: Record<string, unknown>, headers: string[], field: SkuFrontendField): unknown {
  const header = findSkuHeader(headers, field);
  return header ? row[header] : undefined;
}

export function supabaseSkuToFrontend(row: SupabaseSkuRow): SkuItem {
  return hydrateSku({
    id: row.id,
    manufacturerName: row.manufacturer_name ?? '',
    sku: row.sku ?? '',
    productName: row.product_name ?? '',
    englishName: row.english_name ?? '',
    purchasePrice: Number(row.purchase_price ?? 0),
    manualUnitCbm: Number(row.unit_cbm ?? row.manual_unit_cbm ?? 0),
    totalCbm: Number(row.total_cbm ?? 0),
    totalQuantity: Number(row.total_quantity ?? 0),
    shopName: row.shop_name ?? '',
    buyerName: row.buyer_name ?? '',
    cartonLengthCm: Number(row.box_length_cm ?? row.carton_length_cm ?? 0),
    cartonWidthCm: Number(row.box_width_cm ?? row.carton_width_cm ?? 0),
    cartonHeightCm: Number(row.box_height_cm ?? row.carton_height_cm ?? 0),
    unitsPerCarton: Number(row.units_per_carton ?? 0),
    notes: row.notes ?? '',
    cbmSource: row.cbm_source ?? 'missing',
    updatedAt: row.updated_at ?? '',
  });
}

export function frontendSkuToSupabase(item: SkuItem): SupabaseSkuRow {
  return {
    id: item.id,
    manufacturer_name: item.manufacturerName,
    sku: item.sku.trim() || null,
    product_name: item.productName,
    english_name: item.englishName,
    purchase_price: item.purchasePrice,
    unit_cbm: item.unitCbm || item.manualUnitCbm,
    total_cbm: item.totalCbm,
    total_quantity: item.totalQuantity,
    shop_name: item.shopName,
    buyer_name: item.buyerName,
    box_length_cm: item.cartonLengthCm,
    box_width_cm: item.cartonWidthCm,
    box_height_cm: item.cartonHeightCm,
    units_per_carton: item.unitsPerCarton,
    notes: item.notes,
    updated_at: item.updatedAt || new Date().toISOString(),
  };
}

export function skuExcelRowToFrontend(row: Record<string, unknown>, headers: string[], id = crypto.randomUUID()): SkuItem {
  const manualUnitCbm = toNumber(pickSkuExcelField(row, headers, 'manualUnitCbm')) ?? 0;
  const totalCbm = toNumber(pickSkuExcelField(row, headers, 'totalCbm')) ?? 0;
  const totalQuantity = toNumber(pickSkuExcelField(row, headers, 'totalQuantity')) ?? 0;

  return hydrateSku({
    id,
    manufacturerName: String(pickSkuExcelField(row, headers, 'manufacturerName') ?? '').trim(),
    sku: String(pickSkuExcelField(row, headers, 'sku') ?? '').trim(),
    productName: String(pickSkuExcelField(row, headers, 'productName') ?? '').trim(),
    englishName: String(pickSkuExcelField(row, headers, 'englishName') ?? '').trim(),
    purchasePrice: toNumber(pickSkuExcelField(row, headers, 'purchasePrice')) ?? 0,
    manualUnitCbm,
    totalCbm,
    totalQuantity,
    shopName: String(pickSkuExcelField(row, headers, 'shopName') ?? '').trim(),
    buyerName: String(pickSkuExcelField(row, headers, 'buyerName') ?? '').trim(),
    cartonLengthCm: toNumber(pickSkuExcelField(row, headers, 'cartonLengthCm')) ?? 0,
    cartonWidthCm: toNumber(pickSkuExcelField(row, headers, 'cartonWidthCm')) ?? 0,
    cartonHeightCm: toNumber(pickSkuExcelField(row, headers, 'cartonHeightCm')) ?? 0,
    unitsPerCarton: toNumber(pickSkuExcelField(row, headers, 'unitsPerCarton')) ?? 0,
    notes: String(pickSkuExcelField(row, headers, 'notes') ?? '').trim(),
    cbmSource: 'missing',
    updatedAt: new Date().toISOString(),
  });
}
