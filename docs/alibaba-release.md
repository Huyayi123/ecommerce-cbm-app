# 1688 release and data verification

The production deployment must include the tracked Alibaba APIs, their `_lib`
dependencies, the order-entry and logistics components, and the page wiring.
Do not deploy a Git revision that omits those files. Production previously lost
these APIs when a Git deployment replaced a CLI-only deployment on 2026-10-24.

This release is based on the latest remote main, preserving its unrelated changes
and the Haichuan pending-receipt sync fix. It restores Alibaba wiring without
replacing the entire application with an older checkout.

Run `npm run build` and `npm run test:alibaba` before publishing. SQL migrations
are versioned for review, but are not executed by deployment. Keep secrets only
in Vercel project settings, never in Git.

Persisted non-secret production settings:

- `ALIBABA_SELF_SERVICE_ENABLED=true`
- `VITE_ALIBABA_LOGISTICS_ENABLED=true`
- `ALIBABA_BATCH_SYNC_ENABLED=true`
- `VITE_ALIBABA_BATCH_SYNC_ENABLED=true`
- `ALIBABA_BATCH_PILOT_LIMIT=all`
- `VITE_ALIBABA_BATCH_SYNC_PILOT_LIMIT=all`

Database manual mode must independently allow the requested scope. Automatic sync
and cron are not enabled by these settings. Single-order and batch refreshes use
trace-priority evidence: detail `SIGN` alone is not proof of delivery for self-linked
shipping. Unlinked diagnostic pilots remain bounded, admin-only and read-only.

Check unauthenticated POSTs to `/api/alibaba-self` and `/api/alibaba-sync` return
JSON `LOGIN_REQUIRED`, not a platform plain-text 404. This checks route availability,
not successful writes or data freshness. Authenticated save readback and run results
must be checked separately. Network errors never prove a request was not committed.

Known business evidence: signed, in-transit, delivery-restriction exception,
awaiting-shipment and buyer-pickup paths were checked with user-provided production
results. Partial-signature aggregation has regression coverage but no current real
partial-signature sample has been provided. All records' current correctness and
completion of the full manual run have not been verified.
