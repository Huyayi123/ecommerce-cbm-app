import * as XLSX from 'xlsx';
import type { PurchaseRow, SkuImportPreview, SkuImportPreviewRow, SkuItem } from '../types';
import { hydrateSku } from './calculations';
import { toNumber } from './number';

const FIELD_ALIASES = {
  sku: ['SKU', 'sku', '货号', '产品编码', '商品编码', '条码'],
  productName: ['产品名称', '品名', '中文名称', 'product_name'],
  englishName: ['英文名称', 'English Name', 'english_name'],
  manufacturerName: ['厂家名', '厂家', '供应商', 'manufacturer_name'],
  shopName: ['店铺', '店铺名', 'shop_name'],
  buyerName: ['采购人', '买手', 'buyer_name'],
  purchasePrice: ['采购单价', '单价', '成本价', 'purchase_price'],
  manualUnitCbm: ['单品CBM', '单品 CBM', 'unit_cbm', '单个体积'],
  totalCbm: ['总CBM', '总 CBM', 'total_cbm'],
  totalQuantity: ['总数量', '数量', 'total_quantity'],
  cartonLengthCm: ['长cm', '长 cm', '长', 'box_length_cm'],
  cartonWidthCm: ['宽cm', '宽 cm', '宽', 'box_width_cm'],
  cartonHeightCm: ['高cm', '高 cm', '高', 'box_height_cm'],
  unitsPerCarton: ['每箱数量', '装箱数', '箱规', 'units_per_carton'],
} as const;

type SkuField = keyof typeof FIELD_ALIASES;

const PURCHASE_QUANTITY_HEADERS = ['采购数量', '数量', 'qty', 'Qty', 'QTY', 'purchaseQuantity'];
const SALES_QUANTITY_HEADERS = ['月销量', '销售数量', '销量', '销售件数', 'monthlySales', 'salesQuantity'];

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase();
}

function buildHeaderMap(headers: string[]): Map<string, string> {
  const headerMap = new Map<string, string>();
  for (const header of headers) {
    headerMap.set(normalizeHeader(header), header);
  }
  return headerMap;
}

function findHeader(headers: string[], aliases: readonly string[]): string | undefined {
  const headerMap = buildHeaderMap(headers);
  for (const alias of aliases) {
    const match = headerMap.get(normalizeHeader(alias));
    if (match) return match;
  }
  return undefined;
}

function pickField(row: Record<string, unknown>, headers: string[], aliases: readonly string[]): unknown {
  const header = findHeader(headers, aliases);
  return header ? row[header] : undefined;
}

function readRows(buffer: ArrayBuffer): { headers: string[]; rows: Record<string, unknown>[] } {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };

  const worksheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '', raw: false });
  const headerRow = matrix[0] ?? [];
  const headers = headerRow.map((value) => String(value).trim()).filter(Boolean);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: false,
  });

  return { headers, rows };
}

export async function parsePurchaseFile(file: File): Promise<PurchaseRow[]> {
  const { headers, rows } = readRows(await file.arrayBuffer());

  return rows.map((row, index) => {
    const skuValue = pickField(row, headers, FIELD_ALIASES.sku);
    const qtyValue = pickField(row, headers, PURCHASE_QUANTITY_HEADERS);

    return {
      rowId: `${Date.now()}-${index}`,
      rowNumber: index + 2,
      sku: skuValue === undefined || skuValue === null ? '' : String(skuValue).trim(),
      purchaseQuantity: toNumber(qtyValue),
      raw: row,
    };
  });
}

export async function parseSalesFile(file: File): Promise<PurchaseRow[]> {
  const { headers, rows } = readRows(await file.arrayBuffer());

  return rows.map((row, index) => {
    const skuValue = pickField(row, headers, FIELD_ALIASES.sku);
    const salesValue = pickField(row, headers, SALES_QUANTITY_HEADERS);

    return {
      rowId: `${Date.now()}-sales-${index}`,
      rowNumber: index + 2,
      sku: skuValue === undefined || skuValue === null ? '' : String(skuValue).trim(),
      purchaseQuantity: toNumber(salesValue),
      raw: row,
    };
  });
}

function recognizedFieldMap(headers: string[]): Map<SkuField, string> {
  const recognized = new Map<SkuField, string>();
  for (const field of Object.keys(FIELD_ALIASES) as SkuField[]) {
    const header = findHeader(headers, FIELD_ALIASES[field]);
    if (header) recognized.set(field, header);
  }
  return recognized;
}

function parseSkuRow(row: Record<string, unknown>, headers: string[], rowNumber: number, existingSkuKeys: Set<string>): SkuImportPreviewRow {
  const sku = String(pickField(row, headers, FIELD_ALIASES.sku) ?? '').trim();
  const errors: string[] = [];
  const manualUnitCbm = toNumber(pickField(row, headers, FIELD_ALIASES.manualUnitCbm)) ?? 0;
  const totalCbm = toNumber(pickField(row, headers, FIELD_ALIASES.totalCbm)) ?? 0;
  const totalQuantity = toNumber(pickField(row, headers, FIELD_ALIASES.totalQuantity)) ?? 0;
  const cartonLengthCm = toNumber(pickField(row, headers, FIELD_ALIASES.cartonLengthCm)) ?? 0;
  const cartonWidthCm = toNumber(pickField(row, headers, FIELD_ALIASES.cartonWidthCm)) ?? 0;
  const cartonHeightCm = toNumber(pickField(row, headers, FIELD_ALIASES.cartonHeightCm)) ?? 0;
  const unitsPerCarton = toNumber(pickField(row, headers, FIELD_ALIASES.unitsPerCarton)) ?? 0;

  if (!sku) errors.push('SKU 为空');
  if (manualUnitCbm <= 0 && !(totalCbm > 0 && totalQuantity > 0) && !(cartonLengthCm > 0 && cartonWidthCm > 0 && cartonHeightCm > 0 && unitsPerCarton > 0)) {
    errors.push('缺少单品CBM，且无法通过总CBM/总数量或箱规计算');
  }

  if (errors.length > 0) {
    return { rowNumber, item: null, action: 'fail', errors };
  }

  const item = hydrateSku({
    id: crypto.randomUUID(),
    sku,
    productName: String(pickField(row, headers, FIELD_ALIASES.productName) ?? '').trim(),
    englishName: String(pickField(row, headers, FIELD_ALIASES.englishName) ?? '').trim(),
    manufacturerName: String(pickField(row, headers, FIELD_ALIASES.manufacturerName) ?? '').trim(),
    shopName: String(pickField(row, headers, FIELD_ALIASES.shopName) ?? '').trim(),
    buyerName: String(pickField(row, headers, FIELD_ALIASES.buyerName) ?? '').trim(),
    purchasePrice: toNumber(pickField(row, headers, FIELD_ALIASES.purchasePrice)) ?? 0,
    manualUnitCbm,
    totalCbm,
    totalQuantity,
    cartonLengthCm,
    cartonWidthCm,
    cartonHeightCm,
    unitsPerCarton,
    cbmSource: 'missing',
    updatedAt: new Date().toISOString(),
  });

  return {
    rowNumber,
    item,
    action: existingSkuKeys.has(sku.toUpperCase()) ? 'update' : 'create',
    errors: [],
  };
}

export async function previewSkuFile(file: File, existingItems: SkuItem[]): Promise<SkuImportPreview> {
  const { headers, rows } = readRows(await file.arrayBuffer());
  const recognized = recognizedFieldMap(headers);
  const recognizedHeaders = new Set(Array.from(recognized.values()));
  const missingRequiredFields = recognized.has('sku') ? [] : ['SKU'];
  const existingSkuKeys = new Set(existingItems.map((item) => item.sku.trim().toUpperCase()));

  return {
    fileName: file.name,
    headers,
    recognizedFields: Array.from(recognized.entries()).map(([field, header]) => ({ field, header })),
    unrecognizedHeaders: headers.filter((header) => !recognizedHeaders.has(header)),
    missingRequiredFields,
    rows: missingRequiredFields.length > 0
      ? []
      : rows.map((row, index) => parseSkuRow(row, headers, index + 2, existingSkuKeys)),
  };
}

export async function parseSkuFile(file: File, existingItems: SkuItem[] = []): Promise<SkuItem[]> {
  const preview = await previewSkuFile(file, existingItems);
  return preview.rows.flatMap((row) => (row.item ? [row.item] : []));
}
