import assert from 'node:assert/strict';
import {createAlibabaSelfHandler} from '../api/alibaba-self.js';
const uid='d32f1446-c579-44ec-8a07-d6d888688bc0',runId='813bae8c-543c-45c5-b144-e0f38ba4f388';
const env={VERCEL_ENV:'production',ALIBABA_SELF_SERVICE_ENABLED:'true',ALIBABA_TRACE_PILOT_WRITE_ENABLED:'true',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret',ALIBABA_APP_KEY:'1682587',ALIBABA_APP_SECRET:'fake',ALIBABA_ACCOUNT_A_ACCESS_TOKEN:'fake'};
async function check({apply=false,sku='9902348488841',recordId='05953a12-dd06-479f-aed6-e49d31fa1f64',version=1,wrongRun=false,jobMissing=false,role='admin',traceTime='2026-10-19 12:18:15'}={}){
 const orderId='5127000000000000001';let writes=0,queries=0;
 const out={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 const fetcher=async(url,init)=>{
  const path=String(url);
  if(path.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(path.includes('/alibaba_logistics_users?'))return Response.json([{user_id:uid,enabled:true,logistics_role:role}]);
  if(path.endsWith('/read_alibaba_refresh_target'))return role==='admin'?Response.json({account_code:'A',order_ids:[orderId],version,user_id:uid,buyer_name:'PRIVATE'}):Response.json({code:'42501'},{status:403});
  if(path.includes('/alibaba_sync_jobs?')){assert.ok(path.includes('state=eq.success'));assert.equal(init.headers.apikey,'secret');return Response.json(jobMissing?[]:[{record_id:recordId}]);}
  if(path.includes('/purchase_records?'))return Response.json([{id:recordId,sku}]);
  if(path.endsWith('/commit_alibaba_purchase_snapshot')){
   writes++;const args=JSON.parse(init.body);assert.equal(args.p_snapshot.status,'returned_signed');assert.equal(args.p_snapshot.signed_count,1);assert.equal(args.p_snapshot.evidence.signed_at,traceTime==='2026-10-19 12:18:15'?'2026-10-19T04:18:15.000Z':'2026-10-18T06:18:30.000Z');return Response.json({status:'returned_signed'});
  }
  queries++;assert.equal(init.body.get('orderId'),orderId);
  return path.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP1',status:'SIGN'}]}):Response.json({success:true,logisticsTrace:[{logisticsId:'LP1',logisticsSteps:[
    {acceptTime:'2026-10-18 10:00:00',remark:'正在派送'},
    {acceptTime:traceTime,remark:'您的快件由本人签收，如有疑问请联系服务人员。'},
  ]}]});
 };
 await createAlibabaSelfHandler({env,fetcher})({method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:{action:apply?'applyRunItem':'diagnoseRunItem',runId:wrongRun?'wrong':runId,recordId,expectedVersion:1,orderIds:[orderId]}},out);
 assert.doesNotMatch(JSON.stringify(out.body),/PRIVATE|secret|remark/);return {out,writes,queries};
}
let r=await check();assert.equal(r.out.code,200);assert.equal(r.writes,0);assert.equal(r.out.body.diagnostic.proposedSummary.status,'returned_signed');assert.equal(r.out.body.diagnostic.traces[0].latestSteps[0].signedText,true);
for(const options of [{},{sku:'9902306307429',recordId:'95b0312f-8d2b-4b87-9425-35a4a3665c9a',traceTime:'2026-10-18 14:18:30'}]){r=await check({...options,apply:true});assert.equal(r.out.code,200);assert.equal(r.writes,1);}
for(const options of [{sku:'other'},{recordId:'forged'},{version:2},{wrongRun:true},{jobMissing:true},{role:'buyer'}]){r=await check({...options,apply:true});assert.notEqual(r.out.code,200);assert.equal(r.writes,0);assert.equal(r.queries,0);}
console.log('PASS: recipient-signature run-item preview/save, exact run/job/SKU/record/version/admin checks, Shanghai times, privacy and zero-query scope rejection.');
