import type { PurchaseRecord, PurchaseRecordImport } from '../types';

export const WRONG_IMPORT_WINDOW = {
  startIso: '2026-09-23T08:30:00.000Z',
  endIso: '2026-09-23T10:00:00.000Z',
  label: '2026-09-23 16:30—18:00（北京时间）',
} as const;

export type WrongImportCleanupPreview = {
  createdCandidates: PurchaseRecord[];
  updatedExistingCandidates: PurchaseRecord[];
  unmatchedImportedRows: number;
  importedRowCount: number;
};

function text(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function loadingType(record: Pick<PurchaseRecord, 'loadingType'>): string {
  return record.loadingType === '冠通' || record.loadingType === '海川' ? record.loadingType : '整柜';
}

function isMatchableSku(value: string): boolean {
  const normalized = text(value).toUpperCase();
  return Boolean(normalized) && normalized !== 'NEW';
}

export function wrongImportBusinessKey(record: PurchaseRecord): string {
  if (isMatchableSku(record.sku)) {
    return ['sku', text(record.shopName) || '*', text(record.sku).toUpperCase(), loadingType(record)].join('|');
  }
  return [
    'new', text(record.manufacturerName), text(record.productName), text(record.englishName),
    text(record.shopName), text(record.buyerName || record.assignedBuyerName), text(record.purchaseDate),
    loadingType(record),
  ].join('|');
}

function inWindow(value: string | undefined, start: number, end: number): boolean {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
}

export function previewWrongImportCleanup(
  records: PurchaseRecord[],
  imports: PurchaseRecordImport[],
): WrongImportCleanupPreview {
  const start = Date.parse(WRONG_IMPORT_WINDOW.startIso);
  const end = Date.parse(WRONG_IMPORT_WINDOW.endIso);
  const importedKeys = new Set(imports.map((entry) => wrongImportBusinessKey(entry.record)));
  const matchedKeys = new Set<string>();
  const createdCandidates: PurchaseRecord[] = [];
  const updatedExistingCandidates: PurchaseRecord[] = [];

  for (const record of records) {
    const key = wrongImportBusinessKey(record);
    if (!importedKeys.has(key)) continue;
    if (inWindow(record.createdAt, start, end)) {
      createdCandidates.push(record);
      matchedKeys.add(key);
    } else if (inWindow(record.updatedAt, start, end)) {
      updatedExistingCandidates.push(record);
      matchedKeys.add(key);
    }
  }

  return {
    createdCandidates,
    updatedExistingCandidates,
    importedRowCount: imports.length,
    unmatchedImportedRows: imports.filter((entry) => !matchedKeys.has(wrongImportBusinessKey(entry.record))).length,
  };
}

export function downloadWrongImportBackup(preview: WrongImportCleanupPreview): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    timeWindow: WRONG_IMPORT_WINDOW,
    createdCandidates: preview.createdCandidates,
    updatedExistingCandidates: preview.updatedExistingCandidates,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `错误采购导入清理备份_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
