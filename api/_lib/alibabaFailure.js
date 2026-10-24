// Never persist upstream messages, payloads, URLs or arbitrary error codes.
const failures = Object.freeze({
  ALIBABA_NETWORK_ERROR: ['NETWORK',true],
  ALIBABA_RATE_LIMIT: ['RATE_LIMIT',true],
  ALIBABA_UPSTREAM_ERROR: ['UPSTREAM',false],
  ALIBABA_AUTH_REJECTED: ['AUTHORIZATION',false],
  ORDER_NOT_OWNED: ['ORDER_OWNERSHIP',false],
  ALIBABA_CONFIG_MISSING: ['CONFIGURATION',false],
  ALIBABA_TRACE_UNAVAILABLE: ['TRACE_UNAVAILABLE',false],
  UNEXPECTED_RESPONSE: ['RESPONSE_FORMAT',false],
  RESPONSE_TOO_LARGE: ['RESPONSE_FORMAT',false],
  CONFLICTING_SHIPMENTS: ['RESPONSE_FORMAT',false],
  ALIBABA_QUERY_FAILED: ['UPSTREAM_REJECTED',false],
});
export function classifyAlibabaFailure(error) {
  const known=Object.hasOwn(failures,error?.code) ? failures[error.code] : ['UNCLASSIFIED',false];
  return {failure_code:known[0],retryable:known[1]};
}
