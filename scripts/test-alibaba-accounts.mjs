import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/utils/alibabaAccounts.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { alibabaAccountForBuyer, parseAlibabaOrderIds } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
for (const buyer of ['孙杰','章瀚成','李靖阳','伍菊开','梁潘','黄柏钧']) assert.equal(alibabaAccountForBuyer(buyer), 'A');
for (const buyer of ['胡雅怡','彭志红']) assert.equal(alibabaAccountForBuyer(buyer), 'B');
for (const buyer of ['', '未配置', '__proto__', 'constructor']) assert.equal(alibabaAccountForBuyer(buyer), null);
assert.deepEqual(parseAlibabaOrderIds('5127862033052018519，5127862033052018519\n5127800400034009337'), ['5127862033052018519','5127800400034009337']);
for (const input of ['https://1688.com/123', '123e4', '-12', '123.5', '0']) assert.throws(() => parseAlibabaOrderIds(input));
assert.throws(() => parseAlibabaOrderIds(Array(31).fill('123').join(',')));
assert.deepEqual(parseAlibabaOrderIds(''), []);
console.log('PASS: 8 buyer mappings, unknown buyer isolation, exact large IDs, deduplication and invalid input rejection.');
