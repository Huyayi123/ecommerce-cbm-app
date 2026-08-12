import * as XLSX from 'xlsx-js-style';
import type { AdAnalysisRow, AuditLog, CalculationRow, MonthlyProfitDetail, MonthlyProfitReturnDetail, MonthlyProfitSaleDetail, MonthlyProfitSummary, ProfitAnalysisRow, PurchaseRecord, SkuItem } from '../types';
import { mixedGroupsSummary, packageCountFor, purchaseQuantityForRecordSku, withPurchaseTotals } from './purchaseRecords';

type ExportFormat = 'xlsx' | 'csv';

const SKU_TEMPLATE_HEADERS = [
  '厂家名',
  '内部编号',
  'SKU',
  'TSIN',
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

function isMyPurchaseOrdersExport(moduleName: string): boolean {
  return moduleName.trim() === '我的采购订单';
}

function cellRef(row: number, column: number): string {
  return XLSX.utils.encode_cell({ r: row - 1, c: column - 1 });
}

function setFormula(worksheet: XLSX.WorkSheet, row: number, column: number, formula: string, value: number | string = ''): void {
  worksheet[cellRef(row, column)] = { t: typeof value === 'number' ? 'n' : 's', f: formula, v: value };
}

function applyMyPurchaseOrderStyles(worksheet: XLSX.WorkSheet, rowCount: number): void {
  const thinBorder = { style: 'thin', color: { rgb: '000000' } };
  const border = { top: thinBorder, right: thinBorder, bottom: thinBorder, left: thinBorder };
  const center = { horizontal: 'center', vertical: 'center', wrapText: true };
  const left = { horizontal: 'left', vertical: 'center', wrapText: true };

  for (let row = 1; row <= rowCount; row += 1) {
    for (let col = 1; col <= 17; col += 1) {
      const address = cellRef(row, col);
      if (!worksheet[address]) worksheet[address] = { t: 's', v: '' };
      worksheet[address].s = {
        border: row === 1 ? undefined : border,
        alignment: col === 1 || col === 3 || col === 4 || col === 16 ? left : center,
        font: row === 1 ? { bold: true } : undefined,
        fill: row === 1 ? { patternType: 'solid', fgColor: { rgb: '92D050' } } : undefined,
      };
    }
  }

  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 16 },
    { wch: 34 },
    { wch: 42 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 30 },
    { wch: 12 },
  ];
}

function mixedWithText(names: string[]): string {
  const uniqueNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  return uniqueNames.length > 0 ? `混${uniqueNames.join('、')}` : '';
}

function exportMyPurchaseOrdersTemplate(records: PurchaseRecord[]): void {
  const headers = [
    '厂家名',
    'SKU',
    '产品名称',
    '英文名称',
    '店铺',
    '采购人',
    '实际采购数量',
    '采购单价',
    '运费',
    '混装总金额',
    '总CBM',
    '装货方式',
    '件数',
    '是否混装',
    '总重量kg',
    '备注',
    '混装总数',
  ];
  const rows: unknown[][] = [headers];
  const merges: XLSX.Range[] = [];
  const formulaSections: Array<{ start: number; end: number; totalCbm: number; totalWeightKg: number | null }> = [];

  for (const record of records.map(withPurchaseTotals)) {
    const startRow = rows.length + 1;
    const buyerName = record.assignedBuyerName || record.buyerName;
    const loadingType = record.loadingType || '整柜';
    const mixedLines = record.mixedGroups.flatMap((group) => group.lines.map((line) => ({ ...line, groupName: group.groupName, cartonCount: group.cartonCount })));
    const isMixed = mixedLines.length > 0;
    const baseQuantity = purchaseQuantityForRecordSku(record);
    const mixedProductNames = mixedLines.map((line) => line.productName || line.sku);

    rows.push([
      record.manufacturerName,
      record.sku,
      record.productName,
      record.englishName,
      record.shopName,
      buyerName,
      baseQuantity,
      record.purchasePrice,
      record.freightCost,
      '',
      record.totalCbm,
      loadingType,
      isMixed ? packageCountFor(record) : packageCountFor(record) || '',
      isMixed ? '是' : '否',
      record.totalWeightKg ?? '',
      isMixed ? mixedWithText(mixedProductNames) : record.note,
      baseQuantity,
    ]);

    for (const line of mixedLines) {
      rows.push([
        '',
        line.sku,
        line.productName,
        '',
        record.shopName,
        buyerName,
        line.quantity,
        line.purchasePrice,
        '',
        '',
        '',
        loadingType,
        0,
        '是',
        '',
        mixedWithText([record.productName || record.sku]),
        '',
      ]);
    }

    const endRow = rows.length;
    formulaSections.push({ start: startRow, end: endRow, totalCbm: record.totalCbm, totalWeightKg: record.totalWeightKg });
    if (endRow > startRow) {
      for (const column of [1, 10, 11, 15, 17]) {
        merges.push({ s: { r: startRow - 1, c: column - 1 }, e: { r: endRow - 1, c: column - 1 } });
      }
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!merges'] = merges;
  for (const section of formulaSections) {
    const rowRefs = Array.from({ length: section.end - section.start + 1 }, (_, index) => section.start + index);
    const amountFormula = rowRefs.map((row) => `G${row}*H${row}`).join('+') + '+' + rowRefs.map((row) => `I${row}`).join('+');
    const quantityFormulaText = rowRefs.map((row) => `G${row}`).join('+');
    setFormula(worksheet, section.start, 10, amountFormula);
    setFormula(worksheet, section.start, 17, quantityFormulaText);
    worksheet[cellRef(section.start, 11)] = { t: 'n', v: section.totalCbm };
    if (section.totalWeightKg !== null) worksheet[cellRef(section.start, 15)] = { t: 'n', v: section.totalWeightKg };
  }
  applyMyPurchaseOrderStyles(worksheet, rows.length);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU导入模板');
  writeWorkbook(workbook, '我的采购订单', 'xlsx');
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
      内部编号: row.internalCode,
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
  'TSIN',
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
    item.tsin,
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
      const address = XLSX.utils.encode_cell({ r: index + 1, c: 5 });
      worksheet[address] = { t: 's', f: formula, v: '' };
    });
    worksheet['!cols'] = [
      { wch: 18 },
      { wch: 18 },
      { wch: 14 },
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
  if (format === 'xlsx' && isMyPurchaseOrdersExport(moduleName)) {
    exportMyPurchaseOrdersTemplate(records);
    return;
  }

  const includeBuyerEmail = moduleName !== '我的采购订单';
  const includePlanQuantity = moduleName === '我的采购订单';
  const hideMixedChildAmount = includePlanQuantity && !includeBuyerEmail;
  const exportRows = records.flatMap((record) => {
    const normalized = withPurchaseTotals(record);
    const baseRow = {
      批次: normalized.purchaseBatchName,
      批次日期: normalized.purchaseBatchDate,
      厂家名: normalized.manufacturerName,
      内部编号: normalized.internalCode,
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
      内部编号: normalized.internalCode,
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

function adAnalysisExportRow(row: AdAnalysisRow): Record<string, unknown> {
  return {
    '\u5e97\u94fa': row.shopName,
    TSIN: row.sku,
    'Product ID': row.productId,
    '\u4ea7\u54c1\u540d\u79f0': row.productName,
    '\u56fe\u7247\u94fe\u63a5': row.imageUrl,
    '\u5e7f\u544a\u82b1\u8d39': row.adSpend,
    '\u5e7f\u544a\u9500\u91cf': row.adSalesQuantity,
    ROAS: row.roas ?? '',
    '\u9500\u552e\u5355\u4ef7\u5170\u7279': row.salePrice,
    '\u91c7\u8d2d\u6210\u672c\u4eba\u6c11\u5e01': row.purchaseCostRmb,
    '\u91c7\u8d2d\u6210\u672c\u5170\u7279': row.purchaseCostZar,
    '\u5e73\u53f0\u7a0e\u8d39': row.platformFee,
    '\u5e73\u53f0\u7a0e\u8d39\u6765\u6e90': row.platformFeeSource === 'api' ? 'API' : row.platformFeeSource === 'fallback' ? '\u552e\u4ef740%' : '\u7f3a\u5931',
    '\u5355\u54c1CBM': row.unitCbm,
    '\u6d77\u8fd0\u8d39': row.seaFreightCost,
    '\u9001\u4ed3\u8d39': row.warehouseFee,
    '\u5355\u6b21\u5e7f\u544a\u6210\u672c': row.adCostPerSale,
    '\u5229\u6da6\u7387': row.profitRate ?? '',
    'TSIN\u6392\u540d': row.skuRank ?? '',
    '\u65b0\u54c1\u72b6\u6001': row.productAgeStatus,
    '\u5206\u7c7b\u6807\u7b7e': row.strategyName,
    '\u6267\u884c\u52a8\u4f5c': row.actionSuggestion,
    '\u63d0\u793a': row.messages.join('; '),
  };
}

function adAnalysisSheetName(value: string, usedNames: Set<string>): string {
  const fallback = '\u672a\u5206\u7c7b';
  const base = (value || fallback).replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31) || fallback;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const suffixText = ' ' + suffix;
    candidate = base.slice(0, 31 - suffixText.length) + suffixText;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

export function exportAdAnalysisRows(rows: AdAnalysisRow[], format: ExportFormat): void {
  const workbook = XLSX.utils.book_new();
  const allRows = rows.map(adAnalysisExportRow);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(allRows), '\u5168\u90e8');

  if (format === 'xlsx') {
    const allSheetName = '\u5168\u90e8';
    const usedNames = new Set([allSheetName]);
    const groups = new Map<string, AdAnalysisRow[]>();
    for (const row of rows) {
      const key = row.strategyName || '\u672a\u5206\u7c7b';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const [strategyName, groupRows] of groups) {
      const worksheet = XLSX.utils.json_to_sheet(groupRows.map(adAnalysisExportRow));
      XLSX.utils.book_append_sheet(workbook, worksheet, adAnalysisSheetName(strategyName, usedNames));
    }
  }

  writeWorkbook(workbook, '\u5e7f\u544a\u5206\u6790\u7ed3\u679c', format);
}

export function exportProfitAnalysisRows(rows: ProfitAnalysisRow[], shopName: string): void {
  const statusLabels: Record<ProfitAnalysisRow['status'], string> = {
    profit: '盈利',
    loss: '亏损',
    break_even: '持平',
    missing_data: '无法计算',
  };
  const exportRows = rows.map((row) => ({
    店铺: row.shopName,
    SKU: row.sku,
    产品名称: row.productName,
    图片链接: row.imageUrl,
    最近成交时间: row.latestOrderDate,
    实际成交价: row.sellingPrice ?? '',
    '采购价 RMB': row.purchaseCostRmb ?? '',
    '采购成本 ZAR': row.purchaseCostZar ?? '',
    '单品 CBM': row.unitCbm ?? '',
    海运费: row.seaFreightCost ?? '',
    国内运费: row.domesticFreightCost ?? '',
    送仓费: row.warehouseFee ?? '',
    'Total Fees': row.totalFees ?? '',
    单件利润: row.profit ?? '',
    状态: statusLabels[row.status],
    提示: row.messages.join('；'),
    同步时间: row.syncedAt,
  }));
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const thin = { style: 'thin', color: { rgb: 'D1D5DB' } };
  const border = { top: thin, right: thin, bottom: thin, left: thin };
  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1:A1');
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address];
      if (!cell) continue;
      const status = rows[row - 1]?.status;
      cell.s = {
        border,
        alignment: { vertical: 'center', wrapText: true },
        font: row === 0 ? { bold: true, color: { rgb: 'FFFFFF' } } : undefined,
        fill: row === 0
          ? { patternType: 'solid', fgColor: { rgb: '167D70' } }
          : status === 'loss'
            ? { patternType: 'solid', fgColor: { rgb: 'FFF7ED' } }
            : status === 'missing_data'
              ? { patternType: 'solid', fgColor: { rgb: 'FFF1F2' } }
              : undefined,
      };
    }
  }
  worksheet['!cols'] = [12, 18, 48, 42, 22, 14, 14, 16, 14, 12, 12, 12, 14, 14, 12, 42, 22].map((wch) => ({ wch }));
  worksheet['!autofilter'] = { ref: worksheet['!ref'] ?? 'A1:Q1' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '利润分析');
  writeWorkbook(workbook, `${shopName || '全部店铺'}_利润分析`, 'xlsx');
}

export function exportMonthlyProfit(summary: MonthlyProfitSummary, details: MonthlyProfitDetail[], salesDetails: MonthlyProfitSaleDetail[] = [], returnDetails: MonthlyProfitReturnDetail[] = []): void {
  const workbook = XLSX.utils.book_new();
  const summaryRows = [{
    店铺: summary.shopName, 统计开始日期: summary.dateFrom, 统计结束日期: summary.dateTo,
    销售额: summary.salesRevenue, 销售数量: summary.salesQuantity, 销售利润: summary.salesProfit,
    退货数量: summary.returnQuantity, 退货基础损失: summary.returnProfitReversal, 退货额外损失: summary.returnNetFees,
    广告费用: summary.advertisingCost, 人员工资: summary.salaryCost, 最终利润: summary.finalProfit,
    缺失销售数量: summary.missingSalesQuantity, 缺失销售金额: summary.missingSalesRevenue,
    缺失退货数量: summary.missingReturnQuantity, 完整性: summary.status === 'complete' ? '完整' : '不完整',
    备注: summary.note, 更新人: summary.createdBy, 更新时间: summary.updatedAt,
  }];
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  summarySheet['!cols'] = Object.keys(summaryRows[0]).map((key) => ({ wch: Math.max(12, key.length + 4) }));
  XLSX.utils.book_append_sheet(workbook, summarySheet, '月度汇总');
  if (details.length) {
    const detailRows = details.map((row) => ({
      SKU: row.sku, 产品名称: row.productName, 销售数量: row.salesQuantity, 退货数量: row.returnQuantity,
      销售额: row.salesRevenue, 销售利润: row.salesProfit, 退货基础损失: row.returnProfitReversal,
      退货额外损失: row.returnNetFees, 净利润: row.netProfit, 异常原因: row.messages.join('；'),
    }));
    const detailSheet = XLSX.utils.json_to_sheet(detailRows);
    detailSheet['!cols'] = [{ wch: 18 }, { wch: 48 }, ...Array(7).fill({ wch: 15 }), { wch: 36 }];
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'SKU明细');
  }
  if (salesDetails.length) {
    const saleRows = salesDetails.map((row) => ({
      订单号: row.orderId, SKU: row.sku, 成交时间: row.orderDate, 'Sale Status': row.saleStatus,
      实际成交价: row.sellingPrice, 数量: row.quantity, '采购价 RMB': row.purchaseCostRmb ?? '',
      '采购成本 ZAR': row.purchaseCostZar ?? '', '单品 CBM': row.unitCbm ?? '', 海运费: row.seaFreightCost ?? '',
      国内运费: row.domesticFreightCost ?? '', 送仓费: row.warehouseFee ?? '', 'Total Fees': row.totalFees ?? '',
      该笔利润: row.profit ?? '', 异常原因: row.messages.join('；'),
    }));
    const saleSheet = XLSX.utils.json_to_sheet(saleRows);
    saleSheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 24 }, ...Array(10).fill({ wch: 15 }), { wch: 36 }];
    XLSX.utils.book_append_sheet(workbook, saleSheet, '销售逐笔明细');
  }
  if (returnDetails.length) {
    const returnRows = returnDetails.map((row) => ({
      退货编号: row.returnId, 原订单号: row.orderId, SKU: row.sku, 产品名称: row.productName, 退货日期: row.returnDate,
      退货数量: row.quantity, '采购成本 ZAR': row.purchaseCostZar ?? '', 海运费: row.seaFreightCost ?? '',
      国内运费: row.domesticFreightCost ?? '', 送仓费: row.warehouseFee ?? '', '分摊 Total Fees': row.allocatedTotalFees ?? '',
      'Total Fees 来源订单号': row.totalFeesSourceOrderId, 退货基础损失: row.baseLoss ?? '', 退货额外损失: row.extraLoss, 异常原因: row.messages.join('；'),
    }));
    const returnSheet = XLSX.utils.json_to_sheet(returnRows);
    returnSheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 48 }, { wch: 16 }, ...Array(8).fill({ wch: 16 }), { wch: 36 }];
    XLSX.utils.book_append_sheet(workbook, returnSheet, '退货逐笔明细');
  }
  XLSX.writeFile(workbook, `${summary.shopName}-${summary.dateFrom}至${summary.dateTo}-月度利润.xlsx`);
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
    内部编号: record.internalCode,
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
