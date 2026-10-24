import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPurchaseSnapshot } from '../api/_lib/alibabaSnapshot.js';
import { noCourierResult } from '../api/_lib/alibabaFulfillment.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'../.codex-sql-test/node_modules/@electric-sql/pglite/dist/index.js');
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create schema auth;create table auth.users(id uuid primary key,email text,deleted_at timestamptz);
create function auth.uid() returns uuid language sql as 'select null::uuid';
create table public.purchase_records(id text primary key,assigned_buyer_name text,assigned_buyer_email text,pool_status text,status text);
create schema net;create table net.requests(id bigint generated always as identity,body jsonb,url text);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare v_id bigint;begin insert into net.requests(body,url) values(body,url) returning id into v_id;return v_id;end $$;
create schema cron;create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text,active boolean default true);
create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language plpgsql as $$declare v_id bigint;begin insert into cron.job(jobname,schedule,command) values(p_name,p_schedule,p_command) returning jobid into v_id;return v_id;end $$;`);
await db.exec(fs.readFileSync('sql/2026-10-20-alibaba-logistics-foundation.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-20-alibaba-snapshot-rpcs.sql','utf8'));
// Run the actual migration, replacing only unavailable scheduler/network extension installation.
await db.exec(fs.readFileSync('sql/2026-10-21-alibaba-batch-sync.sql','utf8').replace(/^create extension[^;]+;/gm,''));
await db.exec(fs.readFileSync('sql/2026-10-21-alibaba-signed-time.sql','utf8'));
const admin='d32f1446-c579-44ec-8a07-d6d888688bc0',buyer='9401d015-9de4-4e4e-89a4-257c1e8d7028';
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[admin,'admin@test.invalid',buyer,'buyer@test.invalid']);
await db.query("insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code) values($1,'admin',null,null),($2,'buyer','孙杰','A')",[admin,buyer]);
for(const [id,pool,status] of [['pending','pending_purchase','pending'],['waiting','submitted_to_pool','pending'],['transit','submitted_to_pool','pending'],['signed','submitted_to_pool','pending'],['changed','submitted_to_pool','pending'],['cancelled','submitted_to_pool','cancelled'],['wrong','submitted_to_pool','pending']]){
  await db.query('insert into public.purchase_records values($1,$2,$3,$4,$5)',[id,'孙杰',id==='wrong'?'other@test.invalid':'buyer@test.invalid',pool,status]);
  await db.query("insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code) values($1,$2,'A')",[id,buyer]);
  await db.query("insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids) values($1,'A',array['5127369483007127225'])",[id]);
}
await db.exec("insert into public.purchase_logistics_summaries(purchase_record_id,link_version,status,detail,last_success_at) values('transit',1,'in_transit','old-success',now()),('signed',1,'returned_signed','signed',now()),('changed',1,'returned_signed','stale-signature',now());update public.alibaba_purchase_links set version=2 where purchase_record_id='changed';");
const call=async(sql,args=[]) => (await db.query(sql,args)).rows;
try {
const oldRun='7f9e5a3d-3707-46dc-8471-7fca49dc91e3';
await db.query("insert into public.alibaba_sync_runs(id,actor_id,created_at,lease_until) values($1,$2,now()-interval '2 hours',now()-interval '1 hour')",[oldRun,admin]);
await db.query("insert into public.alibaba_sync_jobs(run_id,record_id,link_version,state) values($1,'waiting',1,'pending'),($1,'signed',1,'success')",[oldRun]);
await db.exec('update cron.job set active=false');
const before=await call('select purchase_record_id,status,detail from public.purchase_logistics_summaries order by purchase_record_id');
const migration=fs.readFileSync('sql/2026-10-21-alibaba-batch-recovery.sql','utf8');
await db.exec(migration);await db.exec(migration);
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-failure-categories.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-failure-categories.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-trace-status.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-no-courier-pilot.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-batch-fulfillment.sql','utf8'));
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-batch-fulfillment.sql','utf8'));
assert.deepEqual(await call('select purchase_record_id,status,detail from public.purchase_logistics_summaries order by purchase_record_id'),before);
assert.equal((await call('select state,stop_reason from public.alibaba_sync_runs where id=$1',[oldRun]))[0].stop_reason,'INCIDENT_CANCELLED');
assert.deepEqual((await call('select state from public.alibaba_sync_jobs where run_id=$1 order by record_id',[oldRun])).map(row=>row.state),['success','skipped']);
const policy=(await call('select public.alibaba_sync_policy_v2($1) as result',[admin]))[0].result;
assert.deepEqual(policy,{protocol:2,manualEnabled:false,autoEnabled:false,recordLimit:5,workerSize:1,fulfillmentProtocol:1});
await assert.rejects(db.query('select public.start_alibaba_sync_v2($1)',[admin]),error=>error.code==='55000');
await assert.rejects(db.query('select public.claim_alibaba_sync_v2($1)',[oldRun]),error=>error.code==='55000');
await db.exec('select public.recover_alibaba_sync()');assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,0);
for(const [role,fn,expected] of [['anon','public.start_alibaba_sync_v2(uuid,integer)',false],['authenticated','public.claim_alibaba_sync_v2(uuid)',false],['service_role','public.finish_alibaba_sync_item(uuid,text,integer,jsonb,boolean)',false],['service_role','public.continue_alibaba_sync(uuid)',false],['service_role','public.start_alibaba_sync_v2(uuid,integer)',true]]){
  assert.equal((await call('select has_function_privilege($1,$2,\'execute\') as allowed',[role,fn]))[0].allowed,expected);
}
assert.equal((await call("select has_table_privilege('authenticated','public.alibaba_sync_control','select') as allowed"))[0].allowed,false);
assert.equal((await call("select count(*)::int as n from pg_indexes where indexname in ('alibaba_sync_pending_idx','alibaba_sync_processing_idx')"))[0].n,2);
for(let i=1;i<=5;i++){
  const id='x'+i;
  await db.query("insert into public.purchase_records values($1,'孙杰','buyer@test.invalid','submitted_to_pool','pending')",[id]);
  await db.query("insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code) values($1,$2,'A')",[id,buyer]);
  await db.query("insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids) values($1,'A',array['5127369483007127225'])",[id]);
}
const snapshot=createPurchaseSnapshot([{orderId:'5127369483007127225',shipments:[{logisticsId:'LP1',rawStatus:'SIGN',signedAt:'2026-10-19T03:26:06.000Z',signedAtSource:'action_SIGN',latestTraceAt:'2026-10-19T03:26:06.000Z'}]}]);
await db.query("update public.purchase_logistics_summaries set shipment_count=1,signed_count=1,evidence=$1 where purchase_record_id='signed'",[snapshot.evidence]);
await db.exec('update public.alibaba_sync_control set manual_enabled=true');
const started=(await call('select public.start_alibaba_sync_v2($1) as result',[admin]))[0].result;
assert.equal(started.protocol,2);assert.equal(started.recordLimit,5);
await assert.rejects(db.query('select public.start_alibaba_sync_v2($1,null)',[admin]),error=>error.code==='22023');
assert.equal((await call('select count(*)::int as n from public.alibaba_sync_jobs where run_id=$1',[started.runId]))[0].n,5);
await assert.rejects(db.query('select public.start_alibaba_sync_v2($1)',[buyer]),error=>error.code==='55P03');
await assert.rejects(db.query('select public.alibaba_sync_progress_v2($1,$2)',[buyer,started.runId]),error=>error.code==='42501');
const claimNext=async run=>{
  const token=(await call('select token from public.alibaba_sync_runs where id=$1',[run]))[0].token;
  return (await call('select public.claim_alibaba_sync_v2($1) as result',[token]))[0].result;
};
const finish=async(batch,value=snapshot,failed=false)=>{
  const item=batch.items[0];
  return call('select public.finish_alibaba_sync_item_v2($1,$2,$3,$4,$5,$6)',[batch.runId,item.recordId,item.version,value,failed,batch.claimId]);
};
const next=async batch=>call('select public.continue_alibaba_sync_v2($1,$2)',[batch.runId,batch.claimId]);
const first=await claimNext(started.runId);assert.equal(first.items.length,1);assert.equal(first.items[0].recordId,'changed');
await assert.rejects(db.query('select public.claim_alibaba_sync_v2($1)',[first.claimId]),error=>error.code==='42501');
await assert.rejects(next(first),error=>error.code==='55P03');
await finish(first);await next(first);
assert.equal((await call("select signed_at from public.purchase_logistics_summaries where purchase_record_id='changed'"))[0].signed_at.toISOString(),'2026-10-19T03:26:06.000Z');
const second=await claimNext(started.runId);assert.equal(second.items[0].recordId,'signed');
await assert.rejects(next(first),error=>error.code==='42501');
await assert.rejects(finish(first),error=>error.code==='42501');
await db.exec('update public.alibaba_sync_control set manual_enabled=false');
await assert.rejects(finish(second),error=>error.code==='55000');
const prior=(await call("select * from public.purchase_logistics_summaries where purchase_record_id='signed'"))[0];
await db.exec('select public.recover_alibaba_sync();update public.alibaba_sync_control set manual_enabled=true');
await finish(second,{failure_code:'NETWORK',retryable:false},true);
await finish(second,{failure_code:'AUTHORIZATION',retryable:true},true);
await next(second);
const failed=(await call("select * from public.purchase_logistics_summaries where purchase_record_id='signed'"))[0];
assert.equal(failed.status,prior.status);assert.deepEqual(failed.evidence,prior.evidence);assert.equal(failed.signed_at.toISOString(),prior.signed_at.toISOString());assert.equal(failed.sync_error,'query_failed');
const failureJob=(await call('select failure_code,retryable from public.alibaba_sync_jobs where run_id=$1 and record_id=$2',[second.runId,second.items[0].recordId]))[0];
assert.deepEqual(failureJob,{failure_code:'NETWORK',retryable:true});
const third=await claimNext(started.runId);assert.equal(third.items[0].recordId,'transit');
await db.query("update public.alibaba_logistics_users set logistics_role='viewer',buyer_name='胡雅怡',account_code='B' where user_id=$1",[admin]);
await finish(third);await next(third);
assert.equal((await call("select status from public.purchase_logistics_summaries where purchase_record_id='transit'"))[0].status,'in_transit');
await db.query("update public.alibaba_logistics_users set logistics_role='admin',buyer_name=null,account_code=null where user_id=$1",[admin]);
const fourth=await claimNext(started.runId);assert.equal(fourth.items[0].recordId,'waiting');
await db.exec("update public.alibaba_purchase_links set version=2 where purchase_record_id='waiting'");
await finish(fourth);await next(fourth);
const fifth=await claimNext(started.runId);await finish(fifth);await next(fifth);
const progress=(await call('select public.alibaba_sync_progress_v2($1,$2) as result',[admin,started.runId]))[0].result;
assert.equal(progress.state,'complete');assert.equal(progress.total,5);assert.equal(progress.success,2);assert.equal(progress.failed,1);assert.equal(progress.skipped,2);
// Unclaimed HTTP requests (e.g. API pause or deployment outage) cannot loop forever.
const lost=(await call('select public.start_alibaba_sync_v2($1) as result',[admin]))[0].result;
const requests=(await call('select count(*)::int as n from net.requests'))[0].n;
for(let i=0;i<3;i++)await db.query("update public.alibaba_sync_runs set lease_until=now()-interval '1 second' where id=$1;",[lost.runId]).then(()=>db.exec('select public.recover_alibaba_sync()'));
assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,requests+2);
assert.equal((await call('select state,stop_reason from public.alibaba_sync_runs where id=$1',[lost.runId]))[0].stop_reason,'DISPATCH_UNCLAIMED');
// Auto cannot run under a partial pilot cap, and signed snapshots are excluded.
await assert.rejects(db.exec('update public.alibaba_sync_control set auto_enabled=true'));
await db.exec('update public.alibaba_sync_control set auto_enabled=true,manual_enabled=false,record_limit=null');
const automatic=(await call('select public.start_alibaba_sync_v2(null,null) as result'))[0].result;
const autoJobs=await call('select record_id from public.alibaba_sync_jobs where run_id=$1',[automatic.runId]);
assert.ok(autoJobs.length>0);assert.ok(autoJobs.every(job=>!['changed','signed','x1','pending','cancelled','wrong'].includes(job.record_id)));
const autoClaim=await claimNext(automatic.runId);const autoItem=autoClaim.items[0];
await db.query("insert into public.purchase_logistics_summaries(purchase_record_id,link_version,status) values($1,$2,'returned_signed') on conflict(purchase_record_id) do update set status='returned_signed',link_version=excluded.link_version",[autoItem.recordId,autoItem.version]);
await db.query('update public.purchase_logistics_summaries set evidence=$1 where purchase_record_id=$2',[snapshot.evidence,autoItem.recordId]);
await finish(autoClaim);assert.equal((await call('select state from public.alibaba_sync_jobs where run_id=$1 and record_id=$2',[automatic.runId,autoItem.recordId]))[0].state,'skipped');
// Test buyer reassignment between enqueue and claim, with a valid new bound owner.
await db.exec("update public.alibaba_sync_runs set state='complete',token=null,active_claim=null,lease_until=null where state='running';update public.alibaba_sync_control set auto_enabled=false,manual_enabled=true,record_limit=5");
const personal=(await call('select public.start_alibaba_sync_v2($1) as result',[buyer]))[0].result;
await assert.rejects(db.query('select public.start_alibaba_sync_v2($1)',[admin]),error=>error.code==='55P03');
const target=(await call("select record_id from public.alibaba_sync_jobs where run_id=$1 and state='pending' order by record_id limit 1",[personal.runId]))[0].record_id;
const other='dc0a3563-ca3c-423e-85de-63c90a60b15f';
await db.query("insert into auth.users(id,email) values($1,'other@test.invalid');",[other]);
await db.query("insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code) values($1,'buyer','章瀚成','A')",[other]);
await db.query("update public.alibaba_purchase_access set user_id=$1 where purchase_record_id=$2",[other,target]);
await db.query("update public.purchase_records set assigned_buyer_name='章瀚成',assigned_buyer_email='other@test.invalid' where id=$1",[target]);
const moved=await claimNext(personal.runId);assert.equal(moved.items[0].valid,false);await finish(moved,null,true);
assert.equal((await call('select state from public.alibaba_sync_jobs where run_id=$1 and record_id=$2',[personal.runId,target]))[0].state,'skipped');
// Claimed workers that disappear are retried at most three times per record.
await db.exec("update public.alibaba_sync_runs set state='complete',token=null,active_claim=null,lease_until=null where state='running';update public.alibaba_sync_control set record_limit=1");
const crashed=(await call('select public.start_alibaba_sync_v2($1,1) as result',[admin]))[0].result;
for(let i=0;i<3;i++){
  const worker=await claimNext(crashed.runId);assert.equal(worker.items.length,1);
  await db.query("update public.alibaba_sync_runs set lease_until=now()-interval '1 second' where id=$1",[crashed.runId]);
  await db.exec('select public.recover_alibaba_sync()');
}
assert.deepEqual((await call('select state,attempts from public.alibaba_sync_jobs where run_id=$1',[crashed.runId]))[0],{state:'failed',attempts:3});
// Queue exceptions also consume the finite dispatch budget, rather than roll it back.
await db.exec(`create or replace function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin raise exception 'simulated queue unavailable'; end $$;`);
const queueFailure=(await call('select public.start_alibaba_sync_v2($1,1) as result',[admin]))[0].result;
assert.equal((await call('select stop_reason from public.alibaba_sync_runs where id=$1',[queueFailure.runId]))[0].stop_reason,'DISPATCH_QUEUE_ERROR');
for(let i=0;i<3;i++){
  await db.query("update public.alibaba_sync_runs set lease_until=now()-interval '1 second' where id=$1",[queueFailure.runId]);
  await db.exec('select public.recover_alibaba_sync()');
}
assert.equal((await call('select state from public.alibaba_sync_runs where id=$1',[queueFailure.runId]))[0].state,'complete');
const beforePlan=(await call('select count(*)::int as n from net.requests'))[0].n;
await db.exec(fs.readFileSync('sql/2026-10-21-alibaba-batch-query-plan-readonly.sql','utf8'));
assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,beforePlan);
await db.exec(`create function cron.alter_job(job_id bigint,active boolean default null) returns void language plpgsql as $$begin update cron.job j set active=$2 where j.jobid=$1; end $$;
  insert into cron.job(jobname,schedule,command,active) values('unrelated-business-job','0 1 * * *','select 1',true);
  update cron.job set active=true where jobname like 'alibaba-logistics-%';`);
await db.exec(fs.readFileSync('sql/2026-10-21-alibaba-stop-recovered-sync.sql','utf8'));
assert.ok((await call('select manual_enabled,auto_enabled from public.alibaba_sync_control'))[0].manual_enabled===false);
assert.ok((await call("select active from cron.job where jobname like 'alibaba-logistics-%'")).every(row=>row.active===false));
assert.equal((await call("select active from cron.job where jobname='unrelated-business-job'"))[0].active,true);
// Isolated fulfillment fixtures: exercise real selection, claim and save SQL.
await db.exec(`update public.purchase_records set pool_status='pending_purchase';
 create or replace function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare v_id bigint;begin insert into net.requests(body,url) values(body,url) returning id into v_id;return v_id;end $$;`);
const contextOrder='5127554054006090539';
const pendingSnapshot=createPurchaseSnapshot([noCourierResult({orderId:contextOrder,shipments:[]},'awaiting_shipment')]);
const pickupSnapshot=createPurchaseSnapshot([noCourierResult({orderId:contextOrder,shipments:[]},'buyer_pickup')]);
async function putSummary(record,value,version=1){
 await db.query(`insert into public.purchase_logistics_summaries(purchase_record_id,link_version,status,shipment_count,signed_count,unknown_count,exception_count,evidence)
 values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(purchase_record_id) do update set link_version=excluded.link_version,status=excluded.status,
 shipment_count=excluded.shipment_count,signed_count=excluded.signed_count,unknown_count=excluded.unknown_count,exception_count=excluded.exception_count,evidence=excluded.evidence`,
 [record,version,value.status,value.shipment_count,value.signed_count,value.unknown_count,value.exception_count,value.evidence]);
}
for(const id of ['000-await','001-pickup','002-legacy','003-confirmed','004-forged','005-stale','006-orders','007-permanent','008-transient']){
 await db.query("insert into public.purchase_records values($1,'孙杰','buyer@test.invalid','submitted_to_pool','pending')",[id]);
 await db.query("insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code) values($1,$2,'A')",[id,buyer]);
 await db.query("insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids) values($1,'A',array[$2])",[id,contextOrder]);
}
await putSummary('000-await',pendingSnapshot);await putSummary('001-pickup',pickupSnapshot);
await db.exec("insert into public.purchase_logistics_summaries(purchase_record_id,link_version,status) values('002-legacy',1,'returned_signed')");
await putSummary('003-confirmed',snapshot);
const forged=structuredClone(pendingSnapshot);forged.evidence.fulfillment.source='UNAPPROVED';await putSummary('004-forged',forged);
await putSummary('005-stale',pendingSnapshot,0);
const changedOrders=structuredClone(pendingSnapshot);changedOrders.evidence.queried_order_ids=['999'];await putSummary('006-orders',changedOrders);
const classificationRun=(await call("insert into public.alibaba_sync_runs(actor_id,state) values($1,'complete') returning id",[admin]))[0].id;
for(const [id,code,retryable] of [['007-permanent','AUTHORIZATION',false],['008-transient','NETWORK',true]]){
 await putSummary(id,transitSnapshotFixture());
 await db.query("update public.purchase_logistics_summaries set sync_error='query_failed' where purchase_record_id=$1",[id]);
 await db.query("insert into public.alibaba_sync_jobs(run_id,record_id,link_version,state,attempted_at,failure_code,retryable) values($1,$2,1,'failed',now(),$3,$4)",[classificationRun,id,code,retryable]);
}
function transitSnapshotFixture(){return createPurchaseSnapshot([{orderId:contextOrder,shipments:[{logisticsId:'LP1',rawStatus:'TRANSPORT'}]}]);}
const context=async id=>(await call('select public.alibaba_approved_fulfillment_context($1,1) as value',[id]))[0].value;
assert.equal(await context('000-await'),'awaiting_shipment');assert.equal(await context('001-pickup'),'buyer_pickup');
for(const id of ['004-forged','005-stale','006-orders'])assert.equal(await context(id),null);
await db.exec('update public.alibaba_sync_control set auto_enabled=true,manual_enabled=false,record_limit=null');
const courierAuto=(await call('select public.start_alibaba_sync_v2(null,null) as result'))[0].result;
const courierIds=(await call('select record_id from public.alibaba_sync_jobs where run_id=$1',[courierAuto.runId])).map(row=>row.record_id);
assert.ok(courierIds.includes('000-await'));assert.ok(courierIds.includes('002-legacy'));assert.ok(!courierIds.includes('001-pickup'));assert.ok(!courierIds.includes('003-confirmed'));
assert.ok(!courierIds.includes('007-permanent'));assert.ok(courierIds.includes('008-transient'));
// Pickup recognized after enqueue must also skip at claim/save.
await putSummary('000-await',pickupSnapshot);
const pickupClaim=await claimNext(courierAuto.runId);assert.equal(pickupClaim.fulfillmentProtocol,1);assert.equal(pickupClaim.items[0].valid,false);assert.equal(pickupClaim.items[0].fulfillmentContext,'buyer_pickup');
await finish(pickupClaim,null,true);assert.equal((await call('select state from public.alibaba_sync_jobs where run_id=$1 and record_id=$2',[courierAuto.runId,'000-await']))[0].state,'skipped');
await db.exec("update public.alibaba_sync_runs set state='complete',active_claim=null,token=null,lease_until=null where state='running';update public.alibaba_sync_jobs set state='skipped' where state in ('pending','processing');update public.alibaba_sync_control set auto_enabled=false,manual_enabled=true,record_limit=5");
await putSummary('000-await',pendingSnapshot);
const fulfillmentRun=(await call('select public.start_alibaba_sync_v2($1,5) as result',[admin]))[0].result;
assert.ok(!(await call('select record_id from public.alibaba_sync_jobs where run_id=$1',[fulfillmentRun.runId])).some(row=>row.record_id==='001-pickup'));
let contextClaim=await claimNext(fulfillmentRun.runId);assert.equal(contextClaim.items[0].recordId,'000-await');assert.equal(contextClaim.items[0].fulfillmentContext,'awaiting_shipment');
await finish(contextClaim,pendingSnapshot);await next(contextClaim);
assert.equal((await call("select status,sync_error from public.purchase_logistics_summaries where purchase_record_id='000-await'"))[0].status,'awaiting_shipment');
for(let i=0;i<4;i++){
 contextClaim=await claimNext(fulfillmentRun.runId);
 if(contextClaim.items[0].recordId==='004-forged')await assert.rejects(finish(contextClaim,pendingSnapshot),error=>error.code==='22023');
 await finish(contextClaim,snapshot);await next(contextClaim);
}
// The next check after shipment may replace awaiting-shipment with real transit.
const afterShipment=(await call('select public.start_alibaba_sync_v2($1,5) as result',[admin]))[0].result;
contextClaim=await claimNext(afterShipment.runId);assert.equal(contextClaim.items[0].fulfillmentContext,'awaiting_shipment');
const transitSnapshot=createPurchaseSnapshot([{orderId:contextOrder,shipments:[{logisticsId:'LP-new',rawStatus:'SIGN',effectiveStatus:'TRANSPORT',latestTraceAt:'2026-10-22T01:00:00.000Z'}]}]);
await finish(contextClaim,transitSnapshot);assert.equal(await context('000-await'),null);
assert.equal((await call("select status,signed_at from public.purchase_logistics_summaries where purchase_record_id='000-await'"))[0].status,'in_transit');
await db.exec("update public.alibaba_sync_runs set state='complete',active_claim=null,token=null,lease_until=null where state='running';update public.alibaba_sync_jobs set state='skipped' where state in ('pending','processing')");
const partialRun=(await call('select public.start_alibaba_sync_v2($1,5) as result',[admin]))[0].result;
contextClaim=await claimNext(partialRun.runId);assert.equal(contextClaim.items[0].fulfillmentContext,null);
const partialSnapshot=createPurchaseSnapshot([{orderId:contextOrder,shipments:[
 {logisticsId:'LP-signed',rawStatus:'SIGN',effectiveStatus:'SIGN',signedAt:'2026-10-20T06:43:39.000Z',signedAtSource:'explicit_signed_text'},
 {logisticsId:'LP-moving',rawStatus:'SIGN',effectiveStatus:'TRANSPORT',latestTraceAt:'2026-10-22T01:00:00.000Z'},
]}]);
await finish(contextClaim,partialSnapshot);
const partialSaved=(await call("select status,signed_count,signed_at from public.purchase_logistics_summaries where purchase_record_id='000-await'"))[0];
assert.equal(partialSaved.status,'partial_signed');assert.equal(partialSaved.signed_count,1);assert.equal(partialSaved.signed_at.toISOString(),'2026-10-20T06:43:39.000Z');
await db.exec("update public.alibaba_sync_runs set state='complete',active_claim=null,token=null,lease_until=null where state='running';update public.alibaba_sync_jobs set state='skipped' where state in ('pending','processing')");
await db.exec("update public.purchase_records set pool_status='pending_purchase' where id<>'007-permanent'");
const repairRun=(await call('select public.start_alibaba_sync_v2($1,5) as result',[admin]))[0].result;
const repairClaim=await claimNext(repairRun.runId);assert.equal(repairClaim.items[0].recordId,'007-permanent');assert.equal(repairClaim.items[0].valid,true);
await finish(repairClaim,transitSnapshotFixture());await next(repairClaim);
assert.equal((await call("select public.alibaba_courier_retry_blocked('007-permanent',1) as blocked"))[0].blocked,false);
await assert.rejects(db.exec(fs.readFileSync('sql/2026-10-22-alibaba-batch-fulfillment.sql','utf8')),/Pause Alibaba/);await db.exec('rollback');
await db.exec('update public.alibaba_sync_control set manual_enabled=false');
const noDispatch=(await call('select count(*)::int as n from net.requests'))[0].n;
await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-batch-fulfillment.sql','utf8'));
assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,noDispatch);
const enablePilot=fs.readFileSync('sql/2026-10-22-alibaba-enable-fulfillment-pilot.sql','utf8');
await db.exec(enablePilot);await db.exec(enablePilot);
assert.deepEqual((await call('select manual_enabled,auto_enabled,record_limit from public.alibaba_sync_control'))[0],{manual_enabled:true,auto_enabled:false,record_limit:5});
assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,noDispatch);
await db.exec("update cron.job set active=true where jobname='alibaba-logistics-worker-recovery'");
await assert.rejects(db.exec(enablePilot),/cron jobs must remain paused/);await db.exec('rollback');
await db.exec("update cron.job set active=false where jobname='alibaba-logistics-worker-recovery';update public.alibaba_sync_control set manual_enabled=false");
const unfinished=(await call("insert into public.alibaba_sync_runs(actor_id,state) values($1,'running') returning id",[admin]))[0].id;
await assert.rejects(db.exec(enablePilot),/unfinished run/);await db.exec('rollback');
await db.query("update public.alibaba_sync_runs set state='complete' where id=$1",[unfinished]);
await db.exec('alter function public.alibaba_courier_retry_blocked(text,integer) rename to fixture_missing_protocol');
await assert.rejects(db.exec(enablePilot),/fulfillment protocol/);await db.exec('rollback');
await db.exec('alter function public.fixture_missing_protocol(text,integer) rename to alibaba_courier_retry_blocked');
assert.equal((await call('select count(*)::int as n from net.requests'))[0].n,noDispatch);
const report=await db.exec(fs.readFileSync('sql/2026-10-22-alibaba-fulfillment-pilot-result-readonly.sql','utf8'));
assert.doesNotMatch(JSON.stringify(report),/workerToken|active_claim|buyer@test.invalid/);
console.log('PASS: approved fulfillment propagation, version/order/source isolation, pickup queue/claim/save exclusion, unverified SIGN recheck, pending persistence and later transit.');
console.log('PASS: disabled/rerunnable installation, incident-only closeout, indexes, private v2 ACLs, one-use single claims, five-record cap, stale claim isolation, paused writes, failure/time preservation, role/ownership/version changes, unclaimed dispatch cap and signed auto exclusion. Cron/net mocked.');
} catch (error) { console.error(error.code ?? 'ASSERTION', error.message, error.query ?? ''); process.exitCode=1; } finally { await db.close(); }
