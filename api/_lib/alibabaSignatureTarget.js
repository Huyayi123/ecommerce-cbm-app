import {AlibabaError} from './alibabaClient.js';

// One user-confirmed SKU and order pair. Never select
// a historical purchase by SKU alone or scan upstream orders to find a match.
export async function resolveAlibabaSignatureTarget(ctx,env,fetcher) {
  const read=async(table,filters)=>{
    const url=new URL(`${ctx.origin}/rest/v1/${table}`);
    for(const [key,value] of Object.entries(filters))url.searchParams.set(key,value);
    const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{
      apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Accept:'application/json'}});
    if(!response.ok)throw new AlibabaError('PILOT_TARGET_READ_FAILED',409);
    const rows=await response.json();if(!Array.isArray(rows))throw new AlibabaError('PILOT_TARGET_READ_FAILED',409);return rows;
  };
  const purchases=await read('purchase_records',{select:'id,sku',sku:'eq.9902306307429',order:'id',limit:'21'});
  if(purchases.length>20)throw new AlibabaError('SIGNATURE_MATCH_TOO_BROAD',409);
  if(!purchases.length)throw new AlibabaError('SIGNATURE_MATCH_NOT_FOUND',409);
  if(purchases.some(row=>typeof row.id!=='string'||!row.id||row.id.length>200||/[\u0000-\u001f\u007f]/.test(row.id)||row.sku!=='9902306307429'))throw new AlibabaError('PILOT_TARGET_READ_FAILED',409);
  // purchase_records.id is text, including legacy imported IDs. Quote each
  // PostgREST literal so commas, parentheses, quotes and backslashes stay data.
  const ids=`in.(${purchases.map(row=>'"'+row.id.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',')})`;
  const links=await read('alibaba_purchase_links',{select:'purchase_record_id,account_code,order_ids,version',purchase_record_id:ids,limit:'21'});
  const matched=links.filter(link=>purchases.some(row=>row.id===link.purchase_record_id)
    &&['A','B'].includes(link.account_code)&&Array.isArray(link.order_ids)&&link.order_ids.length===1
    &&link.order_ids[0]==='5127371247091045347'&&Number.isSafeInteger(link.version)&&link.version>=0);
  if(matched.length!==1)throw new AlibabaError(matched.length?'SIGNATURE_MATCH_AMBIGUOUS':'SIGNATURE_MATCH_NOT_FOUND',409);
  const link=matched[0];
  return {recordId:link.purchase_record_id,version:link.version,orderId:link.order_ids[0],account:link.account_code,
    sku:'9902306307429',logisticsId:'LP00850774122879',matchSource:'user_confirmed_sku_order_link'};
}
