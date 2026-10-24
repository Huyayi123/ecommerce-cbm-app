// buyerView's timezone-less domestic logistics timestamps use China Standard Time.
// All retained times are normalized UTC; no remark/address/contact leaves here.
export function parseTraceTime(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const local = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  const iso = local ? `${local[1]}T${local[2]}+08:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+08:00)$/.test(iso)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + 300000) return null;
  const normalized = new Date(ms).toISOString();
  const roundTrip = new Date(ms + (iso.endsWith('+08:00') ? 28800000 : 0)).toISOString().slice(0, 19);
  if (roundTrip !== iso.slice(0, 19)) return null;
  return normalized;
}

// Bounded, allowlisted diagnostic values. Never return arbitrary upstream text.
const statusFields = ['status', 'logisticsStatus', 'traceStatus', 'action'];
const knownStatuses = new Set(['WAITACCEPT','CANCEL','ACCEPT','TRANSPORT','NOGET','SIGN','UNSIGN','SIGNED','DELIVERING','运输中','已签收','派送中']);
// Completed recipient event, observed without an "已" prefix. Clause boundaries
// exclude requests, future instructions and "签收后" advice.
const recipientSignaturePattern = /(?:^|[，,。；;\s])(?:您的)?(?:快件|包裹)(?:已)?由本人签收(?:[。！!，,；;\s]|$)/;
// Observed completed delivery restriction, not the bare word INVALID or
// warehouse inspection alone. Conditional clauses are excluded during parsing.
const deliveryRestrictionPattern = /导致投递受限/;
export function diagnosticStatuses(row) {
  return Object.fromEntries(statusFields.filter(key => Object.hasOwn(row, key)).map(key =>
    [key, knownStatuses.has(row[key]) ? row[key] : 'UNRECOGNIZED']));
}
export function diagnoseLogisticsCorrespondence(result, payload, now = Date.now()) {
  if (payload?.success !== true || !Array.isArray(payload.logisticsTrace) || payload.logisticsTrace.length > 200) throw Error('INVALID_TRACE_RESPONSE');
  let total = 0;
  const traces = payload.logisticsTrace.map(trace => {
    if (typeof trace?.logisticsId !== 'string' || !trace.logisticsId || trace.logisticsId.length > 100 || !Array.isArray(trace.logisticsSteps)) throw Error('INVALID_TRACE_RESPONSE');
    total += trace.logisticsSteps.length;
    if (total > 5000) throw Error('INVALID_TRACE_RESPONSE');
    return { logisticsId: trace.logisticsId, matched: result.shipments.some(item => item.logisticsId === trace.logisticsId),
      statuses: diagnosticStatuses(trace), stepCount: trace.logisticsSteps.length,
      latestSteps: trace.logisticsSteps.map(step => {
        if (!step || typeof step !== 'object') throw Error('INVALID_TRACE_RESPONSE');
        const text = typeof step.remark === 'string' ? step.remark : '';
        return { at: parseTraceTime(step.acceptTime ?? step.accept_time, now), statuses: diagnosticStatuses(step),
          signedText: /已签收|签收成功|送达\s*[【\[][^】\]\r\n]{1,60}[】\]]\s*签收/.test(text)||recipientSignaturePattern.test(text),
          transportText: /运输中|运输途中|转运中心|分拨中心|快件已到达|快件离开/.test(text),
          deliveringText: /正在派送|派送中|正在派件|派件中/.test(text),
          exceptionText: /拒签|拒收|签收失败|退回|退件/.test(text)||deliveryRestrictionPattern.test(text),
          conditionalText: /未签收|待签收|预计|如果|如已签收|可能已签收/.test(text) };
      }).sort((a,b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0,8) };
  });
  return { version: 'logistics-correspondence-v1', orderId: result.orderId,
    shipments: result.shipments.map(item => ({ logisticsId: item.logisticsId, rawStatus: knownStatuses.has(item.rawStatus) ? item.rawStatus : 'UNRECOGNIZED',
      detailStatusFields: item.detailStatusFields ?? {},
      traceCount: traces.filter(trace => trace.logisticsId === item.logisticsId).length })), traces };
}

export function attachLogisticsTrace(result, payload, now = Date.now(), diagnose = false, prioritizeTrace = false) {
  if (payload?.success !== true || !Array.isArray(payload.logisticsTrace) || payload.logisticsTrace.length > 200) {
    throw Error('INVALID_TRACE_RESPONSE');
  }
  const times = new Map();
  const checks = [];
  let totalSteps = 0;
  for (const trace of payload.logisticsTrace) {
    if (typeof trace?.logisticsId !== 'string' || !trace.logisticsId || !Array.isArray(trace.logisticsSteps)) throw Error('INVALID_TRACE_RESPONSE');
    totalSteps += trace.logisticsSteps.length;
    if (totalSteps > 5000) throw Error('INVALID_TRACE_RESPONSE');
    if (!result.shipments.some(item => item.logisticsId === trace.logisticsId)) continue;
    const time = times.get(trace.logisticsId) ?? { signedAt: null, latestTraceAt: null, signedAtSource: null, statusAt: null, effectiveStatus: null, statusSource: null };
    for (const step of trace.logisticsSteps) {
      if (!step || typeof step !== 'object') throw Error('INVALID_TRACE_RESPONSE');
      const at = parseTraceTime(step.acceptTime ?? step.accept_time, now);
      if (!at) continue;
      if (!time.latestTraceAt || at > time.latestTraceAt) time.latestTraceAt = at;
      const remark = typeof step.remark === 'string' ? step.remark : '';
      const structured = step.action === 'SIGN';
      // Some carriers report the completed event as “送达【收件人】签收”.
      // Require a clause boundary so “待送达/预计送达” cannot match it.
      // The name is used only for recognition and is never retained.
      const namedPattern = /(?:^|[，,。；;\s])(?:已)?送达\s*[【\[][^】\]\r\n]{1,60}[】\]]\s*签收(?:[。！!，,；;\s]|$)/;
      const namedSignature = namedPattern.test(remark);
      const recipientSignature=recipientSignaturePattern.test(remark);
      const explicitText = /已签收|签收成功/.test(remark) || namedSignature || recipientSignature;
      const clauses = remark.split(/[，,。；;\r\n]/).map(clause => clause.trim()).filter(Boolean);
      const withoutNames = text => text.replace(/[【\[][^】\]\r\n]*[】\]]/g, '【收件人】');
      const signatureClauses = clauses.filter(clause => /已签收|签收成功/.test(clause) || namedPattern.test(clause)||recipientSignaturePattern.test(clause));
      // Unrelated contact/advice clauses must not turn a completed signature
      // into a negative match (e.g. “如需反馈请联系…，送达【…】签收”).
      const broadNegative = /未签|未由本人签收|未被签收|未收到|未送达|没有签收|尚未|未能|无法|拒签|拒收|误签|错误|疑似|可能|反馈|显示.*已签收|签收失败|签收异常|待签收|等待签收|请.*签收|如.*签收|签收后/;
      const contradiction = clauses.some(clause => !/^(?:如|若|倘若)/.test(clause)
        && /未签|未由本人签收|未被签收|未收到|未送达|没有签收|尚未|未能|无法|拒签|拒收|误签|签收失败|签收异常|待签收|等待签收/.test(withoutNames(clause)));
      const negative = contradiction || (signatureClauses.length
        ? signatureClauses.every(clause => broadNegative.test(withoutNames(clause)))
        : broadNegative.test(withoutNames(remark)));
      if (diagnose) checks.push({
        at, structuredSign: structured, signedText: explicitText, namedSignature, recipientSignature,rejected: negative,
        rejectionReason: negative ? contradiction ? 'status_contradiction' : 'signature_clause' : null,
        hasReceiptWord: /签收/.test(remark), hasDeliveryWord: /送达/.test(remark),
        completedDeliveryText: /已将快件送达|已送达/.test(remark),
        officialSigned: result.shipments.some(item => item.logisticsId === trace.logisticsId && item.rawStatus === 'SIGN'),
      });
      if (!negative && (structured || explicitText) && (!time.signedAt || at > time.signedAt)) {
        time.signedAt = at;
        time.signedAtSource = structured ? 'action_SIGN' : 'explicit_signed_text';
      }
      const eventClauses = clauses.filter(clause => !/^(?:如|若|倘若|如果|预计|请|可能)/.test(clause)).map(withoutNames);
      const eventText = eventClauses.join('，');
      let event = null;
      if (/拒签|拒收|签收失败|签收异常|退回|退件/.test(eventText)||deliveryRestrictionPattern.test(eventText)) event = 'UNSIGN';
      else if (!negative && (structured || explicitText)) event = 'SIGN';
      else if (/正在派送|派送中|正在派件|派件中|开始派送/.test(eventText) || step.action === 'DELIVERING') event = 'DELIVERING';
      else if (/运输中|运输途中|快件已到达|快件离开|已发往|(?:到达|离开|发往|发出|运往).{0,30}(?:转运中心|分拨中心)/.test(eventText) || step.action === 'TRANSPORT') event = 'TRANSPORT';
      if (event && (!time.statusAt || at > time.statusAt)) {
        time.statusAt = at; time.effectiveStatus = event;
        time.statusSource = event === 'SIGN' ? structured ? 'action_SIGN' : 'explicit_signed_text' : 'trace_event';
      } else if (event && at === time.statusAt && time.effectiveStatus !== event) {
        time.effectiveStatus = 'UNKNOWN'; time.statusSource = 'conflicting_trace_events';
      }
    }
    times.set(trace.logisticsId, time);
  }
  return { ...result, ...(diagnose ? { correspondence: diagnoseLogisticsCorrespondence(result, payload, now), timeCheck: { parser: 'trace-parser-v6', matchedTraces: times.size, checks: checks.sort((a,b) => b.at.localeCompare(a.at)).slice(0,8) } } : {}), shipments: result.shipments.map(shipment => {
    const time = times.get(shipment.logisticsId);
    const effectiveStatus = prioritizeTrace ? time?.effectiveStatus ?? (shipment.rawStatus === 'SIGN' ? 'UNKNOWN' : shipment.rawStatus) : shipment.rawStatus;
    return { ...shipment, ...(prioritizeTrace ? {effectiveStatus, statusSource: time?.statusSource ?? 'detail_without_signed_evidence',
      statusAt: time?.statusAt ?? null, statusConflict: effectiveStatus !== shipment.rawStatus} : {}),
      signedAt: effectiveStatus === 'SIGN' ? time?.signedAt ?? null : null,
      signedAtSource: effectiveStatus === 'SIGN' ? time?.signedAtSource ?? null : null,
      latestTraceAt: time?.latestTraceAt ?? null };
  }) };
}
