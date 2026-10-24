import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '../.codex-sql-test/node_modules/@electric-sql/pglite/dist/index.js';
import { createPurchaseSnapshot } from '../api/_lib/alibabaSnapshot.js';
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.purchase_records(id text primary key,assigned_buyer_name text,assigned_buyer_email text,pool_status text,status text);
    create table public.alibaba_sync_control(id boolean primary key,manual_enabled boolean,auto_enabled boolean);
    insert into public.alibaba_sync_control values(true,false,false);
    create schema cron; create table cron.job(jobname text,active boolean);`);
  for (const file of ['2026-10-20-alibaba-logistics-foundation.sql','2026-10-20-alibaba-snapshot-rpcs.sql','2026-10-21-alibaba-self-service.sql','2026-10-21-alibaba-order-draft.sql','2026-10-21-alibaba-signed-time.sql','2026-10-21-alibaba-signed-time.sql','2026-10-22-alibaba-trace-status.sql','2026-10-22-alibaba-trace-status.sql']) await db.exec(fs.readFileSync('sql/'+file,'utf8'));
  await db.exec('update public.alibaba_sync_control set manual_enabled=true');
  await assert.rejects(db.exec(fs.readFileSync('sql/2026-10-22-alibaba-trace-status.sql','utf8')),/Pause Alibaba/);
  await db.exec('rollback;update public.alibaba_sync_control set manual_enabled=false');
  const user='d32f1446-c579-44ec-8a07-d6d888688bc0',orderId='5127369483007127225';
  await db.query('insert into auth.users(id,email) values($1,$2)',[user,'fixture@test.invalid']);
  await db.query("insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code) values($1,'admin','胡雅怡','B')",[user]);
  await db.exec("insert into public.purchase_records values('p1','胡雅怡','fixture@test.invalid','submitted_to_pool','pending')");
  const shipment=(logisticsId,signedAt='2026-10-19T03:26:06.000Z',rawStatus='SIGN')=>({logisticsId,rawStatus,signedAt,signedAtSource:'action_SIGN',latestTraceAt:signedAt});
  const snapshot=shipments=>createPurchaseSnapshot([{orderId,shipments}]);
  const commit=async(value,version=1)=>db.query("select public.commit_alibaba_purchase_snapshot($1,'p1',$1,'胡雅怡','B',array[$2],$3,$4,clock_timestamp())",[user,orderId,version,value]);
  // Exercise the actual existing self-service RPC, including its ACL and link checks.
  await commit(snapshot([shipment('LP1'),shipment('LP2','2026-10-20T03:00:00.000Z')]),0);
  const read=async()=>(await db.query("select * from public.purchase_logistics_summaries where purchase_record_id='p1'")).rows[0];
  let saved=await read();assert.equal(saved.signed_at.toISOString(),'2026-10-20T03:00:00.000Z');
  assert.equal(saved.latest_trace_at.toISOString(),'2026-10-20T03:00:00.000Z');
  await db.query("select public.fail_alibaba_purchase_refresh($1,'p1',1,clock_timestamp())",[user]);
  saved=await read();assert.equal(saved.signed_at.toISOString(),'2026-10-20T03:00:00.000Z');assert.equal(saved.sync_error,'query_failed');
  // Upstream history retention must not erase a previously confirmed timestamp.
  await commit(snapshot([shipment('LP1',null),shipment('LP2',null)]));
  saved=await read();assert.equal(saved.signed_at.toISOString(),'2026-10-20T03:00:00.000Z');
  // A newly returned signed parcel without a time makes whole-order completion unknown.
  await commit(snapshot([shipment('LP1'),shipment('LP2',null),shipment('LP3',null)]));
  assert.equal((await read()).signed_at,null);
  await commit(snapshot([shipment('LP1'),shipment('LP2',null,'TRANSPORT')]));
  saved=await read();assert.equal(saved.status,'partial_signed');assert.equal(saved.signed_at.toISOString(),'2026-10-19T03:26:06.000Z');
  // Preserve raw upstream SIGN while deriving current signatures from trace evidence.
  await commit(snapshot([{...shipment('LP1'),effectiveStatus:'SIGN'}, {...shipment('LP2',null),effectiveStatus:'TRANSPORT'}]));
  saved=await read();assert.equal(saved.status,'partial_signed');assert.equal(saved.signed_count,1);assert.equal(saved.signed_at.toISOString(),'2026-10-19T03:26:06.000Z');
  await commit(snapshot([{...shipment('LP1'),effectiveStatus:'TRANSPORT'},{...shipment('LP2'),effectiveStatus:'TRANSPORT'}]));
  saved=await read();assert.equal(saved.status,'in_transit');assert.equal(saved.signed_at,null);assert.equal(saved.evidence.shipments[0].signedAt,null);
  await commit(snapshot([{...shipment('LP1',undefined,'TRANSPORT'),effectiveStatus:'SIGN'}]));
  saved=await read();assert.equal(saved.status,'returned_signed');assert.equal(saved.signed_at.toISOString(),'2026-10-19T03:26:06.000Z');
  await db.exec("update public.alibaba_purchase_links set version=2 where purchase_record_id='p1'");
  await commit(snapshot([shipment('LP1',null)]),2);assert.equal((await read()).signed_at,null);
  const invalid=snapshot([shipment('LP1',null)]);invalid.evidence.shipments[0].signedAt='2026-02-30T03:00:00.000Z';
  await commit(invalid,2);assert.equal((await read()).signed_at,null);
  const privileges=(await db.query("select has_column_privilege('authenticated','public.purchase_logistics_summaries','signed_at','select') as signed,has_column_privilege('authenticated','public.purchase_logistics_summaries','latest_trace_at','select') as trace,has_column_privilege('authenticated','public.purchase_logistics_summaries','evidence','select') as evidence,has_column_privilege('anon','public.purchase_logistics_summaries','signed_at','select') as anon")).rows[0];
  assert.deepEqual(privileges,{signed:true,trace:true,evidence:false,anon:false});
  await db.exec(`set role authenticated;set "request.jwt.claim.sub"='${user}'`);
  assert.equal((await db.query('select signed_at,latest_trace_at from public.purchase_logistics_summaries')).rows.length,1);
  await db.exec('reset role');
  console.log('PASS: rerunnable incremental SQL, existing RPCs, complete/partial/missing timestamps, failure retention, version isolation, historical evidence preservation, invalid dates and RLS column grants.');
} finally { await db.close(); }
