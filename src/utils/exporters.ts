import * as XLSX from 'xlsx';
import type { AuditLog, CalculationRow, PurchaseRecord, SkuItem } from '../types';

type ExportFormat = 'xlsx' | 'csv';

function dateStamp(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  return `${date}_${time}`;
}

function writeWorkbook(workbook: XLSX.WorkBook, moduleName: string, format: ExportFormat): void {
  XLSX.writeFile(workbook, `${moduleName}_${dateStamp()}.${format}`, { bookType: format });
}

export function exportResults(rows: CalculationRow[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    rows.map((row) => ({
      厂家名: row.manufacturerName,
      SKU: row.sku,
      产品名称: row.productName,
      店铺: row.shopName,
      采购人: row.buyerName,
      采购数量: row.purchaseQuantity ?? '',
      采购单价: row.purchasePrice ?? '',
      总金额: row.totalAmount ?? '',
      '单品 CBM': row.unitCbm ?? '',
      '总 CBM': row.totalCbm ?? '',
      异常提示: row.messages.length > 0 ? row.messages.join('; ') : '正常',
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '装柜计算结果');
  writeWorkbook(workbook, '装柜计算结果', format);
}

export function exportSkuItems(items: SkuItem[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    items.map((item) => ({
      厂家名: item.manufacturerName,
      SKU: item.sku,
      产品名称: item.productName,
      英文名称: item.englishName,
      采购单价: item.purchasePrice,
      单品CBM: item.unitCbm,
      总CBM: item.totalCbm,
      总数量: item.totalQuantity,
      店铺: item.shopName,
      采购人: item.buyerName,
      长cm: item.cartonLengthCm,
      宽cm: item.cartonWidthCm,
      高cm: item.cartonHeightCm,
      每箱数量: item.unitsPerCarton,
      备注: item.notes,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU体积资料库');
  writeWorkbook(workbook, 'SKU体积资料库', format);
}

export function exportPurchaseRecords(records: PurchaseRecord[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    records.map((record) => ({
      厂家名: record.manufacturerName,
      SKU: record.sku,
      产品名称: record.productName,
      店铺: record.shopName,
      采购人: record.buyerName,
      采购数量: record.purchaseQuantity,
      采购单价: record.purchasePrice,
      总金额: record.totalAmount,
      采购日期: record.purchaseDate,
      预计到货日期: record.estimatedArrivalDate,
      状态: record.status,
      '总 CBM': record.totalCbm,
      备注: record.note,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '采购在途库存');
  writeWorkbook(workbook, '采购在途库存', format);
}

export function exportAuditLogs(logs: AuditLog[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    logs.map((log) => ({
      操作时间: log.createdAt,
      操作人: log.actorEmail,
      角色: log.actorRole,
      操作: log.action,
      模块: log.entityType,
      对象ID: log.entityId,
      说明: log.summary,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '操作记录');
  writeWorkbook(workbook, '操作记录', format);
}
