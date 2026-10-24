import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/utils/alibabaStatus.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { summarizeAlibabaShipments: summarize, preserveAlibabaSnapshot: preserve } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const orderId = '5127545990003263618';
const scope = { accountCode: 'A', orderIds: [orderId], associationComplete: true, allGoodsShipped: true, allOrdersQueried: true };
const shipments = (...codes) => codes.map((rawStatus, i) => ({ accountCode: 'A', orderId, logisticsId: `LP${i}`, rawStatus }));
assert.equal(summarize(shipments('SIGN','TRANSPORT','TRANSPORT'), scope).status, 'partial_signed');
assert.equal(summarize(shipments('SIGN','TRANSPORT','TRANSPORT'), scope).signed_count, 1);
assert.equal(summarize(shipments('SIGN','SIGN','SIGN'), scope).status, 'signed');
for (const key of ['associationComplete','allGoodsShipped','allOrdersQueried']) {
  assert.equal(summarize(shipments('SIGN'), { ...scope, [key]: false }).status, 'returned_signed');
}
assert.equal(summarize(shipments('SIGN'), { ...scope, orderIds: [orderId, '999'] }).status, 'returned_signed');
assert.equal(summarize([], scope).status, 'unknown');
assert.equal(summarize(shipments('NEW_STATUS'), scope).status, 'unknown');
assert.equal(summarize(shipments('SIGN','NEW_STATUS'), scope).unknown_count, 1);
assert.notEqual(summarize(shipments('SIGN','UNSIGN'), scope).status, 'signed');
assert.equal(summarize(shipments('CANCEL'), scope).status, 'logistics_cancelled');
assert.equal(summarize(shipments('ACCEPT'), scope).status, 'accepted');
assert.equal(summarize(shipments('WAITACCEPT'), scope).status, 'unaccepted');
assert.equal(summarize(shipments('NOGET'), scope).status, 'pickup_failed');
assert.equal(summarize(shipments('UNSIGN'), scope).status, 'sign_exception');
const one = shipments('SIGN');
assert.equal(summarize([...one, ...one], scope).shipment_count, 1);
assert.throws(() => summarize([...one, { ...one[0], rawStatus: 'TRANSPORT' }], scope));
assert.throws(() => summarize([{ ...one[0], accountCode: 'B' }], scope));
assert.throws(() => summarize([{ ...one[0], orderId: Number(orderId) }], scope));
assert.throws(() => summarize([{ ...one[0], orderId: '999' }], scope));
assert.throws(() => summarize([{ ...one[0], logisticsId: '' }], scope));
const previous = { link_version: 2, status: 'in_transit', last_success_at: '2026-10-20T01:00:00Z', shipment_count: 3 };
const failed = preserve(previous, 2, '2026-10-20T02:00:00Z');
assert.equal(failed.status, previous.status);
assert.equal(failed.last_success_at, previous.last_success_at);
assert.equal(failed.shipment_count, 3);
assert.equal(preserve(previous, 3, '2026-10-20T02:00:00Z').last_success_at, null);
// No combination containing a non-SIGN state can become fully signed.
for (const a of ['SIGN','TRANSPORT','CANCEL','UNSIGN','NOGET','WAITACCEPT','ACCEPT','NEW']) {
  for (const b of ['SIGN','TRANSPORT','CANCEL','UNSIGN','NOGET','WAITACCEPT','ACCEPT','NEW']) {
    assert.equal(summarize(shipments(a,b), scope).status === 'signed', a === 'SIGN' && b === 'SIGN');
  }
}
console.log('PASS: official status mapping, partial signatures, coverage gates, duplicate/conflict handling, account isolation and failed snapshot preservation.');
