import { attachLogisticsTrace, diagnosticStatuses } from './alibabaTrace.js';
import { createHmac } from 'node:crypto';
import { noCourierResult } from './alibabaFulfillment.js';

export class AlibabaError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

// Only bounded shape/enumerated semantics leave diagnostics; never raw messages.
export function describeAlibabaResponse(payload) {
  const type=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value==='object'?'object':'scalar';
  const message=['errorMsg','errorMessage','error_message','message'].map(key=>typeof payload?.[key]==='string'?payload[key]:'').join(' ');
  const code=payload?.errorCode??payload?.error_code;
  return { success:payload?.success===true, successFieldType:type(payload?.success),
    resultType:type(payload?.result),traceType:type(payload?.logisticsTrace),
    resultCount:Array.isArray(payload?.result)?payload.result.length:null,
    traceCount:Array.isArray(payload?.logisticsTrace)?payload.logisticsTrace.length:null,
    errorCodePresent:code!==undefined&&code!==null,
    knownErrorCode:['order.nopermission.buyer','401'].includes(String(code))?String(code):null,
    awaitingShipmentMention:/未发货|待发货|尚未发出|not shipped|awaiting shipment/i.test(message),
    buyerPickupMention:/自提|自行提货|self.?pickup|buyer.?pickup/i.test(message),
    noLogisticsMention:/暂无物流|无物流|没有物流|物流.{0,10}不存在|no logistics|logistics.{0,15}not (?:found|exist)/i.test(message),
  };
}

export const logisticsLabels = Object.freeze({
  WAITACCEPT: '未受理', CANCEL: '物流单已撤销', ACCEPT: '已受理', TRANSPORT: '运输中',
  NOGET: '揽件失败', SIGN: '已签收', UNSIGN: '签收异常',
});

export function signAlibabaRequest(path, parameters, secret) {
  const pairs = Object.entries(parameters).filter(([key]) => key !== '_aop_signature')
    .map(([key, value]) => key + String(value)).sort();
  return createHmac('sha1', secret).update(path + pairs.join(''), 'utf8').digest('hex').toUpperCase();
}

export function parseDiagnosticInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !['A', 'B'].includes(body.account) || typeof body.orderId !== 'string'
    || !/^[1-9]\d{0,29}$/.test(body.orderId)) throw new AlibabaError('INVALID_INPUT', 400);
  return { account: body.account, orderId: body.orderId };
}

export function summarizeLogisticsPayload(payload, orderId) {
  if (!payload || payload.success !== true) {
    const code = payload?.errorCode ?? payload?.error_code;
    if (code === 'order.nopermission.buyer') throw new AlibabaError('ORDER_NOT_OWNED', 403);
    // Do not forward upstream messages: they can contain secrets or personal data.
    if (String(code) === '401') throw new AlibabaError('ALIBABA_AUTH_REJECTED', 502);
    throw new AlibabaError('ALIBABA_QUERY_FAILED', 502);
  }
  if (!Array.isArray(payload.result) || payload.result.length > 200) throw new AlibabaError('UNEXPECTED_RESPONSE');
  const unique = new Map();
  for (const row of payload.result) {
    if (!row || typeof row.logisticsId !== 'string' || !row.logisticsId
      || row.logisticsId.length > 100 || typeof row.status !== 'string' || row.status.length > 100) {
      throw new AlibabaError('UNEXPECTED_RESPONSE');
    }
    const previous = unique.get(row.logisticsId);
    if (previous && previous.rawStatus !== row.status) throw new AlibabaError('CONFLICTING_SHIPMENTS');
    unique.set(row.logisticsId, {
      logisticsId: row.logisticsId, rawStatus: row.status,
      label: Object.hasOwn(logisticsLabels, row.status) ? logisticsLabels[row.status] : '暂不可判断',
    });
  }
  const shipments = [...unique.values()];
  const signedCount = shipments.filter((row) => row.rawStatus === 'SIGN').length;
  const total = shipments.length;
  const summary = !total ? '暂无物流信息，不能据此认定未发货'
    : signedCount === total ? `已返回物流单全部签收（${signedCount}/${total}）；整笔采购完整性待确认`
      : signedCount ? `部分签收（${signedCount}/${total}已返回物流单）`
        : new Set(shipments.map((row) => row.rawStatus)).size === 1 ? shipments[0].label : '物流状态不一致';
  // Numeric orderId/tradeOrderId from the response are intentionally ignored.
  // The original string ID is the sole request identity. No raw sender/receiver/trace payload leaves this module.
  return { orderId, shipments, shipmentCount: total, signedCount, summary, coverageConfirmed: false };
}

async function requestAlibabaPayload({ account, orderId, deadline }, apiName, env, fetcher) {
  const appKey = env.ALIBABA_APP_KEY;
  const secret = env.ALIBABA_APP_SECRET;
  const token = env[`ALIBABA_ACCOUNT_${account}_ACCESS_TOKEN`];
  if (!appKey || !/^\d+$/.test(appKey) || !secret || !token) throw new AlibabaError('ALIBABA_CONFIG_MISSING', 503);
  const path = `param2/1/com.alibaba.logistics/${apiName}/${appKey}`;
  const params = { access_token: token, orderId, webSite: '1688', _aop_timestamp: String(Date.now()) };
  params._aop_signature = signAlibabaRequest(path, params, secret);
  const timeout = Math.min(12000, (deadline ?? Date.now() + 12000) - Date.now());
  if (timeout <= 0) throw new AlibabaError('ALIBABA_NETWORK_ERROR');
  let response;
  try {
    response = await fetcher(`https://gw.open.1688.com/openapi/${path}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
      body: new URLSearchParams(params), signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new AlibabaError('ALIBABA_NETWORK_ERROR'); }
  if (response.status === 429) throw new AlibabaError('ALIBABA_RATE_LIMIT', 429);
  if (response.status === 401 || response.status === 403) throw new AlibabaError('ALIBABA_AUTH_REJECTED');
  if (!response.ok) throw new AlibabaError('ALIBABA_UPSTREAM_ERROR');
  // Limit bytes before decoding/parsing. No response body is logged or stored.
  const reader = response.body?.getReader();
  if (!reader) throw new AlibabaError('UNEXPECTED_RESPONSE');
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 512 * 1024) { await reader.cancel(); throw new AlibabaError('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AlibabaError) throw error;
    throw new AlibabaError('UNEXPECTED_RESPONSE');
  } finally { reader.releaseLock(); }
}

export async function queryAlibabaLogistics({ account, orderId, deadline, batchTrace = false, fulfillmentContext = null }, env = process.env, fetcher = fetch) {
  const input = { account, orderId, deadline: deadline ?? Date.now() + 24000 };
  let details,result;
  try {
    details = await requestAlibabaPayload(input, 'alibaba.trade.getLogisticsInfos.buyerView', env, fetcher);
    result = summarizeLogisticsPayload(details, orderId);
  } catch(error) {
    const check=details!==undefined?describeAlibabaResponse(details):null;
    if(fulfillmentContext==='awaiting_shipment'&&error instanceof AlibabaError&&error.code==='ALIBABA_QUERY_FAILED'
      &&check?.awaitingShipmentMention&&check.noLogisticsMention&&check.knownErrorCode===null){
      return noCourierResult({orderId,shipments:[],shipmentCount:0,signedCount:0,coverageConfirmed:false},'awaiting_shipment');
    }
    if(error instanceof AlibabaError){error.phase='details';if(check)error.responseCheck=check;}throw error;
  }
  if (env.ALIBABA_TRACE_PILOT_ORDER_ID === orderId) {
    result.shipments = result.shipments.map(item => ({...item, detailStatusFields:
      diagnosticStatuses(details.result.find(row => row.logisticsId === item.logisticsId))}));
  }
  if (env.ALIBABA_TRACE_ENABLED !== 'true' || !result.shipments.length
    || (env.ALIBABA_TRACE_PILOT_ORDER_ID && env.ALIBABA_TRACE_PILOT_ORDER_ID !== orderId && !batchTrace)) return result;
  let trace;
  try {
    trace = await requestAlibabaPayload(input, 'alibaba.trade.getLogisticsTraceInfo.buyerView', env, fetcher);
    const check=describeAlibabaResponse(trace);
    if(fulfillmentContext==='buyer_pickup'&&check.success&&!check.errorCodePresent&&check.noLogisticsMention
      &&(['missing','null'].includes(check.traceType)||check.traceCount===0))return noCourierResult(result,'buyer_pickup');
    return attachLogisticsTrace(result, trace, Date.now(), env.ALIBABA_TRACE_PILOT_ORDER_ID === orderId, env.ALIBABA_TRACE_STATUS_ENABLED === 'true');
  } catch(error) {
    const failure=error instanceof AlibabaError ? error : new AlibabaError('ALIBABA_TRACE_UNAVAILABLE');
    failure.phase='trace';if(trace!==undefined)failure.responseCheck=describeAlibabaResponse(trace);throw failure;
  }
}
