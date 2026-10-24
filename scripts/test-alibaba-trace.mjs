import assert from 'node:assert/strict';
import { attachLogisticsTrace, parseTraceTime } from '../api/_lib/alibabaTrace.js';
import { createPurchaseSnapshot } from '../api/_lib/alibabaSnapshot.js';
import { queryAlibabaLogistics } from '../api/_lib/alibabaClient.js';

const now = Date.UTC(2026, 9, 22);
assert.equal(parseTraceTime('2026-10-19 11:26:06', now), '2026-10-19T03:26:06.000Z');
for (const invalid of ['2026-02-30 11:26:06','2026-10-19 25:00:00','2026-10-19','2026-10-23 12:00:00','1999-01-01 00:00:00',null]) assert.equal(parseTraceTime(invalid, now),null);
const orderId='5127369483007127225';
const base={orderId,shipments:[{logisticsId:'LP1',rawStatus:'SIGN'},{logisticsId:'LP2',rawStatus:'TRANSPORT'}]};
const step=(remark,acceptTime='2026-10-19 11:26:06')=>({remark,acceptTime});
const payload=steps=>({success:true,logisticsTrace:[{logisticsId:'LP1',logisticsBillNo:'PRIVATE_BILL',logisticsSteps:steps}]});
const attach=steps=>attachLogisticsTrace(base,payload(steps),now);
const positive=attach([step('您的快件已签收，PRIVATE_PHONE PRIVATE_ADDRESS')]);
assert.equal(positive.shipments[0].signedAt,'2026-10-19T03:26:06.000Z');
assert.equal(positive.shipments[0].signedAtSource,'explicit_signed_text');
assert.doesNotMatch(JSON.stringify(positive),/PRIVATE|remark|logisticsBillNo/);
const namedSignature=attach([step('包裹已由派件员派送，PRIVATE_PHONE，送达【测试收件人】签收。','2026-10-20 14:43:39')]);
assert.equal(namedSignature.shipments[0].signedAt,'2026-10-20T06:43:39.000Z');
assert.equal(namedSignature.shipments[0].signedAtSource,'explicit_signed_text');
assert.doesNotMatch(JSON.stringify(namedSignature),/PRIVATE_PHONE|测试收件人|remark/);
for(const remark of [
  '如需反馈请联系派件员，送达【测试收件人】签收。',
  '请联系派件员，送达【测试收件人】签收。',
  '有问题请反馈，送达【测试收件人】签收。',
  '送达【测试收件人】签收。如未收到请联系派件员。',
  '已签收，如有问题请反馈。',
])assert.equal(attach([step(remark)]).shipments[0].signedAt,'2026-10-19T03:26:06.000Z',remark);
for(const remark of ['未签收，送达【测试收件人】签收。','拒收，已签收','如果已签收请反馈','可能已签收，请反馈'])assert.equal(attach([step(remark)]).shipments[0].signedAt,null,remark);
const diagnostic=attachLogisticsTrace(base,payload([step('已将快件送达（上门服务），PRIVATE_PHONE PRIVATE_NAME')]),now,true);
assert.equal(diagnostic.timeCheck.parser,'trace-parser-v6');
assert.equal(diagnostic.timeCheck.checks[0].completedDeliveryText,true);
assert.equal(diagnostic.timeCheck.checks[0].hasReceiptWord,false);
assert.equal(diagnostic.shipments[0].signedAt,null);
assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_PHONE|PRIVATE_NAME|remark/);
for(const remark of ['未送达【测试收件人】签收','待送达【测试收件人】签收','请送达【测试收件人】签收','拒签，送达【测试收件人】签收','预计送达【测试收件人】签收'])assert.equal(attach([step(remark)]).shipments[0].signedAt,null,remark);
assert.equal(attachLogisticsTrace(base,{success:true,logisticsTrace:[{logisticsId:'LP2',logisticsSteps:[step('送达【测试收件人】签收。')]}]},now).shipments[1].signedAt,null);
for(const remark of ['未签收','尚未签收','拒签','签收失败','未被签收','已将快件送达（上门服务）','正在派件','如果已签收请忽略','显示已签收但未收到','签收后请确认','可能已签收'])assert.equal(attach([step(remark)]).shipments[0].signedAt,null,remark);
const action=attach([{acceptTime:'2026-10-19 11:26:06',action:'SIGN'}]);
assert.equal(action.shipments[0].signedAtSource,'action_SIGN');
assert.equal(attach([{accept_time:'2026-10-19 11:26:06',action:'SIGN'}]).shipments[0].signedAt,action.shipments[0].signedAt);
assert.equal(attach([{...step('拒签'),action:'SIGN'}]).shipments[0].signedAt,null);
assert.equal(attachLogisticsTrace(base,{success:true,logisticsTrace:[{logisticsId:'OTHER',logisticsSteps:[step('已签收')]}]},now).shipments[0].signedAt,null);
assert.equal(attachLogisticsTrace(base,{success:true,logisticsTrace:[{logisticsId:'LP2',logisticsSteps:[step('已签收')]}]},now).shipments[1].signedAt,null);
const unsorted=attach([step('运输中','2026-10-20 09:00:00'),step('已签收'),step('已被签收','2026-10-19 10:00:00')]);
assert.equal(unsorted.shipments[0].signedAt,'2026-10-19T03:26:06.000Z');
assert.equal(unsorted.shipments[0].latestTraceAt,'2026-10-20T01:00:00.000Z');
assert.throws(()=>attachLogisticsTrace(base,{success:false,logisticsTrace:[]},now));
assert.throws(()=>attachLogisticsTrace(base,payload(Array.from({length:5001},()=>step('x'))),now));
const partial=createPurchaseSnapshot([positive]);assert.equal(partial.status,'partial_signed');assert.equal(partial.evidence.signed_at,'2026-10-19T03:26:06.000Z');
const full={...positive,shipments:[positive.shipments[0],{...positive.shipments[0],logisticsId:'LP2',signedAt:'2026-10-20T03:00:00.000Z'}]};
assert.equal(createPurchaseSnapshot([full]).evidence.signed_at,'2026-10-20T03:00:00.000Z');
assert.equal(createPurchaseSnapshot([{...full,shipments:[full.shipments[0],{...full.shipments[1],signedAt:null}]}]).evidence.signed_at,null);
assert.equal(createPurchaseSnapshot([{...full,shipments:[{...full.shipments[0],signedAtSource:'unsupported'}]}]).evidence.signed_at,null);
assert.throws(()=>createPurchaseSnapshot([full,{...full,shipments:[{...full.shipments[0],signedAt:'2026-10-20T03:00:00.000Z'}]}]),/CONFLICTING/);

const env={ALIBABA_APP_KEY:'1682587',ALIBABA_APP_SECRET:'secret',ALIBABA_ACCOUNT_B_ACCESS_TOKEN:'token',ALIBABA_TRACE_ENABLED:'true'};
let calls=0;
const fetched=await queryAlibabaLogistics({account:'B',orderId},env,async(url,init)=>{
  calls++;assert.equal(init.body.get('orderId'),orderId);assert.equal(init.body.has('logisticsId'),false);
  assert.equal(init.body.get('access_token'),'token');
  return url.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]}):Response.json(payload([step('已签收')]));
});
assert.equal(calls,2);assert.equal(fetched.shipments[0].signedAt,'2026-10-19T03:26:06.000Z');
let restrictedCalls=0;
await queryAlibabaLogistics({account:'B',orderId},{...env,ALIBABA_TRACE_PILOT_ORDER_ID:'another-order'},async url=>{
  restrictedCalls++;assert.ok(url.includes('getLogisticsInfos'));return Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]});
});
assert.equal(restrictedCalls,1);
let batchCalls=0;
await queryAlibabaLogistics({account:'B',orderId,batchTrace:true},{...env,ALIBABA_TRACE_PILOT_ORDER_ID:'another-order'},async url=>{
  batchCalls++;return url.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]}):Response.json(payload([step('已签收')]));
});
assert.equal(batchCalls,2);
await assert.rejects(queryAlibabaLogistics({account:'B',orderId},env,async url=>url.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]}):Response.json({success:false})),error=>error.code==='ALIBABA_TRACE_UNAVAILABLE'&&error.phase==='trace');
await assert.rejects(queryAlibabaLogistics({account:'B',orderId,deadline:0},env,async()=>{throw Error('must not fetch');}),error=>error.code==='ALIBABA_NETWORK_ERROR'&&error.phase==='details');
console.log('PASS: trace matching, conservative signature evidence, Shanghai dates, invalid/future dates, missing times, multi-parcel aggregation, redaction, opt-in calls, deadline and trace failures.');
