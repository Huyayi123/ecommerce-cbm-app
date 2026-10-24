import { useState } from 'react';
import { saveAlibabaOrderIds, type AlibabaLink } from '../utils/alibabaLogistics';
export function PurchaseLogisticsRefresh({recordId,link,onSaved}:{recordId:string;link:AlibabaLink;onSaved:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function refresh(){setBusy(true);setError('');try{await saveAlibabaOrderIds(recordId,link.order_ids,link.version,'sync');onSaved();}catch(e){setError(e instanceof Error?e.message:'查询失败，请稍后重试。');}finally{setBusy(false);}}
  return <div><button type="button" disabled={busy} onClick={()=>void refresh()}>{busy?'正在查询…':'刷新物流'}</button>{error&&<small role="alert" className="alibaba-error">{error}</small>}</div>;
}
