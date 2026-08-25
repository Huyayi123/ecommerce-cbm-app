export const CANONICAL_SHOP_NAMES = ['Bestby', 'Arfast', 'Aicom', 'MegaValue', 'KeepFit', 'Lifon', 'PatPaw'];

const SHOP_ALIASES: Record<string, string> = {
  megavalues: 'MegaValue',
  mega_value: 'MegaValue',
  mega: 'MegaValue',
  aicom: 'Aicom',
  keepfit: 'KeepFit',
  patpaw: 'PatPaw',
};

export function canonicalShopName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\s+/g, '').toLowerCase();
  return SHOP_ALIASES[normalized] ?? CANONICAL_SHOP_NAMES.find((shop) => shop.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}
