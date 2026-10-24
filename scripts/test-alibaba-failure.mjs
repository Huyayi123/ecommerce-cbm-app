import assert from 'node:assert/strict';
import {classifyAlibabaFailure} from '../api/_lib/alibabaFailure.js';
for(const [code,category,retryable] of [
 ['ALIBABA_NETWORK_ERROR','NETWORK',true],['ALIBABA_RATE_LIMIT','RATE_LIMIT',true],
 ['ORDER_NOT_OWNED','ORDER_OWNERSHIP',false],['ALIBABA_AUTH_REJECTED','AUTHORIZATION',false],
 ['ALIBABA_CONFIG_MISSING','CONFIGURATION',false],['UNEXPECTED_RESPONSE','RESPONSE_FORMAT',false],
 ['ALIBABA_TRACE_UNAVAILABLE','TRACE_UNAVAILABLE',false],['PRIVATE_TOKEN','UNCLASSIFIED',false],
]){
 const result=classifyAlibabaFailure({code,message:'PRIVATE_ADDRESS_PRIVATE_TOKEN'});
 assert.deepEqual(result,{failure_code:category,retryable});assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
}
assert.deepEqual(classifyAlibabaFailure(null),{failure_code:'UNCLASSIFIED',retryable:false});
console.log('PASS: allowlisted failure categories, explicit retry policy and no raw errors/credentials retained.');
