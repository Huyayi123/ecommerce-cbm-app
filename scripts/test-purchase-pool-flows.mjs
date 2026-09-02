import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const tempDir = await mkdtemp(join(tmpdir(), 'purchase-pool-flows-'));

async function compile(sourceName, outputName, transform = (source) => source) {
  const sourcePath = new URL(`../src/utils/${sourceName}`, import.meta.url);
  const source = transform(await readFile(sourcePath, 'utf8'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await writeFile(join(tempDir, outputName), compiled, 'utf8');
}

function record(id, loadingType, containerDate = '') {
  return {
    id,
    loadingType,
    containerDate,
    poolStatus: 'submitted_to_pool',
    status: 'pending',
    isConfirmed: true,
    purchaseQuantity: 10,
    confirmedPurchaseQuantity: 10,
    purchasePrice: 5,
    freightCost: 0,
    totalAmount: 50,
    cartonCount: 1,
    unitsPerCarton: 10,
    tailQuantity: 0,
    mixedGroups: [],
    unitCbm: 0.01,
    totalCbm: 0.1,
    purchasePoolDate: '2026-09-01',
    purchaseBatchDate: '2026-09-01',
  };
}

try {
  await compile('number.ts', 'number.mjs');
  await compile('purchaseRecords.ts', 'purchaseRecords.mjs', (source) => source.replace("'./number'", "'./number.mjs'"));
  await compile('purchasePoolFlows.ts', 'purchasePoolFlows.mjs', (source) => source.replace("'./purchaseRecords'", "'./purchaseRecords.mjs'"));
  const flows = await import(`file:///${join(tempDir, 'purchasePoolFlows.mjs').replaceAll('\\', '/')}`);

  const dateResult = flows.applyContainerDateToPoolRecords([
    record('container-default', '整柜', '2026-09-01'),
    record('container-blank', '', ''),
    record('container-manual', '整柜', '2026-09-03'),
    record('guantong', '冠通', ''),
  ], '2026-09-01', '2026-09-10');
  assert.equal(dateResult.updatedCount, 2);
  assert.equal(dateResult.preservedManualCount, 1);
  assert.equal(dateResult.skippedGuantongCount, 1);
  assert.equal(dateResult.records[0].containerDate, '2026-09-10');
  assert.equal(dateResult.records[1].containerDate, '2026-09-10');
  assert.equal(dateResult.records[2].containerDate, '2026-09-03');
  assert.equal(dateResult.records[3].containerDate, '');

  assert.equal(flows.changePurchasePoolLoadingType(record('switch', '整柜', '2026-09-01'), '冠通').containerDate, '');
  assert.equal(flows.changePurchasePoolLoadingType(record('switch-back', '冠通', '2026-09-02'), '整柜').containerDate, '');

  const sendResult = flows.prepareDatedGuantongForInventory([
    record('dated-guantong', '冠通', '2026-09-05'),
    record('undated-guantong', '冠通', ''),
    record('container', '整柜', '2026-09-05'),
  ]);
  assert.equal(sendResult.sentRecords.length, 1);
  assert.equal(sendResult.sentRecords[0].id, 'dated-guantong');
  assert.equal(sendResult.sentRecords[0].poolStatus, 'sent_to_inventory');
  assert.equal(sendResult.sentRecords[0].status, 'in_transit');
  assert.equal(sendResult.missingDateCount, 1);
  assert.equal(sendResult.records.find((item) => item.id === 'undated-guantong').poolStatus, 'submitted_to_pool');
  assert.equal(sendResult.records.find((item) => item.id === 'container').poolStatus, 'submitted_to_pool');

  assert.equal(flows.isRecordEligibleForLogistics(record('container', '整柜', '2026-09-05'), '2026-09-05'), true);
  assert.equal(flows.isRecordEligibleForLogistics(record('guantong', '冠通', '2026-09-05'), '2026-09-05'), false);

  const stalePoolRecord = { ...record('stale-pool-record', '整柜'), poolStatus: 'pending_purchase', isConfirmed: false };
  const normalizedPoolRecord = flows.normalizeRecordForPurchasePool(stalePoolRecord);
  assert.equal(normalizedPoolRecord.poolStatus, 'submitted_to_pool');
  assert.equal(normalizedPoolRecord.isConfirmed, true);

  const unrelatedPending = { ...record('unrelated-pending', '整柜'), poolStatus: 'pending_purchase', isConfirmed: false };
  const membershipRepair = flows.repairPurchasePoolMembership(
    [stalePoolRecord, unrelatedPending],
    [{ id: 'pool-1', status: 'open', records: [stalePoolRecord] }],
  );
  assert.equal(membershipRepair.repairedRecords.length, 1);
  assert.equal(membershipRepair.records.find((item) => item.id === 'stale-pool-record').poolStatus, 'submitted_to_pool');
  assert.equal(membershipRepair.records.find((item) => item.id === 'unrelated-pending').poolStatus, 'pending_purchase');

  console.log('purchase pool loading flow tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
