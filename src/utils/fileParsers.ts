import * as XLSX from 'xlsx';
import type { PurchaseRow, SkuItem } from '../types';
import { hydrateSku } from './calculations';
import { toNumber } from './number';

const SKU_HEADERS = ['sku', 'SKU', '货号', '产品编码', '商品编码'];
const QUANTITY_HEADERS = ['采购数量', '数量', 'qty', 'Qty', 'QTY', 'purchaseQuantity'];
const SALES_QUANTITY_HEADERS = ['月销量', '销售数量', '销量', '销售件数', 'monthlySales', 'salesQuantity'];
const PRICE_HEADERS = ['采购单价', '单价', '价格', '采购价格', 'price', 'purchasePrice'];
const PRODUCT_NAME_HEADERS = ['产品名称', '品名', '中文名', 'productName', 'name'];
const ENGLISH_NAME_HEADERS = ['英文名', '英文名称', 'englishName', 'English Name'];
const MANUFACTURER_HEADERS = ['厂家名', '厂家', '供应商', '工厂', 'manufacturerName', 'Manufacturer'];
const SHOP_HEADERS = ['店铺', '店铺名', '店铺名称', 'shopName', 'store'];
const BUYER_HEADERS = ['采购人', '买手', '负责人', 'buyerName', 'buyer'];
const LENGTH_HEADERS = ['单箱长 cm', '单箱长', '长 cm', '长', 'length', 'cartonLengthCm'];
const WIDTH_HEADERS = ['单箱宽 cm', '单箱宽', '宽 cm', '宽', 'width', 'cartonWidthCm'];
const HEIGHT_HEADERS = ['单箱高 cm', '单箱高', '高 cm', '高', 'height', 'cartonHeightCm'];
const UNITS_PER_CARTON_HEADERS = ['每箱数量', '装箱数', '箱规数量', 'unitsPerCarton', 'pcsPerCarton'];
const TOTAL_QUANTITY_HEADERS = ['总数量', '单个总数量', '总件数', 'totalQuantity', 'totalQty'];
const TOTAL_CBM_HEADERS = ['总立方', '总立方 CBM', '总体积 CBM', '总 CBM', 'totalCbm', 'totalCBM'];
const NOTE_HEADERS = ['备注', 'note', 'remark'];

function pickField(row: Record<string, unknown>, candidates: string[]): unknown {
  const entries = Object.entries(row);
  for (const candidate of candidates) {
    const match = entries.find(([key]) => key.trim().toLowerCase() === candidate.trim().toLowerCase());
    if (match) return match[1];
  }
  return undefined;
}

export async function parsePurchaseFile(file: File): Promise<PurchaseRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: false,
  });

  return rows.map((row, index) => {
    const skuValue = pickField(row, SKU_HEADERS);
    const qtyValue = pickField(row, QUANTITY_HEADERS);

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
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: false,
  });

  return rows.map((row, index) => {
    const skuValue = pickField(row, SKU_HEADERS);
    const salesValue = pickField(row, SALES_QUANTITY_HEADERS);

    return {
      rowId: `${Date.now()}-sales-${index}`,
      rowNumber: index + 2,
      sku: skuValue === undefined || skuValue === null ? '' : String(skuValue).trim(),
      purchaseQuantity: toNumber(salesValue),
      raw: row,
    };
  });
}

export async function parseSkuFile(file: File): Promise<SkuItem[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: false,
  });

  return rows
    .map((row, index) => {
      const skuValue = pickField(row, SKU_HEADERS);
      const sku = skuValue === undefined || skuValue === null ? '' : String(skuValue).trim();
      if (!sku) return null;

      return hydrateSku({
        id: `${Date.now()}-${index}`,
        sku,
        productName: String(pickField(row, PRODUCT_NAME_HEADERS) ?? '').trim(),
        englishName: String(pickField(row, ENGLISH_NAME_HEADERS) ?? '').trim(),
        manufacturerName: String(pickField(row, MANUFACTURER_HEADERS) ?? '').trim(),
        shopName: String(pickField(row, SHOP_HEADERS) ?? '').trim(),
        buyerName: String(pickField(row, BUYER_HEADERS) ?? '').trim(),
        purchasePrice: toNumber(pickField(row, PRICE_HEADERS)) ?? 0,
        cartonLengthCm: toNumber(pickField(row, LENGTH_HEADERS)) ?? 0,
        cartonWidthCm: toNumber(pickField(row, WIDTH_HEADERS)) ?? 0,
        cartonHeightCm: toNumber(pickField(row, HEIGHT_HEADERS)) ?? 0,
        unitsPerCarton: toNumber(pickField(row, UNITS_PER_CARTON_HEADERS)) ?? 0,
        totalQuantity: toNumber(pickField(row, TOTAL_QUANTITY_HEADERS)) ?? 0,
        totalCbm: toNumber(pickField(row, TOTAL_CBM_HEADERS)) ?? 0,
        note: String(pickField(row, NOTE_HEADERS) ?? '').trim(),
      });
    })
    .filter((item): item is SkuItem => item !== null);
}
