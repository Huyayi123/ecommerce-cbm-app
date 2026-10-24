import { authorizeAdmin } from './alibaba-test.js';
import { AlibabaError, queryAlibabaLogistics } from './_lib/alibabaClient.js';
import { createPurchaseSnapshot } from './_lib/alibabaSnapshot.js';
import { classifyAlibabaFailure } from './_lib/alibabaFailure.js';

export const config = { maxDuration: 120 };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function createAlibabaSyncHandler({env=process.env,fetcher=fetch,query=queryAlibabaLogistics,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  return async(request,response)=>{
    response.setHeader('Cache-Control','no-store, private');
    if(env.VERCEL_ENV!=='production'||env.ALIBABA_SELF_SERVICE_ENABLED!=='true')return response.status(404).json({error:'NOT_AVAILABLE'});
    // Incident stop: opt-in only after the database load issue is resolved.
    // This check precedes all DB/Auth/network work, including worker requests.
    const readOnlyStatus=request.method==='POST'&&request.body?.action==='status'&&uuid(request.body.runId)&&request.body.workerToken===undefined;
    if(env.ALIBABA_BATCH_SYNC_ENABLED!=='true'&&!readOnlyStatus)return response.status(503).json({error:'SYNC_PAUSED'});
    if(request.method!=='POST')return response.status(405).json({error:'METHOD_NOT_ALLOWED'});
    try{
      if(!String(request.headers['content-type']??'').startsWith('application/json'))throw new AlibabaError('INVALID_INPUT',400);
      const body=request.body;
      if(!body||typeof body!=='object'||Array.isArray(body))throw new AlibabaError('INVALID_INPUT',400);
      const base=env.SUPABASE_URL||env.VITE_SUPABASE_URL;
      let origin;try{const u=new URL(base);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error();origin=u.origin;}catch{throw new AlibabaError('SUPABASE_CONFIG_MISSING',503);}
      if(!env.SUPABASE_SERVICE_ROLE_KEY)throw new AlibabaError('SUMMARY_WRITE_CONFIG_MISSING',503);
      const rpc=async(name,args)=>{
        const upstream=await fetcher(`${origin}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
          headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
        if(!upstream.ok){let code;try{code=(await upstream.json()).code;}catch{/* No upstream messages. */}
          const error=new AlibabaError(code==='PGRST202'?'BATCH_SYNC_NOT_INSTALLED':code==='55000'?'SYNC_PAUSED':code==='22023'?'SYNC_MODE_CHANGED':code==='55P03'?'SYNC_BUSY':code==='57014'?'SYNC_DATABASE_TIMEOUT':code==='42501'?'SYNC_FORBIDDEN':'SYNC_REJECTED',code==='PGRST202'||code==='55000'?503:409);
          if(typeof code==='string'&&/^[A-Z0-9]{5,10}$/.test(code))error.databaseCode=code;throw error;}
        // PostgreSQL void RPCs may return 204 or an empty successful body.
        // Only finish/continue may omit a result; data RPCs must still parse JSON.
        if(name==='finish_alibaba_sync_item_v2'||name==='continue_alibaba_sync_v2'){
          const body=await upstream.text();
          return body.trim()?JSON.parse(body):null;
        }
        return upstream.json();
      };
      if(body.workerToken!==undefined){
        if(!uuid(body.workerToken))throw new AlibabaError('INVALID_INPUT',400);
        // DB-issued, private, short-lived capability consumed exactly once.
        const batch=await rpc('claim_alibaba_sync_v2',{p_token:body.workerToken});
        if(batch?.protocol!==2||batch.fulfillmentProtocol!==1||!uuid(batch.runId)||!uuid(batch.claimId)||batch.claimId.toLowerCase()!==body.workerToken.toLowerCase()||!Array.isArray(batch.items)||batch.items.length>1)throw new AlibabaError('SYNC_REJECTED',409);
        const deadline=Date.now()+45000;
        for(const item of batch.items){
          let snapshot={failure_code:'INVALID_TARGET',retryable:false},failed=true;
          if(item.valid===true&&['A','B'].includes(item.account)&&Array.isArray(item.orderIds)&&item.orderIds.length>0&&item.orderIds.length<=3
            &&[undefined,null,'awaiting_shipment'].includes(item.fulfillmentContext)
            &&(item.fulfillmentContext!=='awaiting_shipment'||item.orderIds.length===1)
            &&item.orderIds.every(id=>typeof id==='string'&&/^[1-9]\d{0,29}$/.test(id))){
            try{const results=[];for(const orderId of item.orderIds){await pause(1000);results.push(await query({account:item.account,orderId,deadline,batchTrace:true,fulfillmentContext:item.fulfillmentContext??null},
              {...env,ALIBABA_TRACE_ENABLED:'true',ALIBABA_TRACE_STATUS_ENABLED:'true'},fetcher));}
              snapshot=createPurchaseSnapshot(results);failed=false;
            }catch(error){snapshot=classifyAlibabaFailure(error);/* No raw error details and no automatic retry. */}
          }
          await rpc('finish_alibaba_sync_item_v2',{p_claim:batch.claimId,p_run:batch.runId,p_record:item.recordId,p_version:item.version,p_snapshot:snapshot,p_failed:failed});
        }
        await rpc('continue_alibaba_sync_v2',{p_run:batch.runId,p_claim:batch.claimId});
        return response.status(200).json({ok:true});
      }
      const ctx=await authorizeAdmin(request,env,fetcher,['owner','admin','buyer']);
      if(body.action==='start'){
        if(body.expectedRecordLimit!==null&&body.expectedRecordLimit!==5)throw new AlibabaError('INVALID_INPUT',400);
        const policy=await rpc('alibaba_sync_policy_v2',{p_actor:ctx.userId});
        if(policy?.protocol!==2||policy.fulfillmentProtocol!==1)throw new AlibabaError('BATCH_SYNC_NOT_INSTALLED',503);
        if(policy.manualEnabled!==true)throw new AlibabaError('SYNC_PAUSED',503);
        if(env.ALIBABA_BATCH_PILOT_LIMIT==='5'&&(body.expectedRecordLimit!==5||policy.recordLimit!==5||policy.autoEnabled!==false))throw new AlibabaError('SYNC_MODE_CHANGED',409);
        if(env.ALIBABA_BATCH_PILOT_LIMIT==='all'&&(body.expectedRecordLimit!==null||policy.recordLimit!==null||policy.autoEnabled!==false))throw new AlibabaError('SYNC_MODE_CHANGED',409);
        const run=await rpc('start_alibaba_sync_v2',{p_actor:ctx.userId,p_expected_limit:body.expectedRecordLimit});
        if(run?.protocol!==2||!uuid(run.runId))throw new AlibabaError('SYNC_REJECTED',409);
        return response.status(200).json({ok:true,runId:run.runId,state:run.state,recordLimit:run.recordLimit??null});
      }
      if(body.action==='status'&&uuid(body.runId)){
        const progress=await rpc('alibaba_sync_progress_v2',{p_actor:ctx.userId,p_run:body.runId});
        if(progress?.protocol!==2)throw new AlibabaError('BATCH_SYNC_NOT_INSTALLED',503);
        return response.status(200).json({ok:true,state:progress.state,recordLimit:progress.recordLimit??null,stopReason:progress.stopReason??null,total:progress.total,success:progress.success,failed:progress.failed,skipped:progress.skipped});
      }
      throw new AlibabaError('INVALID_INPUT',400);
    }catch(error){return response.status(error instanceof AlibabaError?error.status:502).json({error:error instanceof AlibabaError?error.code:'SYNC_UNAVAILABLE',...(error.databaseCode?{databaseCode:error.databaseCode}:{})});}
  };
}
export default createAlibabaSyncHandler();
