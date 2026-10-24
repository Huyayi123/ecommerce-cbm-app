-- INCIDENT MITIGATION: pause only the two newly added Alibaba jobs.
-- Run in the existing project's Supabase SQL Editor as the project administrator.
-- Does not change purchase records, inventory, permissions or other scheduled jobs.
set lock_timeout = '3s';
set statement_timeout = '15s';

update cron.job set active=false
where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');

-- Cancel only active statements executing the new batch-sync functions.
-- Canceling rolls back that statement; do not terminate unrelated user sessions.
select pg_cancel_backend(pid) as cancelled_batch_statement
from pg_stat_activity
where datname=current_database() and pid<>pg_backend_pid() and state='active'
  and query ~ '(start_alibaba_sync|claim_alibaba_sync|finish_alibaba_sync_item|dispatch_alibaba_sync|continue_alibaba_sync|recover_alibaba_sync|alibaba_sync_progress)';

select jobname,schedule,active from cron.job
where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');
