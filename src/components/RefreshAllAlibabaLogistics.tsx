import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ALIBABA_PROGRESS_INTERVAL_MS, createAlibabaProgressTracker, savedAlibabaRun, saveAlibabaRun } from '../utils/alibabaSyncProgress';
export function RefreshAllAlibabaLogistics({onUpdated}:{onUpdated:()=>void}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true),updated=useRef(onUpdated);
  updated.current=onUpdated;
  const progressTracker=useRef(createAlibabaProgressTracker()),running=useRef(false);
  const owner=useRef<string|null>(null),activeRun=useRef<string|null>(null),failures=useRef(0);
  const [recoverable,setRecoverable]=useState(false);
  const pilot=import.meta.env.VITE_ALIBABA_BATCH_SYNC_PILOT_LIMIT==='5';
  useEffect(()=>{
    alive.current=true;
    async function restore(){
      const {data}=await supabase!.auth.getSession();
      if(!alive.current||!data.session)return;
      owner.current=data.session.user.id;
      const saved=savedAlibabaRun(owner.current);
      if(saved){activeRun.current=saved;running.current=true;setRecoverable(true);setBusy(true);void poll(saved);}
    }
    if(supabase)void restore();
    const subscription=supabase?.auth.onAuthStateChange((_event,session)=>{
      if(owner.current&&session?.user.id!==owner.current){
        clearTimeout(timer.current);owner.current=null;activeRun.current=null;running.current=false;
        setBusy(false);setRecoverable(false);setMessage('登录账号已变化，请在原账号查看物流批次。');
      }
    });
    return()=>{alive.current=false;clearTimeout(timer.current);subscription?.data.subscription.unsubscribe();};
  },[]);
  async function call(body:object){
    if(!supabase)throw Error('数据库连接未配置。');
    const {data}=await supabase.auth.getSession();if(!data.session)throw Object.assign(Error('请重新登录后继续查看批次。'),{code:'LOGIN_REQUIRED'});
    if(owner.current&&owner.current!==data.session.user.id)throw Object.assign(Error('登录账号已变化，请在原账号查看批次。'),{code:'ACCOUNT_CHANGED'});
    owner.current=data.session.user.id;
    const response=await fetch('/api/alibaba-sync',{method:'POST',cache:'no-store',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session.access_token}`},body:JSON.stringify(body)});
    const payload=await response.json();
    if(!response.ok||!payload.ok)throw Object.assign(Error(payload.error==='SYNC_PAUSED'?'物流批量刷新已暂停。':payload.error==='SYNC_MODE_CHANGED'?'同步范围已变化，请刷新页面后再试。':payload.error==='BATCH_SYNC_NOT_INSTALLED'?'批量刷新配置尚未安装。':payload.error==='SYNC_BUSY'?'已有物流批次正在更新，请稍后再试。':payload.error==='SYNC_DATABASE_TIMEOUT'?'数据库查询超时，暂时无法确认批次状态。':payload.error==='SYNC_FORBIDDEN'?'当前账号未获批量刷新权限。':`物流更新暂不可用（${payload.error??response.status}），原状态保留。`),{code:payload.error});
    return payload;
  }
  async function poll(runId:string){
    if(!alive.current)return;
    if(document.visibilityState==='hidden'){
      timer.current=setTimeout(()=>void poll(runId),ALIBABA_PROGRESS_INTERVAL_MS);
      return;
    }
    try{
      const state=await call({action:'status',runId});if(!alive.current||activeRun.current!==runId)return;
      failures.current=0;
      const progress=progressTracker.current(state);
      if(progress.reload)updated.current();
      const scope=state.recordLimit?`物流试运行（最多${state.recordLimit}笔）`:'物流更新';
      setMessage(state.stopReason?`${scope}已停止，未完成记录保留原物流状态，请反馈此提示（${state.stopReason}）。`:progress.complete?`${scope}完成：成功${state.success}笔${state.failed?`，失败${state.failed}笔保留原状态`:''}${state.skipped?`，跳过已变更记录${state.skipped}笔`:''}`:`${scope} ${progress.finished}/${state.total}…`);
      if(progress.complete){if(owner.current)saveAlibabaRun(owner.current,null);activeRun.current=null;setRecoverable(false);setBusy(false);running.current=false;return;}
      timer.current=setTimeout(()=>void poll(runId),ALIBABA_PROGRESS_INTERVAL_MS);
    }catch(error){if(alive.current&&activeRun.current===runId){
      const code=(error as {code?:string}).code;
      if(['LOGIN_REQUIRED','ACCOUNT_CHANGED','ADMIN_REQUIRED','SYNC_FORBIDDEN','SYNC_PAUSED'].includes(code??'')){
        setMessage(error instanceof Error?error.message:'暂时无法查看批次。');setBusy(false);running.current=false;return;
      }
      failures.current++;
      setMessage('暂时无法读取进度，已保留批次编号；将自动重查后台结果，不会新建批次。');
      timer.current=setTimeout(()=>void poll(runId),Math.min(60000,ALIBABA_PROGRESS_INTERVAL_MS*failures.current));
    }}
  }
  async function start(){
    if(running.current)return;
    running.current=true;setBusy(true);
    if(activeRun.current){void poll(activeRun.current);return;}
    progressTracker.current=createAlibabaProgressTracker();
    setMessage(pilot?'正在启动最多5笔物流试运行…':'正在启动全部物流更新…');
    try{
      const run=await call({action:'start',expectedRecordLimit:pilot?5:null});
      if(!/^[0-9a-f-]{36}$/i.test(run.runId))throw Error('批次编号格式异常');
      if(alive.current&&owner.current){activeRun.current=run.runId;saveAlibabaRun(owner.current,run.runId);setRecoverable(true);await poll(run.runId);}
    }catch(error){if(alive.current){
      setMessage((error as {code?:string}).code ? (error as Error).message : '启动响应中断，尚不能确认是否已创建批次。请勿反复启动，需核对后台结果。');
      setBusy(false);running.current=false;
    }}
  }
  return <div><button type="button" disabled={busy||(!recoverable&&import.meta.env.VITE_ALIBABA_BATCH_SYNC_ENABLED!=='true')} onClick={()=>void start()}>{busy?'正在查询物流进度…':recoverable?'继续查看物流批次':pilot?'试运行物流（最多5笔）':'刷新全部物流'}</button>{message&&<small role="status" style={{display:'block',maxWidth:360,whiteSpace:'normal',marginTop:5,color:'#70818d'}}>{message}</small>}</div>;
}
