import * as XLSX from 'xlsx';
import type { AuditLog, CalculationRow, PurchaseRecord, SkuItem } from '../types';
import { effectivePurchaseQuantity } from './purchaseRecords';

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

function logisticsValue(record: PurchaseRecord, value: number | null): number | string {
  if (record.loadingType !== '冠通') return '';
  return value ?? '待物流商回传';
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

export function exportPurchaseRecords(records: PurchaseRecord[], format: ExportFormat, moduleName = '采购在途库存'): void {
  const worksheet = XLSX.utils.json_to_sheet(
    records.map((record) => ({
      厂家名: record.manufacturerName,
      SKU: record.sku,
      产品名称: record.productName,
      英文名称: record.englishName,
      店铺: record.shopName,
      采购人: record.assignedBuyerName || record.buyerName,
      采购人邮箱: record.assignedBuyerEmail,
      计划采购数量: record.purchaseQuantity,
      实际采购数量: record.confirmedPurchaseQuantity ?? '',
      采购数量: effectivePurchaseQuantity(record),
      采购单价: record.purchasePrice,
      总金额: record.totalAmount,
      单品CBM: record.unitCbm,
      采购日期: record.purchaseDate,
      状态: record.status,
      '总 CBM': record.totalCbm,
      装货方式: record.loadingType,
      装柜日期: record.containerDate,
      件数: record.cartonCount ?? '',
      总重量kg: record.totalWeightKg ?? '',
      物流总CBM: record.logisticsTotalCbm ?? '',
      备注: record.note,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, moduleName);
  writeWorkbook(workbook, moduleName, format);
}

export function exportInspectionChecklist(records: PurchaseRecord[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    records.map((record) => ({
      SKU: record.sku,
      产品名称: record.productName,
      英文名称: record.englishName,
      店铺: record.shopName,
      采购数量: effectivePurchaseQuantity(record),
      件数: record.cartonCount ?? '',
      总重量kg: logisticsValue(record, record.totalWeightKg),
      总CBM: logisticsValue(record, record.logisticsTotalCbm),
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '验货单');
  writeWorkbook(workbook, '验货单', format);
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
