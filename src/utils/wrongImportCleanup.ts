import type { PurchaseRecord, PurchaseRecordImport } from '../types';

export const WRONG_IMPORT_WINDOW = {
  startIso: '2026-09-23T07:00:00.000Z',
  endIso: '2026-09-23T12:00:00.000Z',
  label: '2026-09-23 15:00–19:59（北京时间）',
} as const;

export type WrongImportCleanupPreview = {
  createdCandidates: PurchaseRecord[];
  updatedExistingCandidates: PurchaseRecord[];
  unmatchedImportedRows: number;
  importedRowCount: number;
  matchingRecordCount: number;
  matchingRecordsWithoutCreatedAt: number;
  earliestMatchingCreatedAt: string;
  latestMatchingCreatedAt: string;
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

function comparable(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  return text(value);
}

function matchesImportedFields(record: PurchaseRecord, imported: PurchaseRecordImport): boolean {
  if (wrongImportBusinessKey(record) !== wrongImportBusinessKey(imported.record)) return false;
  return imported.providedFields.every((field) => comparable(record[field]) === comparable(imported.record[field]));
}

export function previewWrongImportCleanup(
  records: PurchaseRecord[],
  imports: PurchaseRecordImport[],
): WrongImportCleanupPreview {
  const start = Date.parse(WRONG_IMPORT_WINDOW.startIso);
  const end = Date.parse(WRONG_IMPORT_WINDOW.endIso);
  const matchedImportIndexes = new Set<number>();
  const importsByKey = new Map<string, Array<{ entry: PurchaseRecordImport; index: number }>>();
  imports.forEach((entry, index) => {
    const key = wrongImportBusinessKey(entry.record);
    importsByKey.set(key, [...(importsByKey.get(key) ?? []), { entry, index }]);
  });
  const createdCandidates: PurchaseRecord[] = [];
  const updatedExistingCandidates: PurchaseRecord[] = [];
  const matchingRecords: PurchaseRecord[] = [];

  for (const record of records) {
    const matchingIndexes = (importsByKey.get(wrongImportBusinessKey(record)) ?? [])
      .flatMap(({ entry, index }) => matchesImportedFields(record, entry) ? [index] : []);
    if (matchingIndexes.length === 0) continue;
    matchingIndexes.forEach((index) => matchedImportIndexes.add(index));
    matchingRecords.push(record);
    const createdAt = Date.parse(record.createdAt ?? '');
    if (Number.isFinite(createdAt) && createdAt >= start && createdAt < end) createdCandidates.push(record);
  }

  const matchingCreatedTimes = matchingRecords
    .map((record) => record.createdAt ?? '')
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return {
    createdCandidates,
    updatedExistingCandidates,
    importedRowCount: imports.length,
    unmatchedImportedRows: imports.length - matchedImportIndexes.size,
    matchingRecordCount: matchingRecords.length,
    matchingRecordsWithoutCreatedAt: matchingRecords.length - matchingCreatedTimes.length,
    earliestMatchingCreatedAt: matchingCreatedTimes[0] ?? '',
    latestMatchingCreatedAt: matchingCreatedTimes.at(-1) ?? '',
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
