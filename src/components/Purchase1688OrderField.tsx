import { useEffect, useRef, useState } from 'react';
import { parseAlibabaOrderIds } from '../utils/alibabaAccounts';
import { saveAlibabaOrderIds, type AlibabaLink } from '../utils/alibabaLogistics';
import { trackAlibabaDraft } from '../utils/alibabaOrderDrafts';
import '../alibaba-logistics.css';

export function Purchase1688OrderField({recordId,link,disabled,onSaved}:{recordId:string;link?:AlibabaLink;disabled:boolean;onSaved:()=>void}) {
  const initial=link?.order_ids.join('\n')??'';
  const [value,setValue]=useState(initial),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  const version=useRef(link?.version??0),savedValue=useRef(initial),active=useRef(true);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{if(!saving){version.current=link?.version??0;if(value===savedValue.current){savedValue.current=initial;setValue(initial);}}},[initial,link?.version]);
  function save(){
    if(disabled||saving||value===savedValue.current)return;
    const text=value;
    const task=(async()=>{
      setSaving(true);setMessage('');
      try {
        const ids=parseAlibabaOrderIds(text);
        if(ids.length>3)throw new Error('每笔最多3个单号。');
        const result=await saveAlibabaOrderIds(recordId,ids,version.current,'draft');
        version.current=result.version;savedValue.current=text;
        if(active.current){setMessage('已保存');onSaved();}
      }catch(error){if(active.current)setMessage(error instanceof Error?error.message:'保存失败');throw error;}
      finally{if(active.current)setSaving(false);}
    })();
    trackAlibabaDraft(recordId,task);
  }
  return <div className="alibaba-order-field"><textarea aria-label="1688单号（选填）" value={value} disabled={disabled||saving} onChange={event=>{setValue(event.target.value);setMessage('');}} onBlur={save} placeholder="选填，多个单号每行一个" rows={2}/><small role="status">{saving?'保存中…':message||'离开输入框保存；提交采购池后读取物流'}</small></div>;
}
