import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync('src/utils/alibabaLogistics.ts','utf8');
const tree=ts.createSourceFile('alibabaLogistics.ts',source,ts.ScriptTarget.Latest,true);
let body;
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='readAll')body=node.getText(tree);ts.forEachChild(node,visit);}
visit(tree);assert.ok(body);
const code=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const rows=Array.from({length:501},(_,index)=>({purchase_record_id:String(index)}));
function reader(error){const calls=[];const client={from(table){return{select(columns){return{order(){return{async range(from,to){calls.push({table,columns,from,to});return columns.includes('signed_at')&&error?{error,data:null}:{error:null,data:rows.slice(from,to+1)};}};}};}};}};return {read:Function('client',code+';return readAll;')(client),calls};}
let test=reader({code:'42703'});assert.deepEqual(await test.read('purchase_logistics_summaries'),rows);
assert.equal(test.calls.length,3);assert.equal(test.calls[0].from,0);assert.equal(test.calls[1].from,0);assert.equal(test.calls[2].from,500);
assert.ok(test.calls[0].columns.includes('signed_at'));assert.ok(!test.calls[2].columns.includes('signed_at'));
test=reader(null);assert.deepEqual(await test.read('purchase_logistics_summaries'),rows);assert.equal(test.calls.length,2);
assert.ok(test.calls.every(call=>call.columns.includes('latest_trace_at')));
for(const code of ['42501','57014','NETWORK']){test=reader({code});await assert.rejects(test.read('purchase_logistics_summaries'),error=>error.code===code);assert.equal(test.calls.length,1);}
test=reader({code:'42703'});assert.deepEqual(await test.read('alibaba_purchase_links'),rows);assert.ok(test.calls.every(call=>!call.columns.includes('signed_at')));
console.log('PASS: actual summary reader before/after migration, same-page legacy retry, complete pagination and no permission/timeout fallback.');
