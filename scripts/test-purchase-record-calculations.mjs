import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const tempDir = await mkdtemp(join(tmpdir(), 'purchase-record-calculations-'));

function mixedGroup(cartonCount) {
  return {
    id: `group-${cartonCount}`,
    groupName: '混装',
    cartonCount,
    lines: [{
      id: 'line-1',
      sku: 'SKU-MIXED',
      productName: 'Mixed product',
      quantity: 20,
      purchasePrice: 3,
      unitCbm: 0.002,
      totalAmount: 60,
      totalCbm: 0.04,
    }],
  };
}

function record(cartonCount, tailQuantity, mixedGroups = []) {
  return {
    cartonCount,
    tailQuantity,
    mixedGroups,
  };
}

try {
  const numberSource = await readFile(new URL('../src/utils/number.ts', import.meta.url), 'utf8');
  const purchaseSource = (await readFile(new URL('../src/utils/purchaseRecords.ts', import.meta.url), 'utf8'))
    .replace("'./number'", "'./number.mjs'");
  const compilerOptions = { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 };
  await writeFile(join(tempDir, 'number.mjs'), ts.transpileModule(numberSource, { compilerOptions }).outputText, 'utf8');
  await writeFile(join(tempDir, 'purchaseRecords.mjs'), ts.transpileModule(purchaseSource, { compilerOptions }).outputText, 'utf8');

  const calculations = await import(`file:///${join(tempDir, 'purchaseRecords.mjs').replaceAll('\\', '/')}`);
  const oneMixedGroup = [mixedGroup(1)];
  const multipleMixedGroups = [mixedGroup(1), mixedGroup(3)];

  assert.equal(calculations.packageCountFor(record(3, 0)), 3);
  assert.equal(calculations.packageCountFor(record(0, 40)), 1);
  assert.equal(calculations.packageCountFor(record(3, 10)), 4);
  assert.equal(calculations.packageCountFor(record(0, 40, oneMixedGroup)), 1);
  assert.equal(calculations.packageCountFor(record(3, 10, multipleMixedGroups)), 4);
  assert.equal(calculations.packageCountFor(record(0, 0, oneMixedGroup)), 0);

  const mixedRecord = record(0, 40, oneMixedGroup);
  assert.equal(calculations.mixedQuantityFor(mixedRecord), 20);
  assert.equal(calculations.mixedAmountFor(mixedRecord), 60);
  assert.equal(calculations.mixedCbmFor(mixedRecord), 0.04);

  console.log('purchase record package count tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
