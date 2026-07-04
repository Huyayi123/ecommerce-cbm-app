import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const sourcePath = new URL('../src/utils/stockMonths.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const tempDir = await mkdtemp(join(tmpdir(), 'stock-months-'));
const modulePath = join(tempDir, 'stockMonths.mjs');

try {
  await writeFile(modulePath, compiled, 'utf8');
  const { stockMonthsForMonthlySales } = await import(`file:///${modulePath.replaceAll('\\', '/')}`);

  assert.equal(stockMonthsForMonthlySales(101, new Date('2026-07-03T00:00:00+08:00')), 7);
  assert.equal(stockMonthsForMonthlySales(80, new Date('2026-07-03T00:00:00+08:00')), 6);
  assert.equal(stockMonthsForMonthlySales(50, new Date('2026-07-03T00:00:00+08:00')), 5);
  assert.equal(stockMonthsForMonthlySales(20, new Date('2026-07-03T00:00:00+08:00')), 4);
  assert.equal(stockMonthsForMonthlySales(10, new Date('2026-07-03T00:00:00+08:00')), 3);
  assert.equal(stockMonthsForMonthlySales(9, new Date('2026-07-03T00:00:00+08:00')), 2);

  assert.equal(stockMonthsForMonthlySales(101, new Date('2026-08-03T00:00:00+08:00')), 8);
  assert.equal(stockMonthsForMonthlySales(80, new Date('2026-08-03T00:00:00+08:00')), 7);
  assert.equal(stockMonthsForMonthlySales(50, new Date('2026-08-03T00:00:00+08:00')), 6);
  assert.equal(stockMonthsForMonthlySales(20, new Date('2026-08-03T00:00:00+08:00')), 6);
  assert.equal(stockMonthsForMonthlySales(10, new Date('2026-08-03T00:00:00+08:00')), 4);
  assert.equal(stockMonthsForMonthlySales(9, new Date('2026-08-03T00:00:00+08:00')), 3);

  assert.equal(stockMonthsForMonthlySales(101, new Date('2026-09-03T00:00:00+08:00')), 7);
  assert.equal(stockMonthsForMonthlySales(101, new Date('2026-10-03T00:00:00+08:00')), 6);
  assert.equal(stockMonthsForMonthlySales(80, new Date('2026-10-03T00:00:00+08:00')), 5);
  assert.equal(stockMonthsForMonthlySales(50, new Date('2026-10-03T00:00:00+08:00')), 4);
  assert.equal(stockMonthsForMonthlySales(20, new Date('2026-10-03T00:00:00+08:00')), 3);
  assert.equal(stockMonthsForMonthlySales(19, new Date('2026-10-03T00:00:00+08:00')), 2);

  assert.equal(stockMonthsForMonthlySales(101, new Date('2026-11-03T00:00:00+08:00')), 5);
  assert.equal(stockMonthsForMonthlySales(50, new Date('2026-11-03T00:00:00+08:00')), 4);
  assert.equal(stockMonthsForMonthlySales(20, new Date('2026-11-03T00:00:00+08:00')), 3);
  assert.equal(stockMonthsForMonthlySales(19, new Date('2026-11-03T00:00:00+08:00')), 2);

  assert.equal(stockMonthsForMonthlySales(51, new Date('2026-12-03T00:00:00+08:00')), 4);
  assert.equal(stockMonthsForMonthlySales(50, new Date('2026-12-03T00:00:00+08:00')), 3);
  assert.equal(stockMonthsForMonthlySales(20, new Date('2026-12-03T00:00:00+08:00')), 3);
  assert.equal(stockMonthsForMonthlySales(19, new Date('2026-12-03T00:00:00+08:00')), 2);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
