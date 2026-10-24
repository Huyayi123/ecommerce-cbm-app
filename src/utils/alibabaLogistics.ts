import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { AppProfile } from '../types';
import type { AlibabaAccount } from './alibabaAccounts';
import { savedAlibabaRun } from './alibabaSyncProgress';

export const alibabaLogisticsEnabled = import.meta.env.VITE_ALIBABA_LOGISTICS_ENABLED === 'true';

export type AlibabaLink = {
  purchase_record_id: string;
  account_code: AlibabaAccount;
  order_ids: string[];
  version: number;
};

export type AlibabaSummary = {
  purchase_record_id: string;
  link_version: number;
  status: string;
  last_success_at: string | null;
  sync_error: string | null;
  detail: string | null;
  signed_at?: string | null;
  latest_trace_at?: string | null;
};

type AlibabaAccess = { purchase_record_id: string; user_id: string; account_code: AlibabaAccount };
type AlibabaMember = { user_id: string; logistics_role: string; enabled: boolean; buyer_name: string | null; account_code: AlibabaAccount | null };

export function useAlibabaLogistics(profile: AppProfile) {
  const [links, setLinks] = useState<Record<string, AlibabaLink>>({});
  const [summaries, setSummaries] = useState<Record<string, AlibabaSummary>>({});
  const [access, setAccess] = useState<Record<string, AlibabaAccess>>({});
  const [member, setMember] = useState<AlibabaMember | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const scope = `${profile.id}:${profile.role}:${profile.email}`;
  const [dataScope, setDataScope] = useState('');
  const [loading, setLoading] = useState(alibabaLogisticsEnabled);
  useEffect(() => {
    let active = true;
    if (!alibabaLogisticsEnabled || !supabase) { setLoading(false); return; }
    setLoading(true);
    const client = supabase;
    async function readAll(table: string) {
      const summaryTable = table === 'purchase_logistics_summaries';
      let withTimes = summaryTable;
      const columns: string = table === 'alibaba_purchase_links' ? 'purchase_record_id,account_code,order_ids,version,verification_status'
        : table === 'alibaba_purchase_access' ? 'purchase_record_id,user_id,account_code'
          : 'purchase_record_id,link_version,status,last_success_at,sync_error,detail';
      const rows: Array<AlibabaLink | AlibabaSummary | AlibabaAccess> = [];
      for (let offset = 0; ; offset += 500) {
        let result = await client.from(table).select(columns + (withTimes ? ',signed_at,latest_trace_at' : '')).order('purchase_record_id').range(offset, offset + 499);
        // Keep existing logistics usable while the incremental migration has
        // not yet been applied. Never fall back on permission/network failures.
        if (summaryTable && withTimes && result.error?.code === '42703') {
          withTimes = false;
          result = await client.from(table).select(columns).order('purchase_record_id').range(offset, offset + 499);
        }
        if (result.error) throw result.error;
        rows.push(...(result.data as unknown as Array<AlibabaLink | AlibabaSummary | AlibabaAccess>));
        if (result.data.length < 500) return rows;
      }
    }
    void Promise.all([
      readAll('alibaba_purchase_links'), readAll('purchase_logistics_summaries'), readAll('alibaba_purchase_access'),
      client.from('alibaba_logistics_users').select('user_id,logistics_role,enabled,buyer_name,account_code').eq('user_id', profile.id).maybeSingle(),
    ])
      .then(([linkRows, summaryRows, accessRows, memberResult]) => {
        if (!active) return;
        if (memberResult.error) throw memberResult.error;
        setLinks(Object.fromEntries(linkRows.map((row) => [row.purchase_record_id, row as AlibabaLink])));
        setSummaries(Object.fromEntries(summaryRows.map((row) => [row.purchase_record_id, row as AlibabaSummary])));
        setDataScope(scope);
        setAccess(Object.fromEntries(accessRows.map((row) => [row.purchase_record_id, row as AlibabaAccess])));
        setMember(memberResult.data as AlibabaMember | null);
        setError('');
      }).catch(() => { if (active) setError('1688物流服务暂不可用，原采购操作不受影响。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope, revision]);
  const sameScope = dataScope === scope;
  return {
    links: sameScope ? links : {}, summaries: sameScope ? summaries : {}, access: sameScope ? access : {},
    canRefreshAll: Boolean((import.meta.env.VITE_ALIBABA_BATCH_SYNC_ENABLED === 'true' || savedAlibabaRun(profile.id)) && sameScope && member?.enabled && ['owner','admin','buyer'].includes(member.logistics_role)),
    buyerAccount: sameScope ? member?.account_code ?? undefined : undefined,
    canEnterOwnOrder: (buyer: string, email: string) => Boolean(sameScope && member?.enabled && ['owner','admin','buyer'].includes(member.logistics_role) && member.buyer_name === buyer && member.account_code && email.trim().toLowerCase() === profile.email.trim().toLowerCase()),
    canEdit: (id: string) => Boolean(sameScope && member?.enabled && access[id]
      && (['owner','admin'].includes(member.logistics_role)
        || (member.logistics_role === 'buyer' && access[id].user_id === member.user_id))),
    error, loading, reload: () => setRevision((value) => value + 1),
  };
}

export async function saveAlibabaOrderIds(recordId: string, orderIds: string[], version: number, action: 'draft' | 'sync' = 'sync') {
  if (!alibabaLogisticsEnabled || !supabase) throw new Error('1688物流功能尚未启用。');
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('请重新登录。');
  let response: Response;
  try { response = await fetch('/api/alibaba-self', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify({ recordId, orderIds, expectedVersion: version, action }), signal: AbortSignal.timeout(65000),
  }); } catch {
    throw new Error('单号保存请求中断，结果尚未确认。请保留当前输入，恢复连接后核对，勿直接刷新页面。');
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch {
    throw new Error(response.status===404
      ? '单号保存接口暂不可用（404），请保留当前输入并反馈，暂勿刷新页面。'
      : '单号保存接口返回异常，结果尚未确认。请保留当前输入并反馈，暂勿刷新页面。');
  }
  if (!payload || typeof payload !== 'object') throw new Error('单号保存响应不完整，请保留当前输入并反馈。');
  const messages: Record<string,string> = {
    SELF_SERVICE_RPC_MISSING: '请先安装采购人自行填写单号的增量SQL。',
    SELF_SERVICE_DENIED: '该记录与当前登录采购人不一致，或已有不同人员绑定，请核对原采购人配置。',
    PURCHASE_NOT_SUBMITTED: '单号已保存；提交采购池后才读取物流。',
    LINK_CHANGED: '单号已被更新，请刷新后重试。', WAIT_BEFORE_RETRY: '请间隔15秒后重试。',
    ORDER_NOT_OWNED: '这笔1688订单不属于你已绑定的账号，请核对订单号。',
  };
  if (!response.ok || !payload.ok) throw new Error(messages[payload.error] ?? '单号保存或物流查询失败，原采购业务数据未修改。');
  if (!Number.isSafeInteger(payload.saved?.version)) throw new Error('单号保存结果未确认，请保留当前输入并核对。');
  return payload.saved;
}
