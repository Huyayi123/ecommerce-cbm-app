import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
function compile(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let code = ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  code = code.replace(/import ['"][^'"]+\.css['"];?/g,'');
  code = code.replace(/from (['"])([^'"]+)\1/g,(_match,quote,specifier)=> {
    const target = specifier.startsWith('.') ? compile(new URL(`${specifier}.ts`,url)) : pathToFileURL(require.resolve(specifier)).href;
    return `from ${quote}${target}${quote}`;
  });
  const encoded=`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;cache.set(url.href,encoded);return encoded;
}
const { PurchaseLogisticsBadge: Badge } = await import(compile(new URL('../src/components/PurchaseLogisticsBadge.tsx',import.meta.url)));
const link={purchase_record_id:'p1',account_code:'B',order_ids:['5127369483007127225'],version:1};
const summary={purchase_record_id:'p1',link_version:1,status:'returned_signed',last_success_at:'2026-10-21T02:50:24Z',sync_error:null,detail:'已返回物流单全部签收（1/1）；整笔采购完整性待确认'};
const html=(props={})=>renderToStaticMarkup(Badge({buyer:'胡雅怡',link,summary,...props}));
assert.doesNotMatch(html(),/账号B|最近同步|已签收（1\/1）/);assert.doesNotMatch(html(),/整笔采购完整性待确认/);assert.match(html(),/alibaba-status-neutral/);
assert.match(html({summary:{...summary,status:'partial_signed',detail:'部分签收（1\/3）',signed_at:'2026-10-19T03:26:06.000Z'}}),/部分签收（1\/3）/);
assert.match(html({summary:{...summary,status:'logistics_cancelled'}}),/物流单已撤销/);
assert.match(html({summary:{...summary,status:'NEW_STATUS',detail:null}}),/暂不可判断/);
assert.doesNotMatch(html({summary:{...summary,link_version:0}}),/整笔采购完整性待确认/);
assert.match(html({summary:{...summary,link_version:0}}),/待验证 \/ 待同步/);
assert.match(html({unavailable:true}),/签收待轨迹核验/);
assert.doesNotMatch(html({unavailable:true}),/查询失败|同步/);
assert.equal(html({link:undefined,summary:undefined}),'');
assert.match(html(),/暂无明确签收事件时间/);
assert.match(html({summary:{...summary,signed_at:'2026-10-19T03:26:06.000Z'}}),/签收时间 2026-10-19 11:26/);
assert.match(html({summary:{...summary,signed_at:null,latest_trace_at:'2026-10-19T03:26:06.000Z'}}),/最新轨迹时间 2026-10-19 11:26/);
assert.doesNotMatch(html({summary:{...summary,signed_at:null,latest_trace_at:'2026-10-19T03:26:06.000Z'}}),/签收时间/);
assert.match(html({summary:{...summary,status:'partial_signed',signed_at:'2026-10-19T03:26:06.000Z'}}),/最近签收时间/);
assert.doesNotMatch(html({summary:{...summary,link_version:0,signed_at:'2026-10-19T03:26:06.000Z'}}),/2026-10-19/);
assert.match(html({summary:{...summary,signed_at:'not-a-date'}}),/暂无明确签收事件时间/);
assert.match(html({summary:undefined,unavailable:true}),/暂不可查询/);
assert.match(html({summary:{...summary,status:'buyer_pickup'}}),/买家自提.*提货完成情况未确认/);
assert.doesNotMatch(html({summary:{...summary,status:'buyer_pickup'}}),/签收时间/);
assert.match(html({summary:{...summary,status:'awaiting_shipment'}}),/待发货.*尚无物流信息/);
assert.doesNotMatch(html({summary:{...summary,detail:'<script>bad</script>'}}),/script/);
console.log('PASS: saved snapshot badge, partial signatures, unknown states, stale association isolation, failure retention and escaped detail.');

for (const [status,tone] of Object.entries({in_transit:'transit',accepted:'accepted',partial_signed:'partial',pickup_failed:'error',sign_exception:'error',logistics_cancelled:'cancelled'})) assert.match(html({summary:{...summary,status,signed_at:'2026-10-19T03:26:06.000Z'}}),new RegExp('alibaba-status-'+tone));
