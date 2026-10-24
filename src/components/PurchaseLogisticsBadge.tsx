import type { AlibabaLink, AlibabaSummary } from '../utils/alibabaLogistics';
import '../alibaba-logistics.css';
import { type AlibabaAccount } from '../utils/alibabaAccounts';

const labels: Record<string, string> = {
  awaiting_shipment: '待发货', shipped: '已发货', in_transit: '运输中', signed: '已签收',
  cancelled: '已取消', partial: '部分履约', unknown: '暂不可判断',
  unaccepted: '未受理', accepted: '已受理', logistics_cancelled: '物流单已撤销',
  pickup_failed: '揽件失败', sign_exception: '签收异常', mixed: '物流状态不一致',
  partial_signed: '部分签收', returned_signed: '已返回包裹全部签收', buyer_pickup:'买家自提',
};

const tones: Record<string, string> = {
  signed: 'signed', returned_signed: 'signed', shipped: 'transit', in_transit: 'transit',
  accepted: 'accepted', partial_signed: 'partial', partial: 'partial', mixed: 'partial',
  pickup_failed: 'error', sign_exception: 'error', logistics_cancelled: 'cancelled', cancelled: 'cancelled',
};
export function logisticsDisplayDetail(_status: string, detail: string | null): string | null {
  return detail;
}

export function formatLogisticsTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function PurchaseLogisticsBadge({ link, summary, unavailable, loading }: {
  buyer: string; link?: AlibabaLink; summary?: AlibabaSummary; approvedAccount?: AlibabaAccount; unavailable?: boolean; loading?: boolean;
}) {
  if (!link?.order_ids.length) return null;
  if (!link || summary?.link_version !== link.version) summary = undefined;
  const signedStatus = summary && ['signed','returned_signed','partial_signed'].includes(summary.status);
  const signedTime = signedStatus ? formatLogisticsTime(summary?.signed_at) : null;
  const pendingSigned = signedStatus && !signedTime;
  const partialCount = summary?.status === 'partial_signed' ? /（(\d{1,3}\/\d{1,3})/.exec(summary.detail ?? '')?.[1] : null;
  const label = loading && !summary ? '加载中' : unavailable && !summary ? '暂不可查询'
    : !summary ? '待验证 / 待同步' : pendingSigned ? '签收待轨迹核验'
      : summary.status === 'partial_signed' && partialCount ? `部分签收（${partialCount}）`
        : summary.status === 'in_transit' && summary.detail?.startsWith('派送中') ? '派送中' : labels[summary.status] ?? '暂不可判断';
  const traceTime = formatLogisticsTime(summary?.latest_trace_at);
  return <div className="alibaba-logistics-summary">
    <span className={`alibaba-status alibaba-status-${pendingSigned ? 'neutral' : tones[summary?.status ?? ''] ?? 'neutral'}`}>{label}</span>
    {summary?.status === 'returned_signed' && signedTime ? <small>仅统计已返回包裹，整单完整性未确认</small> : null}
    {summary?.status === 'buyer_pickup' ? <small>提货完成情况未确认</small> : null}
    {summary?.status === 'awaiting_shipment' ? <small>尚无物流信息</small> : null}
    {signedTime ? <small>{summary?.status === 'partial_signed' ? '最近签收时间' : '签收时间'} {signedTime}</small>
      : traceTime ? <small>最新轨迹时间 {traceTime}</small>
        : signedStatus ? <small>暂无明确签收事件时间</small> : null}
  </div>;
}
