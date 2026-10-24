import assert from 'node:assert/strict';
import { createAlibabaSyncHandler } from '../api/alibaba-sync.js';
const uid='d32f1446-c579-44ec-8a07-d6d888688bc0',runId='11111111-1111-4111-8111-111111111111',token='22222222-2222-4222-8222-222222222222';
const env={VERCEL_ENV:'production',ALIBABA_SELF_SERVICE_ENABLED:'true',ALIBABA_BATCH_SYNC_ENABLED:'true',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret'};
const response=()=>({status(code){this.code=code;return this;},json(body){this.body=body;return this;},setHeader(){}});
async function run(body,{expired=false,queryError=false,invalid=false,role='admin',noAuth=false,policyDisabled=false,databasePaused=false,oversized=false,oldProtocol=false,multipleOrders=false,voidStatus=204,apiPaused=false,oldFulfillment=false,fulfillmentContext=null}={}){
  if(body.action==='start'&&!Object.hasOwn(body,'expectedRecordLimit'))body={...body,expectedRecordLimit:5};
  const calls=[],deadlines=[];let queries=0;
  const fetcher=async(url,init)=>{
    const u=String(url);
    if(u.endsWith('/auth/v1/user'))return Response.json({id:uid});
    if(u.includes('/alibaba_logistics_users?'))return Response.json([{user_id:uid,enabled:true,logistics_role:role}]);
    assert.equal(init.headers.apikey,'secret');const args=JSON.parse(init.body);calls.push({u,args});
    if(u.endsWith('/alibaba_sync_policy_v2'))return Response.json({protocol:oldProtocol?1:2,fulfillmentProtocol:oldFulfillment?0:1,manualEnabled:!policyDisabled,recordLimit:5});
    if(u.endsWith('/start_alibaba_sync_v2')){assert.equal(args.p_actor,uid);if(args.p_expected_limit!==5)return Response.json({code:'22023'},{status:409});return Response.json({protocol:2,runId,state:'running',recordLimit:5,token:'NOT_FOR_BROWSER'});}
    if(u.endsWith('/alibaba_sync_progress_v2'))return Response.json({protocol:2,recordLimit:5,token:'NOT_FOR_BROWSER',state:'complete',total:2,success:1,failed:1,skipped:0});
    if(u.endsWith('/claim_alibaba_sync_v2'))return databasePaused?Response.json({code:'55000'},{status:409}):expired?Response.json({code:'42501'},{status:403}):Response.json({protocol:oldProtocol?1:2,fulfillmentProtocol:oldFulfillment?0:1,runId,claimId:token,items:Array.from({length:oversized?2:1},()=>({recordId:'r1',version:4,account:'A',fulfillmentContext,orderIds:multipleOrders?['5127369483007127225','5127369483007127226','5127369483007127227']:['5127369483007127225'],valid:!invalid}))});
    if(u.endsWith('/finish_alibaba_sync_item_v2')||u.endsWith('/continue_alibaba_sync_v2'))assert.equal(args.p_claim,token);
    return new Response(null,{status:voidStatus});
  };
  const out=response();
  await createAlibabaSyncHandler({env:{...env,ALIBABA_BATCH_SYNC_ENABLED:apiPaused?'false':'true'},fetcher,pause:async()=>{},query:async (input,workerEnv)=>{assert.equal(workerEnv.ALIBABA_TRACE_ENABLED,'true');assert.equal(workerEnv.ALIBABA_TRACE_STATUS_ENABLED,'true');assert.equal(input.fulfillmentContext,fulfillmentContext);queries++;deadlines.push(input.deadline);assert.equal(input.batchTrace,true);assert.equal(input.account,'A');assert.ok(Number.isFinite(input.deadline)&&input.deadline<=Date.now()+45000);if(queryError)throw Object.assign(Error('PRIVATE upstream message'),{code:typeof queryError==='string'?queryError:undefined});return {orderId:input.orderId,shipments:[{logisticsId:'LP1',rawStatus:'SIGN'}]};}})(
    {method:'POST',headers:{'content-type':'application/json',...(noAuth?{}:{authorization:'Bearer jwt'})},body},out);
  assert.doesNotMatch(JSON.stringify(out.body),/secret|NOT_FOR_BROWSER|PRIVATE/);
  return {out,calls,queries,deadlines};
}
let r=await run({action:'start',p_actor:'forged'});assert.equal(r.out.code,200);assert.deepEqual(Object.keys(r.out.body).sort(),['ok','recordLimit','runId','state']);
r=await run({action:'start'},{noAuth:true});assert.equal(r.out.code,401);assert.equal(r.calls.length,0);
r=await run({action:'start'},{role:'viewer'});assert.equal(r.out.code,403);assert.equal(r.calls.length,0);
r=await run({workerToken:token},{expired:true});assert.equal(r.queries,0);assert.equal(r.out.code,409);
r=await run({workerToken:token});assert.equal(r.out.code,200);assert.equal(r.queries,1);assert.equal(r.calls.find(c=>c.u.endsWith('/finish_alibaba_sync_item_v2')).args.p_snapshot.status,'returned_signed');assert.ok(r.calls.at(-1).u.endsWith('/continue_alibaba_sync_v2'));
r=await run({workerToken:token},{queryError:true});assert.equal(r.out.code,200);assert.equal(r.calls.find(c=>c.u.endsWith('/finish_alibaba_sync_item_v2')).args.p_failed,true);assert.deepEqual(r.calls.find(c=>c.u.endsWith('/finish_alibaba_sync_item_v2')).args.p_snapshot,{failure_code:'UNCLASSIFIED',retryable:false});
r=await run({workerToken:token},{queryError:'ALIBABA_NETWORK_ERROR'});assert.deepEqual(r.calls.find(c=>c.u.endsWith('/finish_alibaba_sync_item_v2')).args.p_snapshot,{failure_code:'NETWORK',retryable:true});
r=await run({workerToken:token},{invalid:true});assert.equal(r.queries,0);
r=await run({action:'status',runId});assert.equal(r.out.body.failed,1);
console.log('PASS: batch authorization, actor derivation, private one-use worker capabilities, failed-query preservation request, stale target skip and chained batches.');

const stopped=response();await createAlibabaSyncHandler({env:{...env,ALIBABA_BATCH_SYNC_ENABLED:'false'},fetcher:async()=>{throw Error('Paused worker reached database');}})({method:'POST',headers:{'content-type':'application/json'},body:{workerToken:token}},stopped);assert.equal(stopped.body.error,'SYNC_PAUSED');

r=await run({action:'start'},{policyDisabled:true});assert.equal(r.out.code,503);assert.equal(r.out.body.error,'SYNC_PAUSED');assert.ok(!r.calls.some(call=>call.u.endsWith('/start_alibaba_sync_v2')));
r=await run({workerToken:token},{databasePaused:true});assert.equal(r.out.code,503);assert.equal(r.out.body.error,'SYNC_PAUSED');assert.equal(r.queries,0);
for(const options of [{oversized:true},{oldProtocol:true}]){r=await run({workerToken:token},options);assert.equal(r.out.code,409);assert.equal(r.queries,0);assert.ok(!r.calls.some(call=>call.u.endsWith('/finish_alibaba_sync_item_v2')));}
r=await run({workerToken:token},{multipleOrders:true});assert.equal(r.out.code,200);assert.equal(r.queries,3);
r=await run({action:'start'},{oldProtocol:true});assert.equal(r.out.code,503);assert.ok(!r.calls.some(call=>call.u.endsWith('/start_alibaba_sync_v2')));
console.log('PASS: v2 protocol enforcement, single-record worker bound, claim-bound writes/continuation, shared query deadline and database pause before dispatch.');

r=await run({action:'start',expectedRecordLimit:null});assert.equal(r.out.code,409);assert.equal(r.out.body.error,'SYNC_MODE_CHANGED');
r=await run({workerToken:token},{multipleOrders:true});assert.equal(new Set(r.deadlines).size,1);


r=await run({workerToken:token},{voidStatus:200});assert.equal(r.out.code,200);assert.ok(r.calls.at(-1).u.endsWith('/continue_alibaba_sync_v2'));
r=await run({action:'status',runId},{apiPaused:true});assert.equal(r.out.code,200);assert.equal(r.out.body.failed,1);assert.equal(r.queries,0);assert.equal(r.calls.length,1);
r=await run({action:'status',runId},{apiPaused:true,noAuth:true});assert.equal(r.out.code,401);assert.equal(r.calls.length,0);
r=await run({action:'start'},{apiPaused:true});assert.equal(r.out.body.error,'SYNC_PAUSED');assert.equal(r.calls.length,0);
r=await run({action:'status',runId,workerToken:token},{apiPaused:true});assert.equal(r.out.body.error,'SYNC_PAUSED');assert.equal(r.calls.length,0);
r=await run({action:'start'},{oldFulfillment:true});assert.equal(r.out.body.error,'BATCH_SYNC_NOT_INSTALLED');assert.ok(!r.calls.some(c=>c.u.endsWith('/start_alibaba_sync_v2')));
r=await run({workerToken:token},{oldFulfillment:true});assert.equal(r.out.body.error,'SYNC_REJECTED');assert.equal(r.queries,0);
r=await run({workerToken:token},{fulfillmentContext:'awaiting_shipment'});assert.equal(r.out.code,200);assert.equal(r.queries,1);
r=await run({workerToken:token},{fulfillmentContext:'buyer_pickup'});assert.equal(r.queries,0);
r=await run({workerToken:token},{fulfillmentContext:'UNTRUSTED'});assert.equal(r.queries,0);

for(const [limit,auto,expectedLimit,allowed,mode='5'] of [[5,false,5,true],[null,false,5,false],[5,true,5,false],[5,false,null,false],[null,false,null,true,'all'],[5,false,null,false,'all'],[null,true,null,false,'all'],[null,false,5,false,'all']]){
 let starts=0;const out=response();
 await createAlibabaSyncHandler({env:{...env,ALIBABA_BATCH_PILOT_LIMIT:mode},fetcher:async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(path.endsWith('/alibaba_logistics_users'))return Response.json([{user_id:uid,enabled:true,logistics_role:'admin'}]);
  if(path.endsWith('/alibaba_sync_policy_v2'))return Response.json({protocol:2,fulfillmentProtocol:1,manualEnabled:true,recordLimit:limit,autoEnabled:auto});
  assert.ok(path.endsWith('/start_alibaba_sync_v2'));starts++;
  assert.equal(JSON.parse(init.body).p_expected_limit,expectedLimit);return Response.json({protocol:2,runId,state:'running',recordLimit:limit});
 }})({method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fake'},body:{action:'start',expectedRecordLimit:expectedLimit}},out);
 assert.equal(out.code,allowed?200:409);assert.equal(starts,allowed?1:0);
}
console.log('PASS: server scope locks require matching five/all database and request modes with automatic sync disabled.');
