import * as XLSX from 'xlsx';
import type { AppProfile, PurchaseRecord, PurchaseRow, PurchaseStatus, SkuImportPreview, SkuImportPreviewRow, SkuItem } from '../types';
import { findMatchingSkuItem } from './calculations';
import { toNumber } from './number';
import {
  findSkuHeader,
  normalizeHeader,
  pickSkuExcelField,
  SKU_FIELD_ALIASES,
  skuExcelRowToFrontend,
  type SkuFrontendField,
} from './skuFieldMapping';

const PURCHASE_QUANTITY_HEADERS = ['采购数量', '数量', 'qty', 'Qty', 'QTY', 'purchaseQuantity'];
const SALES_QUANTITY_HEADERS = ['月销量', '销售数量', '销量', '销售件数', 'monthlySales', 'salesQuantity'];
const PURCHASE_RECORD_HEADERS = {
  manufacturerName: ['厂家名', '厂家', '供应商', 'manufacturer_name'],
  sku: ['SKU', 'sku', '货号', '产品编码', '商品编码'],
  productName: ['产品名称', '品名', '中文名称', 'product_name'],
  englishName: ['英文名称', '英文名', 'English Name', 'english_name'],
  shopName: ['店铺', '店铺名', 'shop_name'],
  buyerName: ['采购人', '买手', 'assigned_buyer_name', 'buyer_name'],
  buyerEmail: ['采购人邮箱', '采购邮箱', 'assigned_buyer_email'],
  purchaseQuantity: ['采购数量', '数量', 'purchase_quantity'],
  confirmedPurchaseQuantity: ['实际采购数量', '确认采购数量', '实际数量', 'confirmed_purchase_quantity'],
  purchasePrice: ['采购单价', '单价', '成本价', 'purchase_price'],
  totalAmount: ['总金额', '金额', 'total_amount'],
  unitCbm: ['单品CBM', '单品 CBM', 'unit_cbm'],
  totalCbm: ['总CBM', '总 CBM', 'total_cbm'],
  purchaseDate: ['采购日期', '下单日期', 'purchase_date'],
  loadingType: ['装货方式', 'loading_type'],
  containerDate: ['装柜日期', 'container_date'],
  totalWeightKg: ['总重量kg', '总重量', '重量kg', 'total_weight_kg'],
  cartonCount: ['件数', '箱数', 'carton_count'],
  logisticsTotalCbm: ['物流总CBM', '物流商回传总CBM', '总CBM', '总 CBM', 'logistics_total_cbm'],
  status: ['状态', 'status'],
  note: ['备注', 'remark', 'notes', 'note'],
} as const;

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

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function scoreCsvText(text: string): number {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const headers = splitCsvLine(firstLine).map((header) => header.replace(/^\uFEFF/, '').trim());
  const aliasValues = Object.values(SKU_FIELD_ALIASES).flat().map(normalizeHeader);
  return headers.reduce((score, header) => score + (aliasValues.includes(normalizeHeader(header)) ? 1 : 0), 0);
}

function decodeCsv(buffer: ArrayBuffer): string {
  const candidates = [
    new TextDecoder('utf-8').decode(buffer),
    new TextDecoder('gb18030').decode(buffer),
  ];

  return candidates.sort((left, right) => scoreCsvText(right) - scoreCsvText(left))[0];
}

function fillMergedCells(worksheet: XLSX.WorkSheet): void {
  const merges = worksheet['!merges'];
  if (!merges || merges.length === 0) return;

  for (const merge of merges) {
    const sourceAddress = XLSX.utils.encode_cell(merge.s);
    const sourceCell = worksheet[sourceAddress];
    if (!sourceCell) continue;

    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      for (let col = merge.s.c; col <= merge.e.c; col += 1) {
        const targetAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const targetCell = worksheet[targetAddress];
        const isEmpty = !targetCell || targetCell.v === undefined || targetCell.v === null || String(targetCell.v).trim() === '';
        if (isEmpty) {
          worksheet[targetAddress] = { ...sourceCell };
        }
      }
    }
  }
}

function fillDownRows(rows: Record<string, unknown>[], headers: string[]): Record<string, unknown>[] {
  const fillFields: SkuFrontendField[] = ['manufacturerName', 'shopName', 'buyerName', 'notes'];
  const fillHeaders = fillFields
    .map((field) => findSkuHeader(headers, field))
    .filter((header): header is string => Boolean(header));
  const lastValues = new Map<string, unknown>();

  return rows.map((row) => {
    const nextRow = { ...row };
    for (const header of fillHeaders) {
      const value = nextRow[header];
      const isEmpty = value === undefined || value === null || String(value).trim() === '';
      if (isEmpty && lastValues.has(header)) {
        nextRow[header] = lastValues.get(header);
      } else if (!isEmpty) {
        lastValues.set(header, value);
      }
    }
    return nextRow;
  });
}

function readRows(buffer: ArrayBuffer, fileName: string): { headers: string[]; rows: Record<string, unknown>[] } {
  const isCsv = /\.csv$/i.test(fileName);
  const workbook = isCsv ? XLSX.read(decodeCsv(buffer), { type: 'string' }) : XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };

  const worksheet = workbook.Sheets[firstSheetName];
  if (!isCsv) fillMergedCells(worksheet);

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '', raw: false });
  const headerRow = matrix[0] ?? [];
  const headers = headerRow.map((value) => String(value).trim()).filter(Boolean);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: false,
  });

  return { headers, rows: fillDownRows(rows, headers) };
}

export async function parsePurchaseFile(file: File): Promise<PurchaseRow[]> {
  const { headers, rows } = readRows(await file.arrayBuffer(), file.name);

  return rows.map((row, index) => {
    const skuValue = pickSkuExcelField(row, headers, 'sku');
    const productNameValue = pickSkuExcelField(row, headers, 'productName');
    const englishNameValue = pickSkuExcelField(row, headers, 'englishName');
    const manufacturerNameValue = pickSkuExcelField(row, headers, 'manufacturerName');
    const qtyValue = pickField(row, headers, PURCHASE_QUANTITY_HEADERS);

    return {
      rowId: `${Date.now()}-${index}`,
      rowNumber: index + 2,
      sku: skuValue === undefined || skuValue === null ? '' : String(skuValue).trim(),
      productName: productNameValue === undefined || productNameValue === null ? '' : String(productNameValue).trim(),
      englishName: englishNameValue === undefined || englishNameValue === null ? '' : String(englishNameValue).trim(),
      manufacturerName: manufacturerNameValue === undefined || manufacturerNameValue === null ? '' : String(manufacturerNameValue).trim(),
      purchaseQuantity: toNumber(qtyValue),
      raw: row,
    };
  });
}

export async function parseSalesFile(file: File): Promise<PurchaseRow[]> {
  const { headers, rows } = readRows(await file.arrayBuffer(), file.name);

  return rows.map((row, index) => {
    const skuValue = pickSkuExcelField(row, headers, 'sku');
    const salesValue = pickField(row, headers, SALES_QUANTITY_HEADERS);

    return {
      rowId: `${Date.now()}-sales-${index}`,
      rowNumber: index + 2,
      sku: skuValue === undefined || skuValue === null ? '' : String(skuValue).trim(),
      productName: '',
      englishName: '',
      manufacturerName: '',
      purchaseQuantity: toNumber(salesValue),
      raw: row,
    };
  });
}

function parseStatus(value: unknown): PurchaseStatus {
  const text = String(value ?? '').trim();
  const statusMap: Record<string, PurchaseStatus> = {
    待采购: 'pending',
    已下单: 'in_transit',
    海运在途: 'in_transit',
    已到货: 'arrived',
    已取消: 'cancelled',
    pending: 'pending',
    ordered: 'in_transit',
    in_transit: 'in_transit',
    arrived: 'arrived',
    cancelled: 'cancelled',
  };
  return statusMap[text] ?? 'pending';
}

function nonEmptyText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function pickPurchaseRecordField(row: Record<string, unknown>, headers: string[], field: keyof typeof PURCHASE_RECORD_HEADERS): unknown {
  return pickField(row, headers, PURCHASE_RECORD_HEADERS[field]);
}

export async function parsePurchaseRecordsFile(file: File, profile: AppProfile): Promise<PurchaseRecord[]> {
  const { headers, rows } = readRows(await file.arrayBuffer(), file.name);

  return rows.flatMap((row, index) => {
    const sku = String(pickPurchaseRecordField(row, headers, 'sku') ?? '').trim();
    const productName = String(pickPurchaseRecordField(row, headers, 'productName') ?? '').trim();
    const englishName = String(pickPurchaseRecordField(row, headers, 'englishName') ?? '').trim();
    if (!sku && !productName && !englishName) return [];

    const purchaseQuantity = toNumber(pickPurchaseRecordField(row, headers, 'purchaseQuantity')) ?? 0;
    const confirmedPurchaseQuantity = toNumber(pickPurchaseRecordField(row, headers, 'confirmedPurchaseQuantity'));
    const purchasePrice = toNumber(pickPurchaseRecordField(row, headers, 'purchasePrice')) ?? 0;
    const unitCbm = toNumber(pickPurchaseRecordField(row, headers, 'unitCbm')) ?? 0;
    const importedTotalAmount = toNumber(pickPurchaseRecordField(row, headers, 'totalAmount'));
    const importedTotalCbm = toNumber(pickPurchaseRecordField(row, headers, 'totalCbm'));
    const logisticsTotalCbm = toNumber(pickPurchaseRecordField(row, headers, 'logisticsTotalCbm'));
    const effectiveQuantity = confirmedPurchaseQuantity ?? purchaseQuantity;
    const buyerName = String(pickPurchaseRecordField(row, headers, 'buyerName') ?? profile.buyerName).trim() || profile.buyerName;

    return [{
      id: crypto.randomUUID(),
      manufacturerName: String(pickPurchaseRecordField(row, headers, 'manufacturerName') ?? '').trim(),
      sku,
      productName,
      englishName,
      shopName: String(pickPurchaseRecordField(row, headers, 'shopName') ?? '').trim(),
      buyerName,
      assignedBuyerName: buyerName,
      assignedBuyerEmail: profile.email,
      isConfirmed: true,
      purchaseQuantity,
      confirmedPurchaseQuantity,
      purchasePrice,
      totalAmount: importedTotalAmount ?? Math.round(effectiveQuantity * purchasePrice * 100) / 100,
      purchaseDate: nonEmptyText(pickPurchaseRecordField(row, headers, 'purchaseDate'), new Date().toISOString().slice(0, 10)),
      estimatedArrivalDate: '',
      status: parseStatus(pickPurchaseRecordField(row, headers, 'status')),
      unitCbm,
      totalCbm: importedTotalCbm ?? Math.round(effectiveQuantity * unitCbm * 10000) / 10000,
      loadingType: (String(pickPurchaseRecordField(row, headers, 'loadingType') ?? '').trim() === '冠通' ? '冠通' : String(pickPurchaseRecordField(row, headers, 'loadingType') ?? '').trim() === '整柜' ? '整柜' : ''),
      containerDate: nonEmptyText(pickPurchaseRecordField(row, headers, 'containerDate')),
      totalWeightKg: toNumber(pickPurchaseRecordField(row, headers, 'totalWeightKg')),
      cartonCount: toNumber(pickPurchaseRecordField(row, headers, 'cartonCount')),
      logisticsTotalCbm,
      note: String(pickPurchaseRecordField(row, headers, 'note') ?? `导入行 ${index + 2}`).trim(),
    }];
  });
}

function recognizedFieldMap(headers: string[]): Map<SkuFrontendField, string> {
  const recognized = new Map<SkuFrontendField, string>();
  for (const field of Object.keys(SKU_FIELD_ALIASES) as SkuFrontendField[]) {
    const header = findSkuHeader(headers, field);
    if (header) recognized.set(field, header);
  }
  return recognized;
}

function parseSkuRow(row: Record<string, unknown>, headers: string[], rowNumber: number, existingItems: SkuItem[]): SkuImportPreviewRow {
  const sku = String(pickSkuExcelField(row, headers, 'sku') ?? '').trim();
  const productName = String(pickSkuExcelField(row, headers, 'productName') ?? '').trim();
  const englishName = String(pickSkuExcelField(row, headers, 'englishName') ?? '').trim();
  const errors: string[] = [];

  if (!sku && !productName && !englishName) errors.push('SKU、产品名称、英文名称至少填写一个');

  if (errors.length > 0) {
    return { rowNumber, item: null, action: 'fail', errors };
  }

  const item = skuExcelRowToFrontend(row, headers);

  return {
    rowNumber,
    item,
    action: findMatchingSkuItem(item, existingItems) ? 'update' : 'create',
    errors: [],
  };
}

export async function previewSkuFile(file: File, existingItems: SkuItem[]): Promise<SkuImportPreview> {
  const { headers, rows } = readRows(await file.arrayBuffer(), file.name);
  const recognized = recognizedFieldMap(headers);
  const recognizedHeaders = new Set(Array.from(recognized.values()));
  const missingRequiredFields = recognized.has('sku') || recognized.has('productName') || recognized.has('englishName')
    ? []
    : ['SKU/产品名称/英文名称'];

  return {
    fileName: file.name,
    headers,
    recognizedFields: Array.from(recognized.entries()).map(([field, header]) => ({ field, header })),
    unrecognizedHeaders: headers.filter((header) => !recognizedHeaders.has(header)),
    missingRequiredFields,
    rows: missingRequiredFields.length > 0
      ? []
      : rows.map((row, index) => parseSkuRow(row, headers, index + 2, existingItems)),
  };
}

export async function parseSkuFile(file: File, existingItems: SkuItem[] = []): Promise<SkuItem[]> {
  const preview = await previewSkuFile(file, existingItems);
  return preview.rows.flatMap((row) => (row.item ? [row.item] : []));
}
