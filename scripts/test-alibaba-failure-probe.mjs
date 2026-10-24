import assert from 'node:assert/strict';
import {createAlibabaSelfHandler} from '../api/alibaba-self.js';
import {AlibabaError,describeAlibabaResponse,queryAlibabaLogistics} from '../api/_lib/alibabaClient.js';
const uid='d32f1446-c579-44ec-8a07-d6d888688bc0';
const targets=[['5127554054006090539','aa66308b-46d0-4928-86ca-b8441c2caa61'],['5127881617007009337','ab6fdb15-1d16-4e9b-8838-1f4f38851c58']];
const env={VERCEL_ENV:'production',ALIBABA_SELF_SERVICE_ENABLED:'true',ALIBABA_TRACE_PILOT_WRITE_ENABLED:'true',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret'};
async function probe({target=targets[0],error=null,account='A',version=1,record=null,action='failureProbe',role='admin',normalized=false,write=false}={}){
 let queries=0;const calls=[];
 const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 const fetcher=async(url,init)=>{
  url=String(url);calls.push(url);
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(url.includes('/alibaba_logistics_users?'))return Response.json([{user_id:uid,enabled:true,logistics_role:role}]);
  if(url.endsWith('/commit_alibaba_fulfillment_pilot')){assert.ok(['applyFulfillment','applyDiagnostic'].includes(action));assert.equal(write,true);return Response.json({status:'awaiting_shipment'});}
  assert.ok(url.endsWith('/read_alibaba_refresh_target'),'No write or batch RPC permitted');
  if(role!=='admin')return Response.json({code:'42501'},{status:403});
  return Response.json({account_code:account,order_ids:[target[0]],version,user_id:uid,buyer_name:'PRIVATE'});
 };
 await createAlibabaSelfHandler({env:{...env,ALIBABA_FULFILLMENT_PILOT_WRITE_ENABLED:write?'true':'false'},fetcher,query:async(input,config)=>{
  queries++;assert.equal(input.account,'A');assert.equal(input.orderId,target[0]);assert.equal(config.ALIBABA_TRACE_STATUS_ENABLED,'true');
  if(error)throw error;
  if(normalized)return {orderId:target[0],shipments:[],fulfillment:{type:target===targets[0]?'awaiting_shipment':'buyer_pickup',source:'user_confirmed_pilot_and_api_no_logistics'}};
  return {orderId:target[0],shipments:[{logisticsId:'LP1',rawStatus:'SIGN',effectiveStatus:'TRANSPORT',latestTraceAt:'2026-10-22T01:00:00.000Z'}]};
 }})({method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:{action,recordId:record??target[1],expectedVersion:1,orderIds:[target[0]]}},response);
 assert.doesNotMatch(JSON.stringify(response.body),/PRIVATE|secret|token/);
 return {response,queries,calls};
}
for(const target of targets){const r=await probe({target});assert.equal(r.response.code,200);assert.equal(r.response.body.diagnostic.probeOutcome,'success_now');assert.equal(r.response.body.canApply,false);assert.equal(r.queries,1);assert.equal(r.response.body.diagnostic.businessContext.apiVerified,false);}
for(const [code,phase,category] of [['ORDER_NOT_OWNED','details','ORDER_OWNERSHIP'],['ALIBABA_AUTH_REJECTED','details','AUTHORIZATION'],['ALIBABA_NETWORK_ERROR','trace','NETWORK'],['ALIBABA_TRACE_UNAVAILABLE','trace','TRACE_UNAVAILABLE']]){
 const r=await probe({error:Object.assign(new AlibabaError(code),{phase,message:'PRIVATE'})});
 assert.equal(r.response.body.diagnostic.probeOutcome,'failed_now');assert.equal(r.response.body.diagnostic.phase,phase);assert.equal(r.response.body.diagnostic.failure_code,category);assert.equal(r.response.body.diagnostic.historicalCauseKnown,false);
}
for(const options of [{account:'B'},{version:2},{record:'forged'},{action:'applyDiagnostic'},{role:'buyer'}]){
 const r=await probe(options);assert.notEqual(r.response.code,200);assert.equal(r.queries,0);
}
console.log('PASS: exact two failed record/order/version probes, protected account A, admin permissions, read-only success/failure reports, phase and privacy.');
const check=describeAlibabaResponse({success:false,errorCode:'PRIVATE_TOKEN',errorMessage:'该订单待发货，暂无物流 PRIVATE_ADDRESS PRIVATE_PHONE',result:null});
assert.equal(check.awaitingShipmentMention,true);assert.equal(check.noLogisticsMention,true);assert.equal(check.knownErrorCode,null);assert.doesNotMatch(JSON.stringify(check),/PRIVATE|errorMessage/);
assert.equal(describeAlibabaResponse({message:'买家自行提货 PRIVATE'}).buyerPickupMention,true);
const queryEnv={ALIBABA_APP_KEY:'1682587',ALIBABA_APP_SECRET:'fake',ALIBABA_ACCOUNT_A_ACCESS_TOKEN:'fake',ALIBABA_TRACE_ENABLED:'true'};
await assert.rejects(queryAlibabaLogistics({account:'A',orderId:targets[0][0]},queryEnv,async()=>Response.json({success:false,result:null,message:'待发货暂无物流 PRIVATE'})),e=>e.phase==='details'&&e.responseCheck.awaitingShipmentMention&&!JSON.stringify(e.responseCheck).includes('PRIVATE'));
await assert.rejects(queryAlibabaLogistics({account:'A',orderId:targets[1][0]},queryEnv,async url=>url.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]}):Response.json({success:true,logisticsTrace:null,message:'买家自提 PRIVATE'})),e=>e.phase==='trace'&&e.responseCheck.traceType==='null'&&e.responseCheck.buyerPickupMention&&!JSON.stringify(e.responseCheck).includes('PRIVATE'));
console.log('PASS: sanitized upstream shapes and fulfillment semantic flags; user context is never represented as API-confirmed status.');
let applied=await probe({action:'applyFulfillment',normalized:true});assert.equal(applied.response.body.error,'PILOT_WRITE_PAUSED');assert.equal(applied.queries,0);
applied=await probe({action:'applyFulfillment',normalized:true,write:true});assert.equal(applied.response.body.applied,true);assert.equal(applied.calls.filter(url=>url.endsWith('/commit_alibaba_fulfillment_pilot')).length,1);
applied=await probe({action:'applyFulfillment',write:true});assert.equal(applied.response.body.error,'FULFILLMENT_EVIDENCE_CHANGED');assert.ok(!applied.calls.some(url=>url.endsWith('/commit_alibaba_fulfillment_pilot')));
assert.equal(applied.response.body.writeAttempted,false);assert.equal(applied.response.body.diagnosticStage,'snapshot_validation');
for(const target of targets){applied=await probe({target,action:'applyDiagnostic',normalized:true,write:true});assert.equal(applied.response.body.applied,true);assert.equal(applied.calls.filter(url=>url.endsWith('/commit_alibaba_fulfillment_pilot')).length,1);}
applied=await probe({action:'applyDiagnostic',normalized:true,write:true,account:'B'});assert.equal(applied.response.code,409);assert.equal(applied.queries,0);assert.equal(applied.response.body.writeAttempted,false);
