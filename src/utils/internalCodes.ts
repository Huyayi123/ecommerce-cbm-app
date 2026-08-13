import type { SkuItem } from '../types';

const INTERNAL_CODE_LIMIT = 10000;

export function formatInternalCode(value: number): string {
  return String(value).padStart(5, '0');
}

export function parseInternalCode(value: string): number {
  if (!/^\d{5}$/.test(value.trim())) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= INTERNAL_CODE_LIMIT ? parsed : 0;
}

export function assignNewInternalCodes(items: SkuItem[], remoteItems: SkuItem[]): SkuItem[] {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const used = new Set<number>();
  let maxCode = 0;
  for (const item of remoteItems) {
    const code = parseInternalCode(item.internalCode);
    if (code > 0) {
      used.add(code);
      maxCode = Math.max(maxCode, code);
    }
  }

  let nextCode = maxCode + 1;
  const allocate = () => {
    while (used.has(nextCode) && nextCode <= INTERNAL_CODE_LIMIT) nextCode += 1;
    if (nextCode > INTERNAL_CODE_LIMIT) throw new Error('内部编号已超过 10000，请先清理重复 SKU 或扩展编号规则。');
    used.add(nextCode);
    return formatInternalCode(nextCode++);
  };

  return items.map((item) => {
    const remote = remoteById.get(item.id);
    if (remote) return { ...item, internalCode: remote.internalCode };

    const importedCode = parseInternalCode(item.internalCode);
    if (importedCode > 0 && !used.has(importedCode)) {
      used.add(importedCode);
      return { ...item, internalCode: formatInternalCode(importedCode) };
    }
    return { ...item, internalCode: allocate() };
  });
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
  const reserved = new Set<number>();
  for (const item of items) {
    const code = parseInternalCode(item.internalCode);
    if (code > 0) reserved.add(code);
  }

  let nextCode = 1;
  const nextAvailableCode = () => {
    while (reserved.has(nextCode) && nextCode <= INTERNAL_CODE_LIMIT) nextCode += 1;
    if (nextCode > INTERNAL_CODE_LIMIT) throw new Error('内部编号已超过 10000，请先清理重复 SKU 或扩展编号规则。');
    reserved.add(nextCode);
    return formatInternalCode(nextCode);
  };

  const claimed = new Set<number>();
  const assignedById = new Map<string, string>();
  for (const item of [...items].sort((left, right) => skuSortKey(left).localeCompare(skuSortKey(right), 'zh-Hans-CN', { numeric: true }))) {
    const existing = parseInternalCode(item.internalCode);
    if (existing > 0 && !claimed.has(existing)) {
      claimed.add(existing);
      assignedById.set(item.id, formatInternalCode(existing));
    } else {
      assignedById.set(item.id, nextAvailableCode());
    }
  }

  return items.map((item) => ({ ...item, internalCode: assignedById.get(item.id) ?? item.internalCode }));
}
