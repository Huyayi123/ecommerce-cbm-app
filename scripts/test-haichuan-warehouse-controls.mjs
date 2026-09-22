import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const tempDir = await mkdtemp(join(tmpdir(), 'haichuan-warehouse-controls-'));

async function compile(sourceName, outputName, transform = (source) => source) {
  const sourcePath = new URL(`../src/utils/${sourceName}`, import.meta.url);
  const source = transform(await readFile(sourcePath, 'utf8'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await writeFile(join(tempDir, outputName), compiled, 'utf8');
}

try {
  await compile('number.ts', 'number.mjs');
  await compile('purchaseRecords.ts', 'purchaseRecords.mjs', (source) => source.replace("'./number'", "'./number.mjs'"));
  await compile('haichuan.ts', 'haichuan.mjs', (source) => source
    .replace("'./number'", "'./number.mjs'")
    .replace("'./purchaseRecords'", "'./purchaseRecords.mjs'"));
  const controls = await import(`file:///${join(tempDir, 'haichuan.mjs').replaceAll('\\', '/')}`);

  const lots = [
    { id: 'available', remainingCartonCount: 4, reservedCartonCount: 0 },
    { id: 'frozen', remainingCartonCount: 3, reservedCartonCount: 1 },
    { id: 'empty', remainingCartonCount: 0, reservedCartonCount: 0 },
  ];
  assert.deepEqual(controls.selectableHaichuanWarehouseLots(lots).map((lot) => lot.id), ['available']);
  assert.deepEqual(controls.toggleAllHaichuanWarehouseLots({ hidden: 2 }, lots), { hidden: 2, available: 4 });
  assert.deepEqual(controls.toggleAllHaichuanWarehouseLots({ hidden: 2, available: 4 }, lots), { hidden: 2 });

  const lot = { initialProductQuantity: 100, remainingProductQuantity: 70, initialCbm: 2, unitCbm: 0.02 };
  assert.deepEqual(controls.previewHaichuanWarehouseQuantity(lot, 80), {
    consumed: 30,
    remaining: 50,
    remainingCbm: 1,
    valid: true,
  });
  assert.equal(controls.previewHaichuanWarehouseQuantity(lot, 29).valid, false);

  console.log('Haichuan warehouse controls tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
