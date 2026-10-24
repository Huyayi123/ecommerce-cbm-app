import assert from 'node:assert/strict';
import {attachLogisticsTrace} from '../api/_lib/alibabaTrace.js';
import {createPurchaseSnapshot} from '../api/_lib/alibabaSnapshot.js';
const now=Date.UTC(2026,9,23),orderId='5127377259011018519';
const step=(remark,acceptTime='2026-10-22 05:26:08')=>({remark,acceptTime});
function analyze(groups,raw='SIGN'){
 const base={orderId,shipments:groups.map((_,i)=>({logisticsId:`LP${i}`,rawStatus:raw}))};
 const trace={success:true,logisticsTrace:groups.map((steps,i)=>({logisticsId:`LP${i}`,logisticsSteps:steps}))};
 const parsed=attachLogisticsTrace(base,trace,now,false,true);
 return {parsed,snapshot:createPurchaseSnapshot([parsed])};
}
// Synthetic remarks representing the user's sanitized four-parcel evidence.
let r=analyze(Array.from({length:4},()=>[step('快件已到达转运中心')]));
assert.equal(r.snapshot.status,'in_transit');assert.equal(r.snapshot.signed_count,0);assert.equal(r.snapshot.evidence.signed_at,null);
assert.ok(r.parsed.shipments.every(item=>item.rawStatus==='SIGN'&&item.effectiveStatus==='TRANSPORT'&&item.statusConflict));
r=analyze([[step('送达【测试收件人】签收。')],[step('运输中')],[step('正在派送')],[step('拒签')]]);
assert.equal(r.snapshot.status,'partial_signed');assert.equal(r.snapshot.signed_count,1);assert.equal(r.snapshot.shipment_count,4);assert.equal(r.snapshot.exception_count,1);
assert.equal(r.snapshot.evidence.signed_at,'2026-10-21T21:26:08.000Z');assert.doesNotMatch(JSON.stringify(r),/测试收件人|remark/);
r=analyze([[step('已签收')]],'TRANSPORT');assert.equal(r.snapshot.status,'returned_signed');assert.equal(r.snapshot.signed_count,1);
r=analyze([[step('已签收','2026-10-21 12:00:00'),step('运输中')]]);assert.equal(r.snapshot.status,'in_transit');assert.equal(r.parsed.shipments[0].signedAt,null);
r=analyze([[step('已签收'),step('退回','2026-10-22 06:00:00')]]);assert.equal(r.snapshot.status,'sign_exception');assert.equal(r.snapshot.evidence.signed_at,null);
r=analyze([[step('已签收'),step('如需联系转运中心请联系服务人员','2026-10-22 06:00:00')]]);assert.equal(r.snapshot.status,'returned_signed');
for(const text of ['如果已签收请忽略','可能已签收','未签收','待签收','预计到达转运中心','请联系转运中心']){
 r=analyze([[step(text)]]);assert.equal(r.snapshot.signed_count,0,text);assert.equal(r.snapshot.status,'unknown',text);
}
r=analyze([[step('已签收'),step('运输中')]]);assert.equal(r.snapshot.status,'unknown');assert.equal(r.snapshot.evidence.signed_at,null);
r=analyze([[],[step('已签收')]]);assert.equal(r.snapshot.status,'partial_signed');assert.equal(r.snapshot.signed_count,1);
r=analyze([[step('正在派送')]]);assert.equal(r.snapshot.status,'in_transit');assert.match(r.snapshot.detail,/派送中/);
console.log('PASS: trace-priority four-parcel conflict, partial/full signatures, latest meaningful events, regressions, exceptions, ties, missing evidence and privacy.');
for(const older of ['正在派送','已签收']){
 r=analyze([[step(older,'2026-10-22 12:49:14'),step('等待收件人仓库验货，导致投递受限 INVALID','2026-10-22 19:51:31')]]);
 assert.equal(r.snapshot.status,'sign_exception');assert.equal(r.snapshot.exception_count,1);
 assert.equal(r.snapshot.evidence.signed_at,null);assert.equal(r.parsed.shipments[0].statusAt,'2026-10-22T11:51:31.000Z');
 assert.equal(r.snapshot.evidence.latest_trace_at,'2026-10-22T11:51:31.000Z');
}
for(const text of ['等待收件人仓库验货','INVALID','如果导致投递受限请联系服务人员']){
 r=analyze([[step('正在派送','2026-10-22 12:49:14'),step(text,'2026-10-22 19:51:31')]]);
 assert.equal(r.parsed.shipments[0].effectiveStatus,'DELIVERING',text);
}
r=analyze([[step('导致投递受限','2026-10-22 12:00:00'),step('已签收','2026-10-22 19:51:31')]]);
assert.equal(r.snapshot.status,'returned_signed');assert.equal(r.snapshot.exception_count,0);
console.log('PASS: later delivery restriction overrides delivery/signature, clears signature time, and later completed signature resolves restriction.');
for(const [date,expected] of [['2026-10-19 12:18:15','2026-10-19T04:18:15.000Z'],['2026-10-18 14:18:30','2026-10-18T06:18:30.000Z']]){
 r=analyze([[step('正在派送','2026-10-18 10:00:00'),step('您的快件由本人签收，如有疑问请联系服务人员。',date)]]);
 assert.equal(r.snapshot.status,'returned_signed');assert.equal(r.snapshot.evidence.signed_at,expected);
}
for(const text of ['请您的快件由本人签收','预计您的快件由本人签收','如果您的快件由本人签收，请忽略','您的快件由本人签收后请确认','您的快件未由本人签收','您的快件由本人签收？','您的快件由本人签收，拒签']){
 r=analyze([[step(text)]]);assert.equal(r.snapshot.signed_count,0,text);
}
