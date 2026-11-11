// Realtime bursts queue only one follow-up pass. Polling can reuse a current
// pass without continuously requesting another full application refresh.
export function createCoalescedLoad(){
  const active=new Map<string,{again:boolean;work:()=>Promise<void>;promise:Promise<void>}>();
  return (key:string,work:()=>Promise<void>,queue=true):Promise<void>=>{
    const existing=active.get(key);
    if(existing){
      if(queue){existing.again=true;existing.work=work;}
      return existing.promise;
    }
    const state={again:false,work,promise:Promise.resolve()};
    // Defer work until after state has been installed, including synchronous failures.
    state.promise=Promise.resolve().then(async()=>{do{state.again=false;await state.work();}while(state.again);}).finally(()=>{if(active.get(key)===state)active.delete(key);});
    active.set(key,state);return state.promise;
  };
}
