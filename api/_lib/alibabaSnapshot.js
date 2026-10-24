import { AlibabaError, logisticsLabels } from './alibabaClient.js';
import { parseTraceTime } from './alibabaTrace.js';

// Only summaries of successful, complete sets of linked-order queries are accepted.
// We still lack proof of all-goods-shipped: never produce whole-purchase "signed".
export function createPurchaseSnapshot(results) {
  if (!Array.isArray(results) || !results.length) throw new AlibabaError('INVALID_INPUT', 400);
  const seen = new Map();
  for (const result of results) {
    if (typeof result.orderId !== 'string' || !Array.isArray(result.shipments)) throw new AlibabaError('UNEXPECTED_RESPONSE');
    for (const shipment of result.shipments) {
      const key = `${result.orderId}:${shipment.logisticsId}`;
      const previous = seen.get(key);
      const effectiveStatus = shipment.effectiveStatus ?? shipment.rawStatus;
      if (previous && (previous.rawStatus !== shipment.rawStatus || previous.effectiveStatus !== effectiveStatus)) throw new AlibabaError('CONFLICTING_SHIPMENTS');
      const signedAt = effectiveStatus === 'SIGN' && ['action_SIGN','explicit_signed_text'].includes(shipment.signedAtSource) ? parseTraceTime(shipment.signedAt) : null;
      const latestTraceAt = parseTraceTime(shipment.latestTraceAt);
      if (previous?.signedAt && signedAt && previous.signedAt !== signedAt) throw new AlibabaError('CONFLICTING_SHIPMENTS');
      seen.set(key, { orderId: result.orderId, logisticsId: shipment.logisticsId, rawStatus: shipment.rawStatus,
        effectiveStatus, statusSource: shipment.statusSource ?? 'detail_status',
        statusAt: parseTraceTime(shipment.statusAt), statusConflict: effectiveStatus !== shipment.rawStatus,
        signedAt: signedAt ?? previous?.signedAt ?? null,
        signedAtSource: signedAt ? shipment.signedAtSource ?? null : previous?.signedAtSource ?? null,
        latestTraceAt: [latestTraceAt, previous?.latestTraceAt].filter(Boolean).sort().at(-1) ?? null });
    }
  }
  const shipments = [...seen.values()];
  const count = shipments.length;
  const signed = shipments.filter((item) => item.effectiveStatus === 'SIGN').length;
  const unknown = shipments.filter((item) => !Object.hasOwn(logisticsLabels, item.effectiveStatus) && !['DELIVERING','BUYER_PICKUP'].includes(item.effectiveStatus)).length;
  const exceptions = shipments.filter((item) => ['CANCEL','NOGET','UNSIGN'].includes(item.effectiveStatus)).length;
  const codes = new Set(shipments.map((item) => item.effectiveStatus));
  let status = 'unknown';
  let detail = '暂无可判断的物流单；不能据此认定未发货';
  if (count) {
    if (signed === count) {
      status = 'returned_signed'; detail = `已返回物流单全部签收（${signed}/${count}）；整笔采购完整性待确认`;
    } else if (signed) {
      status = 'partial_signed'; detail = `部分签收（${signed}/${count}已返回物流单）`;
    } else if (codes.size === 1 && !unknown) {
      const code = shipments[0].effectiveStatus;
      status = { WAITACCEPT: 'unaccepted', CANCEL: 'logistics_cancelled', ACCEPT: 'accepted', TRANSPORT: 'in_transit', DELIVERING: 'in_transit', NOGET: 'pickup_failed', UNSIGN: 'sign_exception' }[code] ?? 'unknown';
      detail = `${code === 'DELIVERING' ? '派送中' : logisticsLabels[code]}（${count}物流单）`;
    } else { status = unknown ? 'unknown' : 'mixed'; detail = '物流单状态不一致，暂不推断整笔采购状态'; }
    if (unknown) detail += `；${unknown}条状态未识别`;
    if (exceptions) detail += `；${exceptions}条异常或撤销`;
  }
  const fulfillment=results.every(item=>item.fulfillment?.type===results[0].fulfillment?.type
    &&item.fulfillment?.source==='user_confirmed_pilot_and_api_no_logistics')?results[0].fulfillment:null;
  if(fulfillment?.type==='awaiting_shipment'&&count===0){status='awaiting_shipment';detail='待发货（尚无物流信息）';}
  if(fulfillment?.type==='buyer_pickup'){status='buyer_pickup';detail='买家自提（无快递轨迹，不代表已提货）';}
  const signedTimes = shipments.filter(item => item.effectiveStatus === 'SIGN').map(item => item.signedAt).filter(Boolean).sort();
  const signedAt = signed && (signed !== count || signedTimes.length === signed) ? signedTimes.at(-1) ?? null : null;
  const latestTraceAt = shipments.map(item => item.latestTraceAt).filter(Boolean).sort().at(-1) ?? null;
  return { status, detail, shipment_count: count, signed_count: signed, unknown_count: unknown,
    exception_count: exceptions, coverage_confirmed: false, mapping_version: 'buyer-logistics-status-v1',
    evidence: { ...(fulfillment?{fulfillment}:{}),status_rule: results.every(result => result.shipments.every(item => item.effectiveStatus !== undefined)) ? 'trace-priority-v1' : 'detail-status-v1', shipments, queried_order_ids: results.map((item) => item.orderId), signed_at: signedAt, latest_trace_at: latestTraceAt } };
}
