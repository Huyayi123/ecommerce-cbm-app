export type AlibabaAccount = 'A' | 'B';

export const alibabaAccountNames: Record<AlibabaAccount, string> = {
  A: '辉尚666',
  B: 'tb58287621',
};

const buyers: Record<string, AlibabaAccount> = {
  '孙杰': 'A', '章瀚成': 'A', '李靖阳': 'A', '伍菊开': 'A', '梁潘': 'A', '黄柏钧': 'A',
  '胡雅怡': 'B', '彭志红': 'B',
};

export function alibabaAccountForBuyer(name: string): AlibabaAccount | null {
  return Object.hasOwn(buyers, name.trim()) ? buyers[name.trim()] : null;
}

export function parseAlibabaOrderIds(value: string): string[] {
  const ids = value.split(/[\s,，;；]+/u).filter(Boolean);
  if (ids.length > 30) throw new Error('每笔采购记录最多填写30个1688订单号。');
  if (ids.some((id) => !/^[1-9]\d{0,29}$/.test(id))) throw new Error('1688订单号必须是数字，请勿填写商品链接或快递单号。');
  return [...new Set(ids)];
}
