// Context comes only from the server's exact, user-confirmed pilot mapping.
export function noCourierResult(result, fulfillment) {
  return {...result,fulfillment:{type:fulfillment,source:'user_confirmed_pilot_and_api_no_logistics'},
    shipments:result.shipments.map(item=>({...item,effectiveStatus:fulfillment==='buyer_pickup'?'BUYER_PICKUP':'UNKNOWN',
      statusSource:'confirmed_non_courier_context',signedAt:null,signedAtSource:null,latestTraceAt:null}))};
}
