import { authorizeAdmin } from './alibaba-test.js';
import { AlibabaError, queryAlibabaLogistics } from './_lib/alibabaClient.js';
import { createPurchaseSnapshot } from './_lib/alibabaSnapshot.js';
import { classifyAlibabaFailure } from './_lib/alibabaFailure.js';
import { resolveAlibabaSignatureTarget } from './_lib/alibabaSignatureTarget.js';

export function createAlibabaSelfHandler({ env = process.env, fetcher = fetch, query = queryAlibabaLogistics } = {}) {
  let nextAllowedAt = 0;
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, private');
    if (env.VERCEL_ENV !== 'preview' && !(env.VERCEL_ENV === 'production' && env.ALIBABA_SELF_SERVICE_ENABLED === 'true')) return response.status(404).json({ error: 'NOT_AVAILABLE' });
    if (request.method !== 'POST') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    const pilotRequest=['diagnose','applyDiagnostic','failureProbe','applyFulfillment','diagnoseRunItem','applyRunItem','resolveSignatureRecord','diagnoseUnlinkedAcceptance'].includes(request.body?.action);
    let diagnosticStage='authorization',writeAttempted=false;
    try {
      const queryDeadline = Date.now() + 42000;
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new AlibabaError('INVALID_INPUT', 400);
      const ctx = await authorizeAdmin(request, env, fetcher, pilotRequest?['owner','admin']:['owner','admin','buyer']);
      const body = request.body;
      diagnosticStage='request_validation';
      if(body?.action==='diagnoseUnlinkedAcceptance'){
        if(!['5127876109006072034','5127778440001026842'].includes(body.orderId)
          ||body.account!==undefined||body.recordId!==undefined||body.expectedVersion!==undefined)throw new AlibabaError('INVALID_INPUT',400);
        if(Date.now()<nextAllowedAt)throw new AlibabaError('WAIT_BEFORE_RETRY',429);
        nextAllowedAt=Date.now()+15000;
        diagnosticStage='upstream_query';
        const result=await query({account:'B',orderId:body.orderId,deadline:queryDeadline},
          {...env,ALIBABA_TRACE_ENABLED:'true',ALIBABA_TRACE_STATUS_ENABLED:'true',ALIBABA_TRACE_PILOT_ORDER_ID:body.orderId},fetcher);
        return response.status(200).json({ok:true,readOnly:true,applied:false,canApply:false,
          diagnostic:{...result.correspondence,orderId:body.orderId,account:'B',accountSource:'user_confirmed_unlinked_pilot',
            proposedSummary:createPurchaseSnapshot([result])}});
      }
      if(body?.action==='resolveSignatureRecord'){
        if(!env.SUPABASE_SERVICE_ROLE_KEY)throw new AlibabaError('SUMMARY_WRITE_CONFIG_MISSING',503);
        diagnosticStage='target_validation';
        return response.status(200).json({ok:true,readOnly:true,target:await resolveAlibabaSignatureTarget(ctx,env,fetcher)});
      }
      if (!body || typeof body.recordId !== 'string' || !body.recordId || body.recordId.length > 200
        || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0
        || !Array.isArray(body.orderIds) || (body.action !== 'draft' && body.orderIds.length < 1) || body.orderIds.length > 3
        || body.orderIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,29}$/.test(id))) throw new AlibabaError('INVALID_INPUT', 400);
      if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new AlibabaError('SUMMARY_WRITE_CONFIG_MISSING', 503);
      const rpc = async (name, args) => {
        const upstream = await fetcher(`${ctx.origin}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!upstream.ok) {
          let code; try { code = (await upstream.json()).code; } catch { /* Never expose database messages. */ }
          throw new AlibabaError(code === 'PGRST202' ? 'SELF_SERVICE_RPC_MISSING' : code === '40001' ? 'LINK_CHANGED' : 'SELF_SERVICE_DENIED', code === 'PGRST202' ? 503 : 409);
        }
        return upstream.json();
      };
      if (['diagnose','applyDiagnostic','failureProbe','applyFulfillment','diagnoseRunItem','applyRunItem'].includes(body.action)) {
        const runItem=['diagnoseRunItem','applyRunItem'].includes(body.action);
        const shipmentScope=runItem&&body.signatureScope==='sku_logistics';
        const failedTargets={
          '5127554054006090539':'aa66308b-46d0-4928-86ca-b8441c2caa61',
          '5127881617007009337':'ab6fdb15-1d16-4e9b-8838-1f4f38851c58',
        };
        // Earlier open pages use applyDiagnostic for the same update button.
        // Route only the two exact known targets through the fulfillment gate
        // and RPC; never loosen their account/record/version/evidence checks.
        const fulfillmentApply=body.action==='applyFulfillment'
          || (body.action==='applyDiagnostic'&&body.orderIds.length===1&&Object.hasOwn(failedTargets,body.orderIds[0]));
        const apply = body.action === 'applyDiagnostic'||body.action==='applyRunItem'||fulfillmentApply;
        const acceptanceReadOnly=['5127876109006072034','5127778440001026842'].includes(body.orderIds[0]);
        if(acceptanceReadOnly&&apply)throw new AlibabaError('PILOT_WRITE_PAUSED',503);
        const probe=body.action==='failureProbe'||fulfillmentApply;
        diagnosticStage='pilot_scope';
        if (apply && env[fulfillmentApply?'ALIBABA_FULFILLMENT_PILOT_WRITE_ENABLED':'ALIBABA_TRACE_PILOT_WRITE_ENABLED'] !== 'true') throw new AlibabaError('PILOT_WRITE_PAUSED',503);
        const allowed = probe ? Object.keys(failedTargets) : ['5127369483007127225', '5127377259011018519', '5127876109006072034', '5127778440001026842'];
        if (body.orderIds.length !== 1 || (!runItem&&!allowed.includes(body.orderIds[0]))) throw new AlibabaError('INVALID_INPUT',400);
        if(runItem&&!shipmentScope&&(body.runId!=='813bae8c-543c-45c5-b144-e0f38ba4f388'||body.expectedVersion!==1
          ||!['05953a12-dd06-479f-aed6-e49d31fa1f64','95b0312f-8d2b-4b87-9425-35a4a3665c9a','9c787ef6-bcfb-4fa6-b511-ce5fa3ec64f9'].includes(body.recordId)))throw new AlibabaError('LINK_CHANGED',409);
        if(probe&&(body.recordId!==failedTargets[body.orderIds[0]]||body.expectedVersion!==1))throw new AlibabaError('LINK_CHANGED',409);
        // This RPC independently requires an owner/admin. Account and IDs are
        // taken from protected links, never from the caller's account claim.
        diagnosticStage='target_validation';
        let resolvedSignature=null;
        if(shipmentScope){
          const resolved=await resolveAlibabaSignatureTarget(ctx,env,fetcher);
          resolvedSignature=resolved;
          if(resolved.recordId!==body.recordId||resolved.version!==body.expectedVersion||resolved.orderId!==body.orderIds[0])throw new AlibabaError('LINK_CHANGED',409);
        }
        const target = await rpc('read_alibaba_refresh_target', {p_actor:ctx.userId,p_record_id:body.recordId});
        if (!target || !['A','B'].includes(target.account_code) || !Array.isArray(target.order_ids)
          || !target.order_ids.includes(body.orderIds[0])) throw new AlibabaError('SELF_SERVICE_DENIED',403);
        if (target.version !== body.expectedVersion) throw new AlibabaError('LINK_CHANGED',409);
        if(resolvedSignature&&resolvedSignature.account!==target.account_code)throw new AlibabaError('LINK_CHANGED',409);
        if(runItem){
          if(target.order_ids.length!==1)throw new AlibabaError('PILOT_REQUIRES_SINGLE_ORDER',409);
          const read=async(table,filters)=>{
            const url=new URL(`${ctx.origin}/rest/v1/${table}`);
            for(const [key,value] of Object.entries({...filters,limit:'2'}))url.searchParams.set(key,value);
            const upstream=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{
              apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Accept:'application/json'}});
            if(!upstream.ok)throw new AlibabaError('PILOT_TARGET_READ_FAILED',409);
            const rows=await upstream.json();if(!Array.isArray(rows)||rows.length!==1)throw new AlibabaError('LINK_CHANGED',409);return rows[0];
          };
          if(!shipmentScope)await read('alibaba_sync_jobs',{select:'record_id',run_id:`eq.${body.runId}`,record_id:`eq.${body.recordId}`,link_version:'eq.1',state:'eq.success'});
          const purchase=await read('purchase_records',{select:'id,sku',id:`eq.${body.recordId}`});
          if(!(shipmentScope?['9902306307429']:['9902348488841','9902306307429']).includes(purchase.sku))throw new AlibabaError('PILOT_SKU_MISMATCH',409);
        }
        if (body.orderIds[0] === '5127377259011018519' && target.account_code !== 'A') throw new AlibabaError('DIAGNOSTIC_ACCOUNT_MISMATCH',409);
        if(probe&&(target.account_code!=='A'||target.order_ids.length!==1))throw new AlibabaError('DIAGNOSTIC_ACCOUNT_MISMATCH',409);
        if (apply && (target.order_ids.length !== 1 || typeof target.user_id !== 'string' || typeof target.buyer_name !== 'string')) throw new AlibabaError('SELF_SERVICE_DENIED',403);
        if (Date.now() < nextAllowedAt) throw new AlibabaError('WAIT_BEFORE_RETRY',429);
        nextAllowedAt = Date.now()+15000;
        const orderId=body.orderIds[0];
        const businessContext=probe?{
          fulfillment:orderId==='5127554054006090539'?'awaiting_shipment':'buyer_pickup',
          source:'user_confirmed_pilot_context',apiVerified:false,
        }:null;
        const attemptedAt=new Date().toISOString();
        let result;
        diagnosticStage='upstream_query';
        try {
          result=await query({account:target.account_code,orderId,deadline:queryDeadline,fulfillmentContext:businessContext?.fulfillment??null},
            {...env,ALIBABA_TRACE_ENABLED:'true',ALIBABA_TRACE_STATUS_ENABLED:'true',ALIBABA_TRACE_PILOT_ORDER_ID:orderId},fetcher);
        }catch(error){
          if(!probe||apply)throw error;
          return response.status(200).json({ok:true,readOnly:true,applied:false,canApply:false,diagnostic:{
            orderId,account:target.account_code,accountSource:'protected_order_link',probeOutcome:'failed_now',
            phase:['details','trace'].includes(error?.phase)?error.phase:'unknown',...classifyAlibabaFailure(error),
            historicalCauseKnown:false,
            businessContext,responseCheck:error?.responseCheck??null,
          }});
        }
        const snapshot=createPurchaseSnapshot([result]);
        diagnosticStage='snapshot_validation';
        if(probe){
          const recognized=['awaiting_shipment','buyer_pickup'].includes(snapshot.status)&&snapshot.evidence.fulfillment?.source==='user_confirmed_pilot_and_api_no_logistics';
          if(apply){
            if(!recognized)throw new AlibabaError('FULFILLMENT_EVIDENCE_CHANGED',409);
            diagnosticStage='snapshot_write';writeAttempted=true;
            await rpc('commit_alibaba_fulfillment_pilot',{p_actor:ctx.userId,p_record_id:body.recordId,
              p_expected_version:body.expectedVersion,p_snapshot:snapshot,p_attempted_at:attemptedAt});
          }
          return response.status(200).json({ok:true,readOnly:!apply,applied:apply,
            canApply:recognized&&env.ALIBABA_FULFILLMENT_PILOT_WRITE_ENABLED==='true',diagnostic:{
              orderId,account:target.account_code,accountSource:'protected_order_link',probeOutcome:'success_now',
              historicalCauseKnown:false,businessContext,proposedSummary:snapshot,
            }});
        }
        if (apply) {
          diagnosticStage='snapshot_write';writeAttempted=true;
          await rpc('commit_alibaba_purchase_snapshot',{
            p_actor:ctx.userId,p_record_id:body.recordId,p_buyer_user_id:target.user_id,
            p_buyer_name:target.buyer_name,p_account_code:target.account_code,p_order_ids:target.order_ids,
            p_expected_version:body.expectedVersion,p_snapshot:snapshot,p_attempted_at:attemptedAt,
          });
        }
        // Only applyDiagnostic can write; both actions are bounded to the pilots.
        return response.status(200).json({ok:true,readOnly:!apply,applied:apply,
          canApply:!acceptanceReadOnly&&env.ALIBABA_TRACE_PILOT_WRITE_ENABLED==='true'&&target.order_ids.length===1,
          diagnostic:result.correspondence
          ? {...result.correspondence,account:target.account_code,accountSource:'protected_order_link',
            proposedSummary:snapshot} : null});
      }
      // Derive all identity/account fields from protected membership and the
      // authenticated user's original record assignment. Ignore client claims.
      const target = await rpc('read_alibaba_self_target', { p_actor: ctx.userId, p_record_id: body.recordId });
      if (!target || target.user_id !== ctx.userId || !['A','B'].includes(target.account_code)) throw new AlibabaError('SELF_SERVICE_DENIED', 403);
      if (target.version !== body.expectedVersion) throw new AlibabaError('LINK_CHANGED', 409);
      if (body.action === 'draft') {
        const saved = await rpc('save_alibaba_order_draft', {p_actor:ctx.userId,p_record_id:body.recordId,p_order_ids:[...new Set(body.orderIds)],p_expected_version:body.expectedVersion});
        return response.status(200).json({ok:true,saved});
      }
      if (!['submitted_to_pool','haichuan_warehouse','sent_to_inventory'].includes(target.pool_status)) throw new AlibabaError('PURCHASE_NOT_SUBMITTED',409);
      if (Date.now() < nextAllowedAt) throw new AlibabaError('WAIT_BEFORE_RETRY', 429);
      nextAllowedAt = Date.now() + 15000;
      const attemptedAt = new Date().toISOString();
      const orderIds = [...new Set(body.orderIds)];
      const results = [];
      for (const orderId of orderIds) results.push(await query({ account: target.account_code, orderId, deadline: queryDeadline },
        {...env,ALIBABA_TRACE_ENABLED:'true',ALIBABA_TRACE_STATUS_ENABLED:'true',ALIBABA_TRACE_PILOT_ORDER_ID:orderId},fetcher));
      const snapshot = createPurchaseSnapshot(results);
      const saved = await rpc('commit_alibaba_purchase_snapshot', {
        p_actor: ctx.userId, p_record_id: body.recordId, p_buyer_user_id: ctx.userId,
        p_buyer_name: target.buyer_name, p_account_code: target.account_code, p_order_ids: orderIds,
        p_expected_version: body.expectedVersion, p_snapshot: snapshot, p_attempted_at: attemptedAt,
      });
      const pilot = env.ALIBABA_TRACE_ENABLED === 'true' && orderIds.length === 1 && orderIds[0] === env.ALIBABA_TRACE_PILOT_ORDER_ID;
      return response.status(200).json({ ok: true, saved: pilot ? { ...saved,
        timeCheck: { parsedSignedAt: snapshot.evidence.signed_at, orders: results.map(item => item.timeCheck ?? null) } } : saved });
    } catch (error) {
      return response.status(error instanceof AlibabaError ? error.status : 502).json({ error: error instanceof AlibabaError ? error.code : 'SERVICE_UNAVAILABLE',
        ...(pilotRequest?{diagnosticStage,writeAttempted}:{}),
      });
    }
  };
}
export default createAlibabaSelfHandler();
