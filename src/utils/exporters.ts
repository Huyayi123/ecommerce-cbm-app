import * as XLSX from 'xlsx';
import type { AuditLog, CalculationRow, PurchaseRecord, SkuItem } from '../types';
import { mixedGroupsSummary, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from './purchaseRecords';

type ExportFormat = 'xlsx' | 'csv';

const SKU_TEMPLATE_HEADERS = [
  '厂家名',
  'SKU',
  '产品名称',
  '英文名称',
  '图片链接',
  '库位',
  '采购链接',
  '采购单价',
  '单品CBM',
  '总CBM',
  '总数量',
  '店铺',
  '采购人',
  '是否季节性产品',
  '长cm',
  '宽cm',
  '高cm',
  '每箱数量',
  '备注',
];

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

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

export function exportResults(rows: CalculationRow[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    rows.map((row) => ({
      厂家名: row.manufacturerName,
      SKU: row.sku,
      产品名称: row.productName,
      图片链接: row.imageUrl,
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
      图片链接: item.imageUrl,
      库位: item.storageLocation,
      采购链接: item.purchaseUrl,
      采购单价: item.purchasePrice,
      单品CBM: item.unitCbm,
      总CBM: item.totalCbm,
      总数量: item.totalQuantity,
      店铺: item.shopName,
      采购人: item.buyerName,
      是否季节性产品: item.isSeasonal ? '是' : '否',
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

export function exportSkuImportTemplate(): void {
  const worksheet = XLSX.utils.aoa_to_sheet([SKU_TEMPLATE_HEADERS]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU导入模板');
  writeWorkbook(workbook, 'SKU导入模板', 'xlsx');
}

export function exportPurchaseRecords(records: PurchaseRecord[], format: ExportFormat, moduleName = '采购在途库存'): void {
  const includeBuyerEmail = moduleName !== '我的采购订单';
  const includePlanQuantity = moduleName === '我的采购订单';
  const worksheet = XLSX.utils.json_to_sheet(
    records.map((record) => {
      const normalized = withPurchaseTotals(record);
      const row = {
        厂家名: normalized.manufacturerName,
        SKU: normalized.sku,
        产品名称: normalized.productName,
        英文名称: normalized.englishName,
        图片链接: normalized.imageUrl,
        店铺: normalized.shopName,
        采购人: normalized.assignedBuyerName || normalized.buyerName,
        ...(includeBuyerEmail ? { 采购人邮箱: normalized.assignedBuyerEmail } : {}),
        ...(includePlanQuantity ? { 计划采购数量: normalized.purchaseQuantity } : {}),
        实际采购数量: normalized.confirmedPurchaseQuantity ?? '',
        整箱件数: normalized.cartonCount ?? '',
        每箱数量: normalized.unitsPerCarton ?? '',
        尾箱数量: normalized.tailQuantity,
        含本SKU混装采购数量: purchaseQuantityForRecordSku(normalized),
        采购单价: normalized.purchasePrice,
        运费: normalized.freightCost,
        含混装总金额: normalized.totalAmount,
        单品CBM: normalized.unitCbm,
        采购日期: normalized.purchaseDate,
        状态: normalized.status,
        '含混装总 CBM': normalized.totalCbm,
        装货方式: normalized.loadingType,
        装柜日期: normalized.containerDate,
        件数: packageCountFor(normalized) || '',
        是否混装: normalized.isMixed ? '是' : '否',
        混装组: mixedGroupsSummary(normalized),
        总重量kg: normalized.totalWeightKg ?? '',
        物流总CBM: normalized.logisticsTotalCbm ?? '',
        备注: normalized.note,
      };
      return row;
    }),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, moduleName);
  writeWorkbook(workbook, moduleName, format);
}

export function exportInspectionChecklist(records: PurchaseRecord[], format: ExportFormat): void {
  const worksheet = XLSX.utils.json_to_sheet(
    records.flatMap((record) => {
      const normalized = withPurchaseTotals(record);
      const rows = [{
        SKU: normalized.sku,
        产品名称: normalized.productName,
        英文名称: normalized.englishName,
        店铺: normalized.shopName,
        采购数量: purchaseQuantityForRecordSku(normalized),
        件数: packageCountFor(normalized) || '',
        是否混装: normalized.isMixed ? '是' : '否',
        混装组: mixedGroupsSummary(normalized),
        总重量kg: logisticsValue(normalized, normalized.totalWeightKg),
        总CBM: logisticsValue(normalized, normalized.logisticsTotalCbm),
      }];
      return [
        ...rows,
        ...normalized.mixedGroups.flatMap((group) => group.lines.filter((line) => skuKey(line.sku) !== skuKey(normalized.sku)).map((line) => ({
          SKU: line.sku,
          产品名称: line.productName,
          英文名称: '',
          店铺: normalized.shopName,
          采购数量: line.quantity,
          件数: group.cartonCount,
          是否混装: '混装子行',
          混装组: group.groupName,
          总重量kg: '',
          总CBM: line.totalCbm,
        }))),
      ];
    }),
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
