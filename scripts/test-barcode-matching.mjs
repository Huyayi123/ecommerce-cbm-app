import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const sourcePath = new URL('../src/utils/barcodeMatching.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tempDir = await mkdtemp(join(tmpdir(), 'barcode-matching-'));
const modulePath = join(tempDir, 'barcodeMatching.mjs');

try {
  await writeFile(modulePath, compiled, 'utf8');
  const { normalizeBarcodeSku, matchesBarcodeSku, filterByBarcodeSku } = await import(`file:///${modulePath.replaceAll('\\', '/')}`);
  const records = [
    { id: 'oldest', sku: 'SKU-100', productDetails: [] },
    { id: 'newer', sku: 'sku-100', productDetails: [] },
    { id: 'mixed', sku: 'SKU-200', productDetails: [{ sku: 'MIX-300' }] },
  ];

  assert.equal(normalizeBarcodeSku('  sku-100\r\n'), 'SKU-100');
  assert.equal(matchesBarcodeSku(records[0], 'sku-100'), true);
  assert.equal(matchesBarcodeSku(records[0], 'SKU-10'), false);
  assert.equal(matchesBarcodeSku(records[2], 'mix-300'), true);
  assert.deepEqual(filterByBarcodeSku(records, ' sku-100 ').map((record) => record.id), ['oldest', 'newer']);
  assert.deepEqual(filterByBarcodeSku(records, 'missing'), []);
  assert.deepEqual(filterByBarcodeSku(records, ''), records);
  console.log('barcode matching tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
