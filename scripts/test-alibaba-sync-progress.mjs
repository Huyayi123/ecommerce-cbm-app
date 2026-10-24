import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const helper=await import('data:text/javascript;base64,'+Buffer.from(compile(fs.readFileSync('src/utils/alibabaSyncProgress.ts','utf8'))).toString('base64'));
assert.equal(helper.ALIBABA_PROGRESS_INTERVAL_MS,15000);
const source=fs.readFileSync('src/components/RefreshAllAlibabaLogistics.tsx','utf8');
const tree=ts.createSourceFile('component.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let pollSource;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='poll')pollSource=node.getText(tree);ts.forEachChild(node,visit);}visit(tree);assert.ok(pollSource);
let requests=0,reloads=0;const scheduled=[],messages=[],busy=[];
const page={visibilityState:'hidden'},running={current:true},alive={current:true};
const states=[
  {state:'running',recordLimit:5,total:2,success:0,failed:0,skipped:0},
  {state:'running',recordLimit:5,total:2,success:1,failed:0,skipped:0},
  {state:'running',recordLimit:5,total:2,success:1,failed:0,skipped:0},
  {state:'complete',recordLimit:5,total:2,success:1,failed:1,skipped:0},
];
const dependencies={alive,document:page,timer:{current:null},running,
  activeRun:{current:'run'},owner:{current:'user'},failures:{current:0},saveAlibabaRun:()=>{},setRecoverable:()=>{},
  ALIBABA_PROGRESS_INTERVAL_MS:helper.ALIBABA_PROGRESS_INTERVAL_MS,
  progressTracker:{current:helper.createAlibabaProgressTracker()},
  setTimeout:(_fn,delay)=>{scheduled.push(delay);return scheduled.length;},
  call:async()=>{requests++;return states.shift();},updated:{current:()=>{reloads++;}},
  setMessage:message=>messages.push(message),setBusy:value=>busy.push(value),
};
const poll=Function(...Object.keys(dependencies),compile(pollSource)+';return poll;')(...Object.values(dependencies));
await poll('run');assert.equal(requests,0);assert.deepEqual(scheduled,[15000]);
page.visibilityState='visible';
await poll('run');assert.equal(requests,1);assert.equal(reloads,0);
await poll('run');assert.equal(reloads,1);
await poll('run');assert.equal(reloads,1);
await poll('run');assert.equal(reloads,2);assert.equal(running.current,false);assert.deepEqual(busy,[false]);
assert.ok(messages.every(message=>message.includes('试运行')));assert.ok(scheduled.every(delay=>delay===15000));
alive.current=false;await poll('run');assert.equal(requests,4);
alive.current=true;dependencies.activeRun.current='run';running.current=true;
dependencies.call=async()=>{throw new TypeError('Failed to fetch');};
const retryPoll=Function(...Object.keys(dependencies),compile(pollSource)+';return poll;')(...Object.values(dependencies));
await retryPoll('run');assert.equal(running.current,true);assert.equal(dependencies.activeRun.current,'run');
assert.match(messages.at(-1),/自动重查/);assert.equal(scheduled.at(-1),15000);
dependencies.call=async()=>({state:'complete',recordLimit:5,total:2,success:1,failed:1,skipped:0});
const recoveredPoll=Function(...Object.keys(dependencies),compile(pollSource)+';return poll;')(...Object.values(dependencies));
await recoveredPoll('run');assert.equal(running.current,false);assert.equal(dependencies.activeRun.current,null);assert.match(messages.at(-1),/失败1笔/);
const store=new Map();globalThis.sessionStorage={getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
const validRun='11111111-1111-4111-8111-111111111111';
helper.saveAlibabaRun('a',validRun);assert.equal(helper.savedAlibabaRun('a'),validRun);assert.equal(helper.savedAlibabaRun('b'),null);
helper.saveAlibabaRun('a',null);assert.equal(helper.savedAlibabaRun('a'),null);
const tracker=helper.createAlibabaProgressTracker();
assert.throws(()=>tracker({state:'running',total:0,success:1,failed:0,skipped:0}),/进度不一致/);
assert.throws(()=>tracker({state:'running',total:1,success:NaN,failed:0,skipped:0}),/格式异常/);
const empty=helper.createAlibabaProgressTracker();
assert.equal(empty({state:'complete',total:0,success:0,failed:0,skipped:0}).reload,true);
assert.equal(empty({state:'complete',total:0,success:0,failed:0,skipped:0}).reload,false);
console.log('PASS: actual progress poll skips hidden/unmounted pages, 15-second interval, no unchanged summary reload, pilot labels, completion/error handling and valid totals.');
