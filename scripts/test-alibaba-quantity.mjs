import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Load the actual adapter and existing purchase calculation; no duplicated formula.
const cache = new Map();
function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let code = ts.transpileModule(fs.readFileSync(url,'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  code = code.replace(/from (['"])(\.[^'"]+)\1/g, (_match, quote, specifier) => {
    const dependency = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url);
    return `from ${quote}${moduleUrl(dependency)}${quote}`;
  });
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  cache.set(url.href,result); return result;
}
const { candidatePurchaseQuantities: quantity } = await import(moduleUrl(new URL('../src/utils/alibabaPurchaseQuantity.ts',import.meta.url)));
assert.deepEqual(quantity({purchase_quantity:0,confirmed_purchase_quantity:120}), {planned:0,main:120,mixed:0,total:120});
assert.equal(quantity({purchase_quantity:0,carton_count:10,units_per_carton:12,tail_quantity:3}).main,123);
assert.equal(quantity({purchase_quantity:999,confirmed_purchase_quantity:120,manual_purchase_total_quantity:80,carton_count:10,units_per_carton:12}).main,80);
assert.equal(quantity({purchase_quantity:999,confirmed_purchase_quantity:120,manual_purchase_total_quantity:0}).main,0);
assert.equal(quantity({purchase_quantity:999,confirmed_purchase_quantity:0}).main,0);
assert.equal(quantity({purchase_quantity:50,confirmed_purchase_quantity:null,carton_count:null}).main,50);
assert.equal(quantity({purchase_quantity:'0',carton_count:'10',units_per_carton:'12',tail_quantity:'3'}).main,123);
assert.deepEqual(quantity({purchase_quantity:0,confirmed_purchase_quantity:120,mixed_groups:[{id:'g',lines:[{id:'a',quantity:20},{id:'b',quantity:30}]}]}),{planned:0,main:120,mixed:50,total:170});
console.log('PASS: preview quantity uses existing manual/carton/confirmed/planned priority, preserves explicit zero and separates mixed-SKU totals.');
