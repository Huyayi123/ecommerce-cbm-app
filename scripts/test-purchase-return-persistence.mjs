import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function extract(path, name) {
  const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, name);
  return ts.transpileModule(found.replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const record = { id: 'returned', poolStatus: 'pending_purchase', isConfirmed: false };
const stalePool = { id: 'old-pool', status: 'open', records: [{ ...record, poolStatus: 'submitted_to_pool', isConfirmed: true }] };
let displayed;
let writes = 0;
const context = { console, supabase: {}, profile: { role: 'admin' }, skuItems: [],
  fetchPurchaseRecords: async () => [record], fetchPurchasePools: async () => [stalePool],
  fetchHaichuanData: async () => ({ inboundItems: [], warehouseLots: [], loadingBatches: [] }),
  setPurchaseRecords: (value) => { displayed = value; },
  upsertPurchaseRecords: async () => { writes++; }, canEdit: () => true,
  repairPurchasePoolMembership: () => { throw Error('Loading must not promote returned records'); },
};
for (const name of ['SkuItems','ContainerRows','Profiles','SalesSuggestions','RepricingAlerts','AdAnalysisRuns','LogisticsBatches','ProfitAnalysisRuns','MonthlyProfitSummaries','CommissionRuns']) context['fetch' + name] = async () => [];
for (const name of ['SkuItems','PurchaseRows','Profiles','SavedSalesSuggestions','RepricingAlerts','PurchasePools','AdAnalysisRuns','LogisticsBatches','ProfitAnalysisRuns','MonthlyProfitSummaries','CommissionRuns','HaichuanData','StatusMessage']) context['set' + name] = () => {};
vm.createContext(context);
vm.runInContext(extract('src/App.tsx', 'loadCloudData'), context);
await context.loadCloudData();
assert.equal(displayed[0].poolStatus, 'pending_purchase');
assert.equal(writes, 0);
await context.loadCloudData();
assert.equal(writes, 0);

let result;
const storage = { console, JSON, Map, Set,
  requireSupabase: () => ({ from: () => ({ upsert: () => ({ select: async () => result }) }) }),
  toPurchasePoolRow: (pool) => pool, toPurchaseRecordRow: (row) => row,
  isMissingColumnError: () => false, formatErrorMessage: (error) => error.message,
};
vm.createContext(storage);
for (const name of ['upsertPurchasePools', 'upsertPurchaseRecords']) vm.runInContext(extract('src/utils/cloudStorage.ts', name), storage);
result = { data: [], error: null };
await assert.rejects(storage.upsertPurchasePools([{ id: 'old-pool', records: [] }]), /云端确认/);
result = { data: [{ id: 'old-pool', records: [record] }], error: null };
await assert.rejects(storage.upsertPurchasePools([{ id: 'old-pool', records: [] }]), /云端确认/);
result = { data: [{ id: 'old-pool', records: [] }], error: null };
await storage.upsertPurchasePools([{ id: 'old-pool', records: [] }]);
result = { data: [{ id: record.id, pool_status: 'submitted_to_pool', is_confirmed: true }], error: null };
await assert.rejects(storage.upsertPurchaseRecords([record]), /状态未被云端确认/);
result = { data: [{ id: record.id, pool_status: 'pending_purchase', is_confirmed: false }], error: null };
await storage.upsertPurchaseRecords([record]);
console.log('PASS: stale pool snapshots cannot resubmit returned purchases; unconfirmed pool and record writes fail explicitly.');
