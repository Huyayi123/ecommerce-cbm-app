import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const tempDir = await mkdtemp(join(tmpdir(), 'logistics-loading-types-'));

async function compile(sourceName, outputName, transform = (source) => source) {
  const sourcePath = new URL(`../src/utils/${sourceName}`, import.meta.url);
  const source = transform(await readFile(sourcePath, 'utf8'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await writeFile(join(tempDir, outputName), compiled, 'utf8');
}

function record(id, loadingType) {
  return {
    id,
    internalCode: id,
    manufacturerName: 'Factory',
    sku: `SKU-${id}`,
    productName: id,
    englishName: id,
    imageUrl: '',
    shopName: 'Bestby',
    loadingType,
    containerDate: '2026-09-12',
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
    isMixed: false,
    mixedGroups: [],
    unitCbm: 0.01,
    totalCbm: 0.1,
  };
}

try {
  await compile('number.ts', 'number.mjs');
  await compile('purchaseRecords.ts', 'purchaseRecords.mjs', (source) => source.replace("'./number'", "'./number.mjs'"));
  await compile('purchasePoolFlows.ts', 'purchasePoolFlows.mjs', (source) => source.replace("'./purchaseRecords'", "'./purchaseRecords.mjs'"));
  await compile('logistics.ts', 'logistics.mjs', (source) => source
    .replace("'./number'", "'./number.mjs'")
    .replace("'./purchasePoolFlows'", "'./purchasePoolFlows.mjs'")
    .replace("'./purchaseRecords'", "'./purchaseRecords.mjs'"));

  const { buildLogisticsBatch, logisticsBatchLoadingType } = await import(`file:///${join(tempDir, 'logistics.mjs').replaceAll('\\', '/')}`);
  const records = [record('container', '整柜'), record('blank', ''), record('guantong', '冠通'), record('haichuan', '海川')];
  const admin = { id: 'admin', email: 'admin@example.com' };
  const logistics = { id: 'logistics-1', email: 'logistics@example.com' };

  const containerBatch = buildLogisticsBatch(records, [], admin, '2026-09-12', logistics, undefined, '整柜');
  const haichuanBatch = buildLogisticsBatch(records, [], admin, '2026-09-12', logistics, undefined, '海川');

  assert.deepEqual(containerBatch.items.map((item) => item.purchaseRecordId), ['blank', 'container']);
  assert.deepEqual(haichuanBatch.items.map((item) => item.purchaseRecordId), ['haichuan']);
  assert.equal(logisticsBatchLoadingType(containerBatch), '整柜');
  assert.equal(logisticsBatchLoadingType(haichuanBatch), '海川');
  assert.notEqual(containerBatch.id, haichuanBatch.id);
  assert.match(containerBatch.id, /-container-/);
  assert.match(haichuanBatch.id, /-haichuan-/);

  console.log('logistics loading type isolation tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
