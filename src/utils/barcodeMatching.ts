export type BarcodeSkuRecord = {
  sku: string;
  productDetails?: Array<{ sku: string }>;
};

export function normalizeBarcodeSku(value: string): string {
  return value.trim().toUpperCase();
}

export function matchesBarcodeSku(record: BarcodeSkuRecord, scannedSku: string): boolean {
  const normalized = normalizeBarcodeSku(scannedSku);
  if (!normalized) return false;
  if (normalizeBarcodeSku(record.sku) === normalized) return true;
  return record.productDetails?.some((detail) => normalizeBarcodeSku(detail.sku) === normalized) ?? false;
}

export function filterByBarcodeSku<T extends BarcodeSkuRecord>(records: T[], scannedSku: string): T[] {
  const normalized = normalizeBarcodeSku(scannedSku);
  return normalized ? records.filter((record) => matchesBarcodeSku(record, normalized)) : records;
}
