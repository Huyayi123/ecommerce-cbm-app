export function recordsForSelectionAwareExport<T extends { id: string }>(
  allRecords: T[],
  filteredRecords: T[],
  selectedIds: Set<string>,
): T[] {
  const selectedRecords = allRecords.filter((record) => selectedIds.has(record.id));
  return selectedRecords.length > 0 ? selectedRecords : filteredRecords;
}
