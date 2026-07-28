import type { PurchaseRecord, SkuItem } from '../types';

export function skuLookupKey(sku: string): string {
  return sku.trim().toUpperCase();
}

export function purchaseUrlForRecord(record: PurchaseRecord, skuBySku: Map<string, SkuItem>): string {
  if (!record.sku.trim()) return '';
  return skuBySku.get(skuLookupKey(record.sku))?.purchaseUrl.trim() ?? '';
}

export function openPurchaseUrl(url: string): void {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return;
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
}
