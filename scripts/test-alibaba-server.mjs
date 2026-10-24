import assert from 'node:assert/strict';
import { AlibabaError, parseDiagnosticInput, queryAlibabaLogistics, signAlibabaRequest, summarizeLogisticsPayload } from '../api/_lib/alibabaClient.js';
import { createAlibabaTestHandler } from '../api/alibaba-test.js';

const orderId = '5127369483007127225';
const env = { VERCEL_ENV: 'preview', SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-test',
  ALIBABA_APP_KEY: '1682587', ALIBABA_APP_SECRET: 'fake-secret', ALIBABA_ACCOUNT_A_ACCESS_TOKEN: 'fake-A', ALIBABA_ACCOUNT_B_ACCESS_TOKEN: 'fake-B', ALIBABA_SYNC_ENABLED: 'false' };
const uid = 'd32f1446-c579-44ec-8a07-d6d888688bc0';
assert.equal(signAlibabaRequest('The quick brown fox jumps over the lazy dog', {}, 'key'), 'DE7C9B85B8B78AA6BC8A7A36F70A90701C9DB4D9');
assert.equal(signAlibabaRequest('p', { b: '2', a: '1', _aop_signature: 'ignored' }, 's'), signAlibabaRequest('p', { a: '1', b: '2' }, 's'));
assert.throws(() => parseDiagnosticInput({ account: 'C', orderId }));
assert.throws(() => parseDiagnosticInput({ account: 'B', orderId: Number(orderId) }));
assert.throws(() => parseDiagnosticInput({ account: 'B', orderId: 'https://example.com' }));
const payload = { success: true, result: [
  { logisticsId: 'LP1', status: 'SIGN', sender: { senderMobile: 'SECRET_PHONE' }, receiver: { receiverAddress: 'SECRET_ADDRESS' }, tradeOrderId: 5127369483007127000 },
  { logisticsId: 'LP2', status: 'TRANSPORT' },
] };
const summary = summarizeLogisticsPayload(payload, orderId);
assert.equal(summary.orderId, orderId);
assert.equal(summary.signedCount, 1);
assert.match(summary.summary, /部分签收/);
assert.equal(summary.coverageConfirmed, false);
assert.doesNotMatch(JSON.stringify(summary), /SECRET_PHONE|SECRET_ADDRESS|tradeOrderId/);
assert.match(summarizeLogisticsPayload({ success: true, result: [payload.result[0]] }, orderId).summary, /完整性待确认/);
assert.equal(summarizeLogisticsPayload({ success: true, result: [{ logisticsId: 'LP', status: 'NEW' }] }, orderId).shipments[0].label, '暂不可判断');
assert.throws(() => summarizeLogisticsPayload({ success: false, errorCode: 'order.nopermission.buyer' }, orderId), (e) => e.code === 'ORDER_NOT_OWNED');
assert.throws(() => summarizeLogisticsPayload({ success: true, result: null }, orderId));

for (const account of ['A', 'B']) {
  let calls = 0;
  const result = await queryAlibabaLogistics({ account, orderId }, env, async (url, init) => {
    calls++;
    assert.match(url, /^https:\/\/gw\.open\.1688\.com\/openapi\/param2\/1\/com\.alibaba\.logistics\/alibaba\.trade\.getLogisticsInfos\.buyerView\/1682587$/);
    assert.doesNotMatch(url, /fake-A|fake-B|access_token/);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('access_token'), account === 'A' ? 'fake-A' : 'fake-B');
    assert.equal(init.body.get('orderId'), orderId);
    assert.equal(init.body.has('logisticsId'), false);
    return Response.json(payload);
  });
  assert.equal(calls, 1);
  assert.equal(result.orderId, orderId);
}
await assert.rejects(queryAlibabaLogistics({ account: 'B', orderId }, { ...env, ALIBABA_ACCOUNT_B_ACCESS_TOKEN: '' }), (e) => e.code === 'ALIBABA_CONFIG_MISSING');
await assert.rejects(queryAlibabaLogistics({ account: 'B', orderId }, env, async () => Response.json({ message: 'fake-secret' }, { status: 401 })), (e) => e.code === 'ALIBABA_AUTH_REJECTED' && !e.message.includes('fake-secret'));
await assert.rejects(queryAlibabaLogistics({ account: 'B', orderId }, env, async () => new Response('x'.repeat(513 * 1024))), (e) => e.code === 'RESPONSE_TOO_LARGE');

function mockResponse() { return { code: 0, body: null, headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
const request = { method: 'POST', headers: { authorization: 'Bearer test-jwt', 'content-type': 'application/json' }, body: { account: 'B', orderId } };
function authFetcher(role = 'admin', enabled = true) {
  return async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-jwt');
    assert.equal(init.headers.apikey, 'anon-test');
    assert.equal(init.method, undefined); // GET only, no production mutations.
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: uid });
    assert.match(String(url), /\/rest\/v1\/alibaba_logistics_users\?/);
    return Response.json([{ user_id: uid, logistics_role: role, enabled }]);
  };
}
let queryCount = 0;
const query = async () => { queryCount++; return summary; };
let response = mockResponse();
await createAlibabaTestHandler({ env: { ...env, VERCEL_ENV: 'production' }, query })(request, response);
assert.equal(response.code, 404); assert.equal(queryCount, 0);
response = mockResponse();
await createAlibabaTestHandler({ env, query })({ ...request, headers: { 'content-type': 'application/json' } }, response);
assert.equal(response.code, 401); assert.equal(queryCount, 0);
for (const role of ['buyer','viewer','logistics']) {
  response = mockResponse();
  await createAlibabaTestHandler({ env, fetcher: authFetcher(role), query })(request, response);
  assert.equal(response.code, 403); assert.equal(queryCount, 0);
}
response = mockResponse();
await createAlibabaTestHandler({ env, fetcher: authFetcher('admin', false), query })(request, response);
assert.equal(response.code, 403); assert.equal(queryCount, 0);
const handler = createAlibabaTestHandler({ env, fetcher: authFetcher(), query });
response = mockResponse(); await handler(request, response);
assert.equal(response.code, 200); assert.equal(response.body.readOnly, true);
assert.equal(response.headers['Cache-Control'], 'no-store, private');
response = mockResponse(); await handler(request, response);
assert.equal(response.code, 429); assert.equal(queryCount, 1);
response = mockResponse();
await createAlibabaTestHandler({ env, fetcher: authFetcher(), query: async () => { throw new Error('fake-secret'); } })(request, response);
assert.equal(response.body.error, 'SERVICE_UNAVAILABLE');
assert.doesNotMatch(JSON.stringify(response.body), /fake-secret/);
assert.ok(new AlibabaError('X') instanceof Error);
console.log('PASS: read-only server auth, preview gate, A/B token isolation, large ID preservation, PII stripping, timeout/size/error boundaries and pilot throttle. Signing protocol still requires real API verification.');
