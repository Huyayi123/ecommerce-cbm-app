import assert from 'node:assert/strict';
import { queryAlibabaLogistics } from '../api/_lib/alibabaClient.js';
import { createAlibabaSelfHandler } from '../api/alibaba-self.js';
const orderId='5127369483007127225', uid='9401d015-9de4-4e4e-89a4-257c1e8d7028';
const env={VERCEL_ENV:'production',ALIBABA_SELF_SERVICE_ENABLED:'true',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret',ALIBABA_APP_KEY:'1682587',ALIBABA_APP_SECRET:'secret',ALIBABA_ACCOUNT_A_ACCESS_TOKEN:'token'};
const request={method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:{action:'diagnose',recordId:'record',expectedVersion:3,orderIds:[orderId],account:'B'}};
async function check({denied=false,version=3,linked=true,otherOrder=false,conflict=false,account='A',apply=false,writeEnabled=false,queryFailure=false,commitFailure=false,multiple=false}={}){
 const calls=[],out={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 const fetcher=async(url,init)=>{
  url=String(url);
  calls.push(String(url));
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(url.includes('/alibaba_logistics_users?'))return Response.json([{user_id:uid,enabled:true,logistics_role:'admin'}]);
  if(url.endsWith('/read_alibaba_refresh_target'))return denied?Response.json({code:'42501'},{status:403}):Response.json({account_code:account,version,user_id:uid,buyer_name:'测试采购人',order_ids:multiple?[orderId,'2']:linked?[conflict?'5127377259011018519':orderId]:['1']});
  if(url.endsWith('/commit_alibaba_purchase_snapshot')){
   const args=JSON.parse(init.body);assert.equal(args.p_actor,uid);assert.equal(args.p_buyer_user_id,uid);assert.equal(args.p_account_code,'A');assert.equal(args.p_snapshot.status,'in_transit');
   return commitFailure?Response.json({code:'40001'},{status:409}):Response.json({status:'in_transit'});
  }
  if(url.includes('getLogisticsInfos')){
   assert.equal(init.body.get('access_token'),'token');assert.equal(init.body.get('orderId'),orderId);
   return Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN',logisticsStatus:'TRANSPORT',receiver:'PRIVATE'}]});
  }
  assert.ok(url.includes('getLogisticsTraceInfo'));
  if(queryFailure)return Response.json({success:false});
  return Response.json({success:true,logisticsTrace:[{logisticsId:'LP1',status:'TRANSPORT',logisticsStatus:'PRIVATE',logisticsBillNo:'PRIVATE',logisticsSteps:[
   {acceptTime:'2026-10-21 12:00:00',remark:'快件已到达转运中心，PRIVATE',action:'TRANSPORT'},
   {acceptTime:'2026-10-20 11:00:00',remark:'PRIVATE',action:'PRIVATE'},
  ]},{logisticsId:'OTHER',logisticsSteps:[]}]});
 };
 const input=otherOrder?'1':conflict?'5127377259011018519':orderId;
 await createAlibabaSelfHandler({env:{...env,ALIBABA_TRACE_PILOT_WRITE_ENABLED:writeEnabled?'true':'false'},fetcher})({...request,body:{...request.body,action:apply?'applyDiagnostic':'diagnose',orderIds:[input]}},out);
 return {calls,out};
}
let r=await check();assert.equal(r.out.code,200);assert.equal(r.out.body.readOnly,true);
const report=r.out.body.diagnostic;
assert.equal(report.account,'A');assert.equal(report.accountSource,'protected_order_link');
assert.equal(report.shipments[0].detailStatusFields.logisticsStatus,'TRANSPORT');
assert.equal(report.shipments[0].rawStatus,'SIGN');assert.equal(report.shipments[0].traceCount,1);
assert.equal(report.traces[0].latestSteps[0].transportText,true);assert.equal(report.traces[1].matched,false);
assert.equal(report.traces[0].statuses.logisticsStatus,'UNRECOGNIZED');
assert.doesNotMatch(JSON.stringify(report),/PRIVATE|token|secret|remark|logisticsBillNo/);
assert.ok(!r.calls.some(url=>/commit|finish|continue|start|save|fail_alibaba/.test(url)));
for(const options of [{denied:true},{version:4},{linked:false},{otherOrder:true}]){
 r=await check(options);assert.notEqual(r.out.code,200);assert.ok(!r.calls.some(url=>url.includes('gw.open.1688.com')));
}
console.log('PASS: bounded read-only correspondence, protected account/link/version, exact IDs, alternate status fields, trace matching and privacy.');
r=await check({conflict:true,account:'B'});assert.equal(r.out.body.error,'DIAGNOSTIC_ACCOUNT_MISMATCH');assert.ok(!r.calls.some(url=>url.includes('gw.open.1688.com')));
r=await check({apply:true});assert.equal(r.out.body.error,'PILOT_WRITE_PAUSED');assert.ok(!r.calls.some(url=>url.includes('/rpc/')||url.includes('gw.open')));
r=await check({apply:true,writeEnabled:true});assert.equal(r.out.code,200);assert.equal(r.out.body.applied,true);assert.equal(r.out.body.readOnly,false);assert.equal(r.calls.filter(url=>url.endsWith('/commit_alibaba_purchase_snapshot')).length,1);
for(const options of [{denied:true},{version:4},{linked:false},{multiple:true},{queryFailure:true}]){
 r=await check({...options,apply:true,writeEnabled:true});assert.notEqual(r.out.code,200);assert.ok(!r.calls.some(url=>url.endsWith('/commit_alibaba_purchase_snapshot')));
}
r=await check({apply:true,writeEnabled:true,commitFailure:true});assert.equal(r.out.body.error,'LINK_CHANGED');
console.log('PASS: bounded pilot writes, default closed gate, fresh trace query, protected account/identity, single-order scope, failure no-write and commit version conflict.');
