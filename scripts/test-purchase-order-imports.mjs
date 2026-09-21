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
  const { enrichImportedPurchaseOrderCbms, mergeImportedPurchaseOrders } = await import(`file:///${join(tempDir, 'purchaseOrderImports.mjs').replaceAll('\\', '/')}`);

  const skuItems = [
    { sku: 'SKU-1', shopName: 'Bestby', unitCbm: 0.015 },
    { sku: 'SKU-1', shopName: 'Arfast', unitCbm: 0.025 },
  ];
  let enriched = enrichImportedPurchaseOrderCbms([
    { ...imported('missing-cbm', '整柜', 20), record: { ...record('missing-cbm', '整柜', 20), unitCbm: 0, totalCbm: 0 } },
  ], skuItems);
  assert.equal(enriched[0].record.unitCbm, 0.015);
  assert.equal(enriched[0].record.totalCbm, 0.3);
  assert.equal(enriched[0].providedFields.includes('unitCbm'), false);

  enriched = enrichImportedPurchaseOrderCbms([
    { ...imported('shop-match', '整柜', 20), record: { ...record('shop-match', '整柜', 20), shopName: 'Arfast', unitCbm: 0, totalCbm: 0 } },
  ], skuItems);
  assert.equal(enriched[0].record.unitCbm, 0.025);
  assert.equal(enriched[0].record.totalCbm, 0.5);

  enriched = enrichImportedPurchaseOrderCbms([
    { ...imported('explicit-cbm', '整柜', 20), record: { ...record('explicit-cbm', '整柜', 20), unitCbm: 0.02, totalCbm: 0.4 }, providedFields: ['sku', 'shopName', 'loadingType', 'purchaseQuantity', 'unitCbm'] },
  ], skuItems);
  assert.equal(enriched[0].record.unitCbm, 0.02);
  assert.equal(enriched[0].record.totalCbm, 0.4);

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

  const existingWithCbm = record('existing-cbm', '整柜', 10);
  result = mergeImportedPurchaseOrders(
    [existingWithCbm],
    enrichImportedPurchaseOrderCbms([
      { ...imported('ignored-id', '整柜', 30), record: { ...record('ignored-id', '整柜', 30), unitCbm: 0, totalCbm: 0 } },
    ], skuItems),
    'buyer@example.com',
  );
  assert.equal(result.records[0].unitCbm, 0.01);
  assert.equal(result.records[0].totalCbm, 0.3);

  result = mergeImportedPurchaseOrders(
    [{ ...record('existing-zero-cbm', '整柜', 10), unitCbm: 0, totalCbm: 0 }],
    enrichImportedPurchaseOrderCbms([
      { ...imported('ignored-id', '整柜', 30), record: { ...record('ignored-id', '整柜', 30), unitCbm: 0, totalCbm: 0 } },
    ], skuItems),
    'buyer@example.com',
  );
  assert.equal(result.records[0].unitCbm, 0.015);
  assert.equal(result.records[0].totalCbm, 0.45);

  result = mergeImportedPurchaseOrders(
    [record('2026-01-01', '整柜')],
    [imported('ignored-id', '')],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);

  result = mergeImportedPurchaseOrders(
    [],
    [imported('container', '整柜'), imported('guantong', '冠通'), imported('haichuan', '海川')],
    'buyer@example.com',
  );
  assert.equal(result.createdCount, 3);
  assert.deepEqual(result.records.map((item) => item.loadingType), ['整柜', '冠通', '海川']);

  result = mergeImportedPurchaseOrders(
    [record('existing-container', '整柜'), record('existing-guantong', '冠通')],
    [imported('new-haichuan', '海川')],
    'buyer@example.com',
  );
  assert.equal(result.updatedCount, 0);
  assert.equal(result.createdCount, 1);
  assert.equal(result.records[0].id, 'new-haichuan');

  console.log('purchase order import tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
