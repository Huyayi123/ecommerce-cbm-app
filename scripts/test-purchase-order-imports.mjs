import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const tempDir = await mkdtemp(join(tmpdir(), 'purchase-order-imports-'));

async function compile(sourceName, outputName, transform = (source) => source) {
  const sourcePath = new URL(`../src/utils/${sourceName}`, import.meta.url);
  const source = transform(await readFile(sourcePath, 'utf8'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  await writeFile(join(tempDir, outputName), compiled, 'utf8');
}

function record(id, loadingType, quantity = 10) {
  return {
    id,
    sku: 'SKU-1',
    shopName: 'Bestby',
    loadingType,
    status: 'pending',
    poolStatus: 'pending_purchase',
    assignedBuyerEmail: 'buyer@example.com',
    purchaseQuantity: quantity,
    confirmedPurchaseQuantity: null,
    purchasePrice: 5,
    freightCost: 0,
    totalAmount: quantity * 5,
    cartonCount: null,
    unitsPerCarton: null,
    tailQuantity: 0,
    mixedGroups: [],
    unitCbm: 0.01,
    totalCbm: quantity * 0.01,
    createdAt: id,
  };
}

function imported(id, loadingType, quantity = 20) {
  return {
    record: record(id, loadingType, quantity),
    providedFields: ['sku', 'shopName', 'loadingType', 'purchaseQuantity'],
  };
}

try {
  await compile('number.ts', 'number.mjs');
  await compile('purchaseRecords.ts', 'purchaseRecords.mjs', (source) => (
    source.replace("'./number'", "'./number.mjs'")
  ));
  await compile('purchaseOrderImports.ts', 'purchaseOrderImports.mjs', (source) => (
    source.replace("'./purchaseRecords'", "'./purchaseRecords.mjs'")
  ));
  const { mergeImportedPurchaseOrders } = await import(`file:///${join(tempDir, 'purchaseOrderImports.mjs').replaceAll('\\', '/')}`);

  let result = mergeImportedPurchaseOrders(
    [record('2026-01-01', '整柜')],
    [imported('new-guantong', '冠通')],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 0);
  assert.equal(result.createdCount, 1);
  assert.equal(result.records[0].id, 'new-guantong');

  result = mergeImportedPurchaseOrders(
    [record('2026-01-01', '冠通')],
    [imported('new-container', '整柜')],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 0);
  assert.equal(result.createdCount, 1);

  result = mergeImportedPurchaseOrders(
    [record('2026-01-01', '整柜', 10)],
    [imported('ignored-id', '整柜', 30)],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(result.records[0].id, '2026-01-01');
  assert.equal(result.records[0].purchaseQuantity, 30);

  result = mergeImportedPurchaseOrders(
    [record('2026-01-01', '整柜')],
    [imported('ignored-id', '')],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);

  result = mergeImportedPurchaseOrders(
    [],
    [imported('container', '整柜'), imported('guantong', '冠通')],
    'buyer@example.com',
  );
  assert.equal(result.createdCount, 2);
  assert.deepEqual(result.records.map((item) => item.loadingType), ['整柜', '冠通']);

  console.log('purchase order loading type import tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
