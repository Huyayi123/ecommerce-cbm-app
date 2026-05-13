import * as XLSX from 'xlsx';
import type { PurchaseRow, SkuImportPreview, SkuImportPreviewRow, SkuItem } from '../types';
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

function readRows(buffer: ArrayBuffer, fileName: string): { headers: string[]; rows: Record<string, unknown>[] } {
  const isCsv = /\.csv$/i.test(fileName);
  const workbook = isCsv ? XLSX.read(decodeCsv(buffer), { type: 'string' }) : XLSX.read(buffer, { type: 'array' });
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
