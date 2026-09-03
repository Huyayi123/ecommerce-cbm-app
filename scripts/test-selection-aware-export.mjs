import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const sourcePath = new URL('../src/utils/selectionAwareExport.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tempDir = await mkdtemp(join(tmpdir(), 'selection-aware-export-'));
const modulePath = join(tempDir, 'selectionAwareExport.mjs');

try {
  await writeFile(modulePath, compiled, 'utf8');
  const { recordsForSelectionAwareExport } = await import(`file:///${modulePath.replaceAll('\\', '/')}`);
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const filtered = [all[0], all[1]];

  assert.deepEqual(recordsForSelectionAwareExport(all, filtered, new Set()), filtered);
  assert.deepEqual(recordsForSelectionAwareExport(all, filtered, new Set(['b'])), [all[1]]);
  assert.deepEqual(recordsForSelectionAwareExport(all, filtered, new Set(['c'])), [all[2]]);
  assert.deepEqual(recordsForSelectionAwareExport(all, filtered, new Set(['missing'])), filtered);
  assert.deepEqual(recordsForSelectionAwareExport(all, filtered, new Set(['a', 'c'])), [all[0], all[2]]);

  console.log('selection-aware export tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
