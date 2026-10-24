import assert from 'node:assert/strict';
import {resolveAlibabaSignatureTarget} from '../api/_lib/alibabaSignatureTarget.js';
import {createAlibabaSelfHandler} from '../api/alibaba-self.js';
const uid='d32f1446-c579-44ec-8a07-d6d888688bc0',record='aabbccdd-1122-4333-8444-123456789abc',other='bbccddee-1122-4333-8444-123456789abc',order='5127371247091045347';
const env={VERCEL_ENV:'production',ALIBABA_SELF_SERVICE_ENABLED:'true',ALIBABA_TRACE_PILOT_WRITE_ENABLED:'true',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'secret',ALIBABA_APP_KEY:'1682587',ALIBABA_APP_SECRET:'fake',ALIBABA_ACCOUNT_B_ACCESS_TOKEN:'fake'};
async function run({mode='valid',action='resolveSignatureRecord',role='admin',target=record}={}){
 let writes=0,queries=0;
 const fetcher=async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname;
  if(path.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(path.endsWith('/alibaba_logistics_users'))return Response.json([{user_id:uid,enabled:true,logistics_role:role}]);
  if(path.endsWith('/purchase_records'))return Response.json(u.searchParams.has('id')?[{id:record,sku:'9902306307429'}]
    :mode==='wide'?Array.from({length:21},()=>({id:record,sku:'9902306307429'}))
      :[{id:record,sku:'9902306307429'},{id:other,sku:'9902306307429'}]);
  if(path.endsWith('/alibaba_purchase_links'))return Response.json([{purchase_record_id:record,account_code:'B',order_ids:[mode==='order-changed'?'1':order],version:2},
    {purchase_record_id:other,account_code:'B',order_ids:[mode==='ambiguous'?order:'9'],version:1}]);
  if(path.endsWith('/purchase_logistics_summaries'))return Response.json([
    {purchase_record_id:record,link_version:mode==='stale'?1:2,evidence:{shipments:[{logisticsId:mode==='missing'?'wrong':'LP00850774122879',orderId:mode==='order-changed'?'1':order}],remark:'PRIVATE'}},
    {purchase_record_id:other,link_version:1,evidence:{shipments:[{logisticsId:mode==='ambiguous'?'LP00850774122879':'OTHER',orderId:'9'}]}},
  ]);
  if(path.endsWith('/read_alibaba_refresh_target'))return Response.json({account_code:'B',order_ids:[order],version:2,user_id:uid,buyer_name:'PRIVATE'});
  if(path.endsWith('/commit_alibaba_purchase_snapshot')){writes++;const args=JSON.parse(init.body);assert.equal(args.p_account_code,'B');assert.equal(args.p_record_id,record);assert.equal(args.p_expected_version,2);assert.equal(args.p_snapshot.status,'returned_signed');return Response.json({status:'returned_signed'});}
  queries++;assert.equal(init.body.get('orderId'),order);
  return path.includes('getLogisticsInfos')?Response.json({success:true,result:[{logisticsId:'LP00850774122879',status:'SIGN'}]}):Response.json({success:true,logisticsTrace:[{logisticsId:'LP00850774122879',logisticsSteps:[{acceptTime:'2026-10-18 14:18:30',remark:'您的快件由本人签收，如有问题请联系服务人员。'}]}]});
 };
 const out={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await createAlibabaSelfHandler({env,fetcher})({method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:{action,signatureScope:'sku_logistics',recordId:target,expectedVersion:2,orderIds:[order]}},out);
 assert.doesNotMatch(JSON.stringify(out.body),/PRIVATE|secret|remark/);return {out,writes,queries};
}
let r=await run();assert.equal(r.out.code,200);assert.equal(r.out.body.target.recordId,record);assert.equal(r.out.body.target.matchSource,'user_confirmed_sku_order_link');assert.equal(r.queries,0);assert.equal(r.writes,0);
r=await run({action:'applyRunItem'});assert.equal(r.out.code,200);assert.equal(r.writes,1);assert.equal(r.queries,2);assert.equal(r.out.body.diagnostic.proposedSummary.evidence.signed_at,'2026-10-18T06:18:30.000Z');
for(const options of [{mode:'order-changed'},{mode:'ambiguous'},{mode:'wide'},{role:'buyer'},{target:other}]){
 r=await run({...options,action:'applyRunItem'});assert.notEqual(r.out.code,200);assert.equal(r.writes,0);assert.equal(r.queries,0);
}
console.log('PASS: exact SKU plus current logistics/order/version match, duplicate/stale/missing rejection, no SKU-only historical selection, admin-only lookup/save and privacy.');
for(const legacyId of ['purchase_1729000000000_abc','legacy,("quoted")\\record']){
 const quoted='"'+legacyId.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
 const found=await resolveAlibabaSignatureTarget({origin:env.SUPABASE_URL},env,async url=>{
  const u=new URL(String(url));
  if(u.pathname.endsWith('/purchase_records'))return Response.json([{id:legacyId,sku:'9902306307429'},{id:other,sku:'9902306307429'}]);
  assert.equal(u.searchParams.get('purchase_record_id'),`in.(${quoted},"${other}")`);
  if(u.pathname.endsWith('/alibaba_purchase_links'))return Response.json([{purchase_record_id:legacyId,account_code:'B',order_ids:[order],version:2}]);
  return Response.json([{purchase_record_id:legacyId,link_version:2,evidence:{shipments:[{logisticsId:'LP00850774122879',orderId:order}]}}]);
 });
 assert.equal(found.recordId,legacyId);
}
console.log('PASS: legacy text purchase IDs and escaped PostgREST literals retain exact logistics matching.');
