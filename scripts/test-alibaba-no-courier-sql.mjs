import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '../.codex-sql-test/node_modules/@electric-sql/pglite/dist/index.js';
import {createPurchaseSnapshot} from '../api/_lib/alibabaSnapshot.js';
import {noCourierResult} from '../api/_lib/alibabaFulfillment.js';
const db=new PGlite();
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key,email text,deleted_at timestamptz);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table public.purchase_records(id text primary key,assigned_buyer_name text,assigned_buyer_email text,pool_status text,status text);
 create table public.alibaba_sync_control(id boolean primary key,manual_enabled boolean,auto_enabled boolean);
 insert into public.alibaba_sync_control values(true,false,false);
 create schema cron;create table cron.job(jobname text,active boolean);`);
 for(const file of ['2026-10-20-alibaba-logistics-foundation.sql','2026-10-20-alibaba-snapshot-rpcs.sql','2026-10-21-alibaba-self-service.sql','2026-10-21-alibaba-order-draft.sql','2026-10-22-alibaba-trace-status.sql','2026-10-22-alibaba-no-courier-pilot.sql','2026-10-22-alibaba-no-courier-pilot.sql'])await db.exec(fs.readFileSync('sql/'+file,'utf8'));
 const uid='9401d015-9de4-4e4e-89a4-257c1e8d7028';
 await db.query("insert into auth.users values($1,'fixture@test.invalid',null)",[uid]);
 await db.query("insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code) values($1,'admin','孙杰','A')",[uid]);
 const rows=[['aa66308b-46d0-4928-86ca-b8441c2caa61','5127554054006090539','awaiting_shipment'],['ab6fdb15-1d16-4e9b-8838-1f4f38851c58','5127881617007009337','buyer_pickup']];
 for(const [record,order,type] of rows){
  await db.query("insert into public.purchase_records values($1,'孙杰','fixture@test.invalid','submitted_to_pool','pending')",[record]);
  await db.query("insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code) values($1,$2,'A')",[record,uid]);
  await db.query("insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids) values($1,'A',array[$2])",[record,order]);
  const snapshot=createPurchaseSnapshot([noCourierResult({orderId:order,shipments:[]},type)]);
  const commit=(value=snapshot,version=1)=>db.query('select public.commit_alibaba_fulfillment_pilot($1,$2,$3,$4,clock_timestamp())',[uid,record,version,value]);
  await commit();
  const saved=(await db.query('select * from public.purchase_logistics_summaries where purchase_record_id=$1',[record])).rows[0];
  assert.equal(saved.status,type);assert.equal(saved.signed_at,null);assert.equal(saved.coverage_confirmed,false);
  assert.equal(saved.sync_error,null);assert.equal(saved.evidence.fulfillment.type,type);
  await assert.rejects(commit({...snapshot,status:'returned_signed'}),e=>e.code==='22023');
  await assert.rejects(commit(snapshot,2),e=>e.code==='40001');
 }
 const privileges=(await db.query("select has_function_privilege('authenticated','public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamptz)','execute') as browser,has_function_privilege('service_role','public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamptz)','execute') as server")).rows[0];
 assert.deepEqual(privileges,{browser:false,server:true});
 await db.query("update public.alibaba_logistics_users set logistics_role='buyer' where user_id=$1",[uid]);
 await assert.rejects(db.query('select public.commit_alibaba_fulfillment_pilot($1,$2,1,$3,clock_timestamp())',[uid,rows[0][0],{}]),e=>e.code==='42501');
 console.log('PASS: rerunnable exact pilot SQL, legacy ACL/ownership/version reuse, pending/pickup persistence, no signatures and rejection of wrong state/version/non-admin.');
}finally{await db.close();}
