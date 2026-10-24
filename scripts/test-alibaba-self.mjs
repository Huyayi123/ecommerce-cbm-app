import assert from 'node:assert/strict';
import { createAlibabaSelfHandler } from '../api/alibaba-self.js';
import { AlibabaError } from '../api/_lib/alibabaClient.js';
const uid='9401d015-9de4-4e4e-89a4-257c1e8d7028';
const env={VERCEL_ENV:'preview',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret'};
const req={method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:{recordId:'record',expectedVersion:0,orderIds:['5127369483007127225'],account:'B',buyerUserId:'forged'}};
const out=()=>({status(c){this.code=c;return this;},json(body){this.body=body;return this;},setHeader(){}});
async function run({role='buyer',denied=false,version=0,queryFailure=false,production=false,enabled=false,draft=false,pending=false}={}) {
  let queries=0,commits=0;
  const fetcher=async(url,init)=>{
    url=String(url);
    if(url.endsWith('/auth/v1/user')) return Response.json({id:uid});
    if(url.includes('/alibaba_logistics_users?')) return Response.json([{user_id:uid,enabled:true,logistics_role:role}]);
    assert.equal(init.headers.apikey,'secret');
    const args=JSON.parse(init.body);assert.equal(args.p_actor,uid);
    if(url.endsWith('/read_alibaba_self_target')) return denied ? Response.json({code:'42501'},{status:403}) : Response.json({user_id:uid,buyer_name:'孙杰',account_code:'A',version,pool_status:pending?'pending_purchase':'submitted_to_pool'});
    if(url.endsWith('/save_alibaba_order_draft')) { assert.deepEqual(args.p_order_ids,[]);commits++;return Response.json({version:1}); }
    assert.ok(url.endsWith('/commit_alibaba_purchase_snapshot'));commits++;
    assert.equal(args.p_account_code,'A');assert.equal(args.p_buyer_user_id,uid);assert.equal(args.p_buyer_name,'孙杰');
    return Response.json({version:1});
  };
  const response=out();
  await createAlibabaSelfHandler({env:{...env,VERCEL_ENV:production?'production':'preview',ALIBABA_SELF_SERVICE_ENABLED:enabled?'true':'false'},fetcher,query:async (input,queryEnv)=>{
    assert.equal(queryEnv.ALIBABA_TRACE_ENABLED,'true');assert.equal(queryEnv.ALIBABA_TRACE_STATUS_ENABLED,'true');assert.equal(queryEnv.ALIBABA_TRACE_PILOT_ORDER_ID,input.orderId);
    queries++;assert.equal(input.account,'A');
    if(queryFailure) throw new AlibabaError('ORDER_NOT_OWNED',403);
    return {orderId:input.orderId,shipments:[{logisticsId:'LP1',rawStatus:'SIGN'}]};
  }})(draft?{...req,body:{...req.body,action:'draft',orderIds:[]}}:req,response);
  return {response,queries,commits};
}
let r=await run();assert.equal(r.response.code,200);assert.equal(r.commits,1);
r=await run({denied:true});assert.equal(r.queries,0);assert.equal(r.commits,0);
r=await run({version:2});assert.equal(r.response.body.error,'LINK_CHANGED');assert.equal(r.queries,0);
r=await run({queryFailure:true});assert.equal(r.commits,0);
r=await run({role:'viewer'});assert.equal(r.response.code,403);assert.equal(r.queries,0);
r=await run({production:true});assert.equal(r.response.code,404);assert.equal(r.queries,0);
console.log('PASS: self-service identity/account derived server-side, denied ownership before API, version conflicts, no writes on query failure, viewer denial, production disabled. SQL awaits execution.');

r=await run({draft:true,pending:true});assert.equal(r.response.code,200);assert.equal(r.queries,0);assert.equal(r.commits,1);
r=await run({pending:true});assert.equal(r.response.body.error,'PURCHASE_NOT_SUBMITTED');assert.equal(r.queries,0);assert.equal(r.commits,0);

r=await run({production:true,enabled:true});assert.equal(r.response.code,200);assert.equal(r.commits,1);
