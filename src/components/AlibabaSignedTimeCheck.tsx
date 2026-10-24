import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { saveAlibabaOrderIds } from '../utils/alibabaLogistics';
import { formatLogisticsTime } from './PurchaseLogisticsBadge';

// One known record only. All access and ownership checks remain on the existing
// self-service API; this never submits a purchase or starts a batch run.
const recordId = '2c761850-c683-471e-8977-c206b00422b3';
const orderId = '5127369483007127225';
const signatureRun='813bae8c-543c-45c5-b144-e0f38ba4f388';
const signatureRecords=['05953a12-dd06-479f-aed6-e49d31fa1f64','95b0312f-8d2b-4b87-9425-35a4a3665c9a','9c787ef6-bcfb-4fa6-b511-ce5fa3ec64f9'];
type Result = { status: string; signed_at: string | null; latest_trace_at: string | null };
export function AlibabaSignedTimeCheck() {
  return new URLSearchParams(window.location.search).get('check1688Logistics') === '1'
    ? <AlibabaLogisticsCorrespondenceCheck /> : <SignedTimeCheck />;
}
function AlibabaLogisticsCorrespondenceCheck() {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [order,setOrder]=useState('5127377259011018519');
  const [canApply,setCanApply]=useState(false);
  const [report,setReport]=useState<unknown>(null);
  async function check(apply=false){
    if(!supabase||busy)return;
    setBusy(true);setReport(null);setMessage('');
    try{
      const {data:session,error:sessionError}=await supabase.auth.getSession();
      if(sessionError||!session.session)throw Error('请重新登录。');
      if(['5127876109006072034','5127778440001026842'].includes(order)){
        setCanApply(false);
        const response=await fetch('/api/alibaba-self',{method:'POST',cache:'no-store',signal:AbortSignal.timeout(60000),
          headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.session.access_token}`},
          body:JSON.stringify({action:'diagnoseUnlinkedAcceptance',orderId:order})});
        const payload=await response.json();
        if(!response.ok||payload.ok!==true||payload.readOnly!==true)throw Error(`只读核验未完成（${payload.error??response.status}），请反馈此提示。`);
        setReport(payload.diagnostic);setMessage('账号B只读查询完成，不依赖SKU关联，未保存摘要。请回传结果；连续操作请间隔15秒。');return;
      }
      const runItem=order.startsWith('sku:');
      const shipmentScope=order==='sku:9902306307429';let matchedRecord:string|undefined;
      if(shipmentScope){
        const resolvedResponse=await fetch('/api/alibaba-self',{method:'POST',cache:'no-store',signal:AbortSignal.timeout(30000),
          headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.session.access_token}`},body:JSON.stringify({action:'resolveSignatureRecord'})});
        const resolved=await resolvedResponse.json();
        if(!resolvedResponse.ok||!resolved.ok||!resolved.target)throw Error(`无法按条码与确认订单号唯一匹配（${resolved.error??resolvedResponse.status}）。请反馈此提示；请勿选择其他日期的记录代替。`);
        matchedRecord=resolved.target.recordId;
      }else if(runItem){
        const purchases=await supabase.from('purchase_records').select('id,sku').in('id',signatureRecords).eq('sku',order.slice(4)).limit(2);
        if(purchases.error||purchases.data?.length!==1)throw Error('未找到本次批次内唯一匹配的SKU记录，已停止核验。');
        matchedRecord=purchases.data[0].id;
      }
      const linkQuery=supabase.from('alibaba_purchase_links').select('purchase_record_id,order_ids,version');
      const links=await (runItem?linkQuery.eq('purchase_record_id',matchedRecord!):linkQuery.contains('order_ids',[order])).limit(2);
      if(links.error)throw Error('无法读取订单关联，请使用有物流管理权限的账号。');
      if(links.data?.length!==1)throw Error('未找到唯一且有权访问的订单关联，已停止查询；请反馈此提示。');
      const link=links.data[0];
      if(runItem&&link.order_ids.length!==1)throw Error('这笔关联不是单个订单，已停止单笔核验。');
      const requestedOrder=runItem?link.order_ids[0]:order;
      const failureProbe=['5127554054006090539','5127881617007009337'].includes(order);
      const response=await fetch('/api/alibaba-self',{method:'POST',cache:'no-store',signal:AbortSignal.timeout(60000),
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.session.access_token}`},
        body:JSON.stringify({action:runItem?apply?'applyRunItem':'diagnoseRunItem':apply?failureProbe?'applyFulfillment':'applyDiagnostic':failureProbe?'failureProbe':'diagnose',
          ...(runItem&&!shipmentScope?{runId:signatureRun}:{}),...(shipmentScope?{signatureScope:'sku_logistics'}:{}),
          recordId:link.purchase_record_id,expectedVersion:link.version,orderIds:[requestedOrder]})});
      const payload=await response.json();
      if(!response.ok||payload.ok!==true)throw Object.assign(Error((payload.error==='DIAGNOSTIC_ACCOUNT_MISMATCH'
        ? '该订单应使用1688账号A，但现有关联不符，已停止查询；请反馈此提示。'
        : `单笔核验未完成（${payload.error??response.status}${payload.diagnosticStage?'/'+payload.diagnosticStage:''}），请反馈此提示。`)
        +(payload.writeAttempted===false?' 请求在保存前停止，摘要未改写。':'')),{writeAttempted:payload.writeAttempted});
      if(!payload.diagnostic || (apply ? payload.applied!==true : payload.readOnly!==true))throw Error('未取得完整核验结果。');
      if(apply){
        setCanApply(false);
        const saved=await supabase.from('purchase_logistics_summaries').select('status,signed_at,latest_trace_at,link_version,detail')
          .eq('purchase_record_id',link.purchase_record_id).eq('link_version',link.version).maybeSingle();
        if(saved.error||!saved.data)throw Error('摘要更新请求已成功，但数据库读回未完成，请反馈此提示。');
        setReport({...payload.diagnostic,persistedSummary:saved.data});
        setMessage('这笔物流摘要已更新，并从数据库读回核对。请回传 persistedSummary 结果。');
      }else{
        setReport(payload.diagnostic);setCanApply(payload.canApply===true);
        setMessage(failureProbe?'失败订单只读复验完成，未更新摘要或历史任务。请回传结果；连续操作请间隔15秒。'
          :'只读查询完成，物流摘要未修改。核对后可更新这笔摘要；连续操作请间隔15秒。');
      }
    }catch(error){setMessage((error instanceof Error?error.message:'核验中断。')+(apply&&(error as {writeAttempted?:boolean}).writeAttempted!==false?' 若请求已发出，请先核对数据库结果，勿反复点击。':''));}
    finally{setBusy(false);}
  }
  return <main className="app-shell"><section className="panel">
    <h1>1688 单笔物流状态核验</h1>
    <p>请使用有独立物流管理权限的账号。只读查询不保存摘要；更新按钮仅处理当前这一笔试点订单，不启动批次。</p>
    <p>异常与曾部分签收两笔未关联订单使用已确认的账号B，仅查询不保存。其他订单使用受保护关联账号；实际账号显示在结果的 account 字段。</p>
    <label>订单号 <select value={order} disabled={busy} onChange={event=>{setOrder(event.target.value);setReport(null);setMessage('');setCanApply(false);}}>
      <option value="5127369483007127225">5127369483007127225</option>
      <option value="5127377259011018519">5127377259011018519（原冲突订单）</option>
      <option value="5127876109006072034">5127876109006072034（物流异常核验）</option>
      <option value="5127778440001026842">5127778440001026842（曾部分签收，现全部签收）</option>
      <option value="5127554054006090539">5127554054006090539（待发货，只读）</option>
      <option value="5127881617007009337">5127881617007009337（买家自提，只读）</option>
      <option value="sku:9902348488841">SKU 9902348488841（本次批次签收核验）</option>
      <option value="sku:9902306307429">SKU 9902306307429（订单5127371247091045347）</option>
    </select></label>
    <p><button type="button" className="primary" disabled={busy} onClick={()=>void check()}>{busy?'正在核验…':'只读查询这笔订单'}</button></p>
    {canApply&&<p><button type="button" disabled={busy} onClick={()=>void check(true)}>按最新轨迹更新这笔物流摘要</button></p>}
    <p role="status">{message}</p>
    {report!=null&&<><p>结果仅含物流ID、允许的状态值、时间和语义标记，不含轨迹原文或联系方式。proposedSummary 为计算结果；persistedSummary 为更新后从数据库读回的结果。</p>
      <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(report,null,2)}</pre></>}
    <p><a href="/">返回工作台</a></p>
  </section></main>;
}
function SignedTimeCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState('');
  const [timeCheck, setTimeCheck] = useState<unknown>(null);
  async function check() {
    if (!supabase || busy) return;
    setBusy(true); setMessage(''); setResult(null); setTimeCheck(null);
    try {
      const link = await supabase.from('alibaba_purchase_links').select('order_ids,version').eq('purchase_record_id', recordId).maybeSingle();
      if (link.error) throw new Error('无法读取试点订单，请确认使用胡雅怡账号登录。');
      if (!link.data || link.data.order_ids.length !== 1 || link.data.order_ids[0] !== orderId) throw new Error('试点关联已变化，已停止验证，请反馈此提示。');
      const saved = await saveAlibabaOrderIds(recordId, [orderId], link.data.version, 'sync');
      setTimeCheck(saved.timeCheck ?? null);
      const summary = await supabase.from('purchase_logistics_summaries').select('status,signed_at,latest_trace_at,link_version').eq('purchase_record_id', recordId).eq('link_version', link.data.version).maybeSingle();
      if (summary.error || !summary.data) throw new Error('查询已完成，但无法读取当前版本的时间摘要，请反馈此提示。');
      setResult(summary.data as Result);
      setMessage('单笔物流摘要已更新。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '验证失败，请反馈此提示。'); }
    finally { setBusy(false); }
  }
  return <main className="app-shell"><section className="panel">
    <h1>1688 签收时间验证</h1>
    <p>请使用胡雅怡账号。仅查询 SKU 9902327944610、2026-10-18 的已提交试点记录。</p>
    <p>1688 单号：{orderId}</p>
    <p>点击后读取官方物流与轨迹，并保存这笔物流摘要。不会重新提交采购或刷新其他订单。</p>
    <button type="button" className="primary" disabled={busy || Boolean(result)} onClick={() => void check()}>{busy ? '正在查询，请稍候…' : result ? '已完成验证' : '查询这笔物流时间'}</button>
    <p role="status">{message}</p>
    {result && <div>
      <p>物流状态：{result.status === 'returned_signed' || result.status === 'signed' ? '已签收' : result.status === 'partial_signed' ? '部分签收' : result.status}</p>
      <p>签收时间：{formatLogisticsTime(result.signed_at) ?? '没有明确签收事件时间'}</p>
      <p>最新轨迹时间：{formatLogisticsTime(result.latest_trace_at) ?? '暂无'}</p>
    </div>}
    {timeCheck != null && <div><p>时间解析核验（仅时间与判断结果，不含轨迹原文、姓名或电话）：</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(timeCheck, null, 2)}</pre></div>}
    <p><a href="/">返回工作台</a></p>
  </section></main>;
}
