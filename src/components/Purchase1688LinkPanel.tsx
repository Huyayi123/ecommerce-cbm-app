import { useState } from 'react';
import '../alibaba-logistics.css';
import type { AlibabaLink } from '../utils/alibabaLogistics';
import { saveAlibabaOrderIds } from '../utils/alibabaLogistics';
import { alibabaAccountNames, parseAlibabaOrderIds, type AlibabaAccount } from '../utils/alibabaAccounts';

export function Purchase1688LinkPanel({ recordId, buyer, link, approvedAccount, disabled, onSaved }: {
  recordId: string; buyer: string; link?: AlibabaLink; approvedAccount?: AlibabaAccount; disabled: boolean; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const account = link?.account_code ?? approvedAccount;
  const mismatch = Boolean(link && approvedAccount && link.account_code !== approvedAccount);
  async function save() {
    setMessage('');
    try {
      const ids = parseAlibabaOrderIds(draft);
      if (!ids.length && !link?.order_ids.length) { setOpen(false); return; }
      if (!ids.length) throw new Error('这条记录已有1688单号，清除前请先核对，避免丢失物流记录。');
      if (ids.length > 3) throw new Error('每笔暂支持最多3个1688订单号。');
      setSaving(true);
      await saveAlibabaOrderIds(recordId, ids, link?.version ?? 0);
      setOpen(false);
      onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  }
  return <div className="alibaba-link-panel">
    <button type="button" disabled={disabled || saving} onClick={() => { setDraft(link?.order_ids.join('\n') ?? ''); setMessage(''); setOpen(!open); }}>1688单号{link ? `（${link.order_ids.length}）` : ''}</button>
    {open && <div className="alibaba-link-editor">
      <strong>1688采购订单号（选填） · {account ? alibabaAccountNames[account] : '订单物流权限待配置'}</strong>
      <small>采购人：{buyer || '未填写'}；账号以独立核准配置为准。</small>
      <textarea aria-label="1688采购订单号" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={saving} placeholder="每行一个订单号，也可用逗号分隔" />
      <small>未提交也可填写。线下采购可留空，不影响采购提交；填写后保存并查询物流，每笔暂支持最多3个单号。</small>
      {mismatch && <small className="alibaba-error">采购人账号与已有绑定不一致，请联系管理员；不会自动切换账号。</small>}
      <div><button type="button" disabled={saving || disabled || !account || mismatch} onClick={() => void save()}>{saving ? '保存中…' : draft.trim() ? '保存并查询物流' : '完成（不填写单号）'}</button><button type="button" disabled={saving} onClick={() => setOpen(false)}>关闭</button></div>
      {message && <small role="alert" className="alibaba-error">{message}</small>}
    </div>}
  </div>;
}
