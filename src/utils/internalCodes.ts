import type { SkuItem } from '../types';

const INTERNAL_CODE_LIMIT = 10000;

export function formatInternalCode(value: number): string {
  return String(value).padStart(5, '0');
}

function parseInternalCode(value: string): number {
  if (!/^\d{5}$/.test(value.trim())) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= INTERNAL_CODE_LIMIT ? parsed : 0;
}

function skuSortKey(item: SkuItem): string {
  return [
    item.internalCode || '',
    item.manufacturerName || '',
    item.sku || '',
    item.productName || '',
    item.englishName || '',
    item.id,
  ].join('|').toLowerCase();
}

export function ensureInternalCodes(items: SkuItem[]): SkuItem[] {
  const used = new Set<number>();
  for (const item of items) {
    const code = parseInternalCode(item.internalCode);
    if (code > 0) used.add(code);
  }

  let nextCode = 1;
  const nextAvailableCode = () => {
    while (used.has(nextCode) && nextCode <= INTERNAL_CODE_LIMIT) nextCode += 1;
    if (nextCode > INTERNAL_CODE_LIMIT) throw new Error('内部编号已超过 10000，请先清理重复 SKU 或扩展编号规则。');
    used.add(nextCode);
    return formatInternalCode(nextCode);
  };

  const assignedById = new Map<string, string>();
  for (const item of [...items].sort((left, right) => skuSortKey(left).localeCompare(skuSortKey(right), 'zh-Hans-CN', { numeric: true }))) {
    const existing = parseInternalCode(item.internalCode);
    assignedById.set(item.id, existing > 0 ? formatInternalCode(existing) : nextAvailableCode());
  }

  return items.map((item) => ({ ...item, internalCode: assignedById.get(item.id) ?? item.internalCode }));
}
