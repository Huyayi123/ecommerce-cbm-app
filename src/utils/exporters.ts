import * as XLSX from 'xlsx-js-style';
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

function skuKey(value: string): string {
  return value.trim().toUpperCase();
}

function skuLookup(items: SkuItem[]): Map<string, SkuItem> {
  const result = new Map<string, SkuItem>();
  for (const item of items) {
    const key = skuKey(item.sku);
    if (key) result.set(key, item);
  }
  return result;
}

function barcodeFor(sku: string): string {
  const trimmed = sku.trim();
  return trimmed && trimmed.toUpperCase() !== 'NEW' ? trimmed : 'New Product';
}

function quantityFormula(cartonCount: number | null, unitsPerCarton: number | null, tailQuantity: number): string {
  const cartons = cartonCount ?? 0;
  const units = unitsPerCarton ?? 0;
  const tail = tailQuantity ?? 0;
  if (cartons > 0 && units > 0) {
    const total = cartons * units + tail;
    return tail > 0 ? `${cartons}×${units}+1×${tail}=${total}PCS` : `${cartons}×${units}=${total}PCS`;
  }
  return tail > 0 ? `${tail}PCS` : '';
}

function excelFormulaText(value: string): string {
  return value.replace(/"/g, '""');
}

function imageFormulaFor(url: string): string {
  const trimmed = url.trim();
  return trimmed ? `IMAGE("${excelFormulaText(trimmed)}")` : '';
}

function applyInspectionStyles(worksheet: XLSX.WorkSheet, rowCount: number, colCount: number): void {
  const thinBorder = { style: 'thin', color: { rgb: '000000' } };
  const border = { top: thinBorder, right: thinBorder, bottom: thinBorder, left: thinBorder };
  const center = { horizontal: 'center', vertical: 'center', wrapText: true };
  const left = { horizontal: 'left', vertical: 'center', wrapText: true };

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      if (!worksheet[address]) worksheet[address] = { t: 's', v: '' };
      worksheet[address].s = {
        border,
        alignment: col === 1 ? left : center,
        font: row === 4 ? { bold: true } : undefined,
      };
    }
  }

  const titleCell = worksheet[XLSX.utils.encode_cell({ r: 0, c: 0 })];
  if (titleCell) {
    titleCell.s = {
      border,
      alignment: center,
      font: { bold: true, sz: 16, name: 'Times New Roman' },
    };
  }

  for (let col = 0; col < colCount; col += 1) {
    const header = worksheet[XLSX.utils.encode_cell({ r: 4, c: col })];
    if (header) {
      header.s = {
        border,
        alignment: center,
        font: { bold: true },
      };
    }
  }
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
  const headers = [
    '厂家名',
    'SKU',
    '产品名称',
    '英文名称',
    '图片预览',
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
  const rows = items.map((item) => [
    item.manufacturerName,
    item.sku,
    item.productName,
    item.englishName,
    format === 'xlsx' ? '' : imageFormulaFor(item.imageUrl),
    item.imageUrl,
    item.storageLocation,
    item.purchaseUrl,
    item.purchasePrice,
    item.unitCbm,
    item.totalCbm,
    item.totalQuantity,
    item.shopName,
    item.buyerName,
    item.isSeasonal ? '是' : '否',
    item.cartonLengthCm,
    item.cartonWidthCm,
    item.cartonHeightCm,
    item.unitsPerCarton,
    item.notes,
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  if (format === 'xlsx') {
    items.forEach((item, index) => {
      const formula = imageFormulaFor(item.imageUrl);
      if (!formula) return;
      const address = XLSX.utils.encode_cell({ r: index + 1, c: 4 });
      worksheet[address] = { t: 's', f: formula, v: '' };
    });
    worksheet['!cols'] = [
      { wch: 18 },
      { wch: 18 },
      { wch: 28 },
      { wch: 28 },
      { wch: 16 },
      { wch: 60 },
      { wch: 16 },
      { wch: 36 },
      { wch: 10 },
      { wch: 12 },
      { wch: 12 },
      { wch: 10 },
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
      { wch: 8 },
      { wch: 8 },
      { wch: 8 },
      { wch: 10 },
      { wch: 28 },
    ];
    worksheet['!rows'] = [{ hpt: 24 }, ...items.map((item) => ({ hpt: item.imageUrl.trim() ? 72 : 24 }))];
  }

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
  const hideMixedChildAmount = includePlanQuantity && !includeBuyerEmail;
  const exportRows = records.flatMap((record) => {
    const normalized = withPurchaseTotals(record);
    const baseRow = {
      批次: normalized.purchaseBatchName,
      批次日期: normalized.purchaseBatchDate,
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

    const mixedRows = normalized.mixedGroups.flatMap((group) => group.lines.map((line) => ({
      批次: normalized.purchaseBatchName,
      批次日期: normalized.purchaseBatchDate,
      厂家名: normalized.manufacturerName,
      SKU: line.sku,
      产品名称: line.productName,
      英文名称: '',
      图片链接: '',
      店铺: normalized.shopName,
      采购人: normalized.assignedBuyerName || normalized.buyerName,
      ...(includeBuyerEmail ? { 采购人邮箱: normalized.assignedBuyerEmail } : {}),
      ...(includePlanQuantity ? { 计划采购数量: '' } : {}),
      实际采购数量: line.quantity,
      整箱件数: '',
      每箱数量: '',
      尾箱数量: '',
      含本SKU混装采购数量: line.quantity,
      采购单价: line.purchasePrice,
      运费: '',
      含混装总金额: hideMixedChildAmount ? '' : line.totalAmount,
      单品CBM: line.unitCbm,
      采购日期: normalized.purchaseDate,
      状态: normalized.status,
      '含混装总 CBM': line.totalCbm,
      装货方式: normalized.loadingType,
      装柜日期: normalized.containerDate,
      件数: group.cartonCount || '',
      是否混装: '混装子行',
      混装组: `${group.groupName} ${group.cartonCount}件`,
      总重量kg: '',
      物流总CBM: '',
      备注: `与 ${normalized.sku || normalized.productName} 混装`,
    })));

    return [baseRow, ...mixedRows];
  });
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, moduleName);
  writeWorkbook(workbook, moduleName, format);
}

export function exportBatchPurchaseOrder(records: PurchaseRecord[], format: ExportFormat): void {
  const exportRows = [...records]
    .map(withPurchaseTotals)
    .filter((record) => record.isConfirmed && record.status !== 'cancelled' && (record.status !== 'pending' || record.poolStatus === 'submitted_to_pool'))
    .sort((left, right) => (
      left.purchaseBatchDate.localeCompare(right.purchaseBatchDate)
      || left.purchaseBatchName.localeCompare(right.purchaseBatchName, 'zh-Hans-CN')
      || left.manufacturerName.localeCompare(right.manufacturerName, 'zh-Hans-CN')
      || left.sku.localeCompare(right.sku, 'zh-Hans-CN')
    ));

  const worksheet = XLSX.utils.json_to_sheet(exportRows.map((record) => ({
    批次: record.purchaseBatchName || '未分配批次',
    装柜日期: record.purchaseBatchDate || record.containerDate,
    厂家名: record.manufacturerName,
    SKU: record.sku,
    产品名称: record.productName,
    英文名称: record.englishName,
    店铺: record.shopName,
    采购人: record.assignedBuyerName || record.buyerName,
    实际采购数量: record.confirmedPurchaseQuantity ?? '',
    采购单价: record.purchasePrice,
    运费: record.freightCost,
    总金额: record.totalAmount,
    整箱件数: record.cartonCount ?? '',
    每箱数量: record.unitsPerCarton ?? '',
    尾箱数量: record.tailQuantity,
    总件数: packageCountFor(record) || '',
    单品CBM: record.unitCbm,
    总CBM: record.totalCbm,
    装货方式: record.loadingType || '整柜',
    采购日期: record.purchaseDate,
    状态: record.status,
    备注: record.note,
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '批次订货表');
  const batchName = exportRows[0]?.purchaseBatchName || '未分配批次';
  writeWorkbook(workbook, `批次订货表_${batchName}`, format);
}

export function exportInspectionChecklist(records: PurchaseRecord[], format: ExportFormat, skuItems: SkuItem[] = []): void {
  const skuBySku = skuLookup(skuItems);
  const storageLocationFor = (sku: string) => skuBySku.get(skuKey(sku))?.storageLocation ?? '';
  const englishNameFor = (record: PurchaseRecord) => record.englishName || skuBySku.get(skuKey(record.sku))?.englishName || record.productName;
  const lineProductFor = (line: { sku: string; productName: string }) => skuBySku.get(skuKey(line.sku))?.englishName || line.productName;
  const todayText = new Date().toLocaleDateString('en-GB').replace(/\//g, '/');
  const rows: unknown[][] = [
    [`New Stock Inspection & Storage Report (${todayText})`, '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '☑  China Suppliers', '☐  SA Local Market', '', '☐  Return from TAL', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['SN', 'Product', 'Barcode', 'Quantity Purchased', '', 'Verified Quantity', 'Discrepancy with PO', 'Damage or Quality Issues', 'Confirmation Signature', 'Signature for Pospal & MySoh updated', 'Warehouse Allocatior', 'Signature for Storage in Bin'],
  ];
  const merges: XLSX.Range[] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } },
    { s: { r: 2, c: 3 }, e: { r: 2, c: 4 } },
    { s: { r: 2, c: 6 }, e: { r: 2, c: 7 } },
    { s: { r: 4, c: 3 }, e: { r: 4, c: 4 } },
  ];
  let serial = 1;

  for (const record of records) {
    const normalized = withPurchaseTotals(record);
    const baseQuantityText = quantityFormula(normalized.cartonCount, normalized.unitsPerCarton, normalized.tailQuantity);
    const hasBaseCartons = Boolean(baseQuantityText);
    if (hasBaseCartons || normalized.mixedGroups.length === 0) {
      rows.push([
        serial,
        englishNameFor(normalized),
        barcodeFor(normalized.sku),
        baseQuantityText || `${purchaseQuantityForRecordSku(normalized)}PCS`,
        '',
        '',
        '',
        '',
        '',
        '',
        storageLocationFor(normalized.sku),
        '',
      ]);
      serial += 1;
    }

    for (const group of normalized.mixedGroups) {
      const mixedStartRow = rows.length;
      const lines = group.lines.filter((line) => line.quantity > 0);
      for (const line of lines) {
        rows.push([
          serial,
          lineProductFor(line),
          barcodeFor(line.sku),
          `${line.quantity}PCS`,
          '',
          '',
          '',
          '',
          '',
          '',
          storageLocationFor(line.sku),
          '',
        ]);
        serial += 1;
      }
      if (lines.length > 0) {
        rows[mixedStartRow][4] = group.cartonCount || '';
        if (lines.length > 1) {
          merges.push({ s: { r: mixedStartRow, c: 4 }, e: { r: rows.length - 1, c: 4 } });
        }
      }
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!merges'] = merges;
  worksheet['!cols'] = [
    { wch: 5 },
    { wch: 48 },
    { wch: 18 },
    { wch: 18 },
    { wch: 6 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 18 },
    { wch: 24 },
    { wch: 18 },
    { wch: 28 },
  ];
  applyInspectionStyles(worksheet, rows.length, 12);
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
