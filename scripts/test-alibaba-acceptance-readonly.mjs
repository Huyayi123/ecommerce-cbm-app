import assert from 'node:assert/strict';
import {createAlibabaSelfHandler} from '../api/alibaba-self.js';
for(const orderId of ['5127876109006072034','5127778440001026842']){
 for(const action of ['diagnose','applyDiagnostic']){
  let calls=0;
  const fetcher=async url=>{
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/auth/v1/user'))return Response.json({id:'9401d015-9de4-4e4e-89a4-257c1e8d7028'});
   if(path.endsWith('/alibaba_logistics_users'))return Response.json([{user_id:'9401d015-9de4-4e4e-89a4-257c1e8d7028',enabled:true,logistics_role:'admin'}]);
   assert.ok(path.endsWith('/read_alibaba_refresh_target'));
   return Response.json({account_code:'B',order_ids:[orderId],version:3});
  };
  const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await createAlibabaSelfHandler({env:{VERCEL_ENV:'preview',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'fake',ALIBABA_TRACE_PILOT_WRITE_ENABLED:'true'},fetcher,query:async input=>{
   calls++;assert.equal(input.orderId,orderId);assert.equal(input.account,'B');
   return {orderId,shipments:[]};
  }})({method:'POST',headers:{authorization:'Bearer fake','content-type':'application/json'},body:{action,recordId:'record',expectedVersion:3,orderIds:[orderId]}},response);
  assert.equal(response.code,action==='diagnose'?200:503);
  assert.equal(calls,action==='diagnose'?1:0);
  if(action==='diagnose'){assert.equal(response.body.readOnly,true);assert.equal(response.body.canApply,false);}
 }
}
console.log('PASS: both acceptance orders query protected account and refuse writes before upstream calls.');
for(const [orderId,role,extra,expected] of [
 ['5127876109006072034','admin',{},200],['5127778440001026842','admin',{},200],
 ['123','admin',{},400],['5127876109006072034','buyer',{},403],
 ['5127876109006072034','admin',{account:'A'},400],
]){
 let queried=0;
 const fetcher=async url=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/auth/v1/user'))return Response.json({id:'9401d015-9de4-4e4e-89a4-257c1e8d7028'});
  assert.ok(path.endsWith('/alibaba_logistics_users'));
  return Response.json([{user_id:'9401d015-9de4-4e4e-89a4-257c1e8d7028',enabled:true,logistics_role:role}]);
 };
 const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await createAlibabaSelfHandler({env:{VERCEL_ENV:'preview',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon'},fetcher,query:async input=>{
  queried++;assert.equal(input.account,'B');assert.equal(input.orderId,orderId);return {orderId,shipments:[]};
 }})({method:'POST',headers:{authorization:'Bearer fake','content-type':'application/json'},body:{action:'diagnoseUnlinkedAcceptance',orderId,...extra}},response);
 assert.equal(response.code,expected);assert.equal(queried,expected===200?1:0);
 if(expected===200){assert.equal(response.body.readOnly,true);assert.equal(response.body.canApply,false);assert.equal(response.body.applied,false);}
}
console.log('PASS: unlinked diagnostics are admin-only, fixed-account B, two-order-only and perform no database access after authorization.');
