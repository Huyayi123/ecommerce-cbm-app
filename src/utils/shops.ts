export const CANONICAL_SHOP_NAMES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

export function canonicalShopName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return CANONICAL_SHOP_NAMES.find((shop) => shop.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}
