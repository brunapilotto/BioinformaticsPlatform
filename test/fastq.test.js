import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { globToRegex, parseFastqName, scanFolder } from '../server/fastq.js';
import { tempDir, touchFastqs } from './helpers.js';

const byName = (samples) => Object.fromEntries(samples.map((s) => [s.name, s]));

test('reconhece os formatos de nome de arquivo', () => {
  assert.deepEqual(parseFastqName('AM-1_S3_L002_R2_001.fastq.gz'), { sample: 'AM-1', lane: 'L002', read: 2, unit: '002|001' });
  assert.equal(parseFastqName('AM_S1_S2_L001_R1_001.fastq.gz').sample, 'AM_S1');
  assert.equal(parseFastqName('AM-1_S3_R1_001.fastq.gz').lane, null);
  assert.equal(parseFastqName('Foo_R2.fastq.gz').read, 2);
  assert.equal(parseFastqName('Foo.R1.fq.gz').sample, 'Foo');
  assert.equal(parseFastqName('Foo_2.fq.gz').read, 2);
  assert.equal(parseFastqName('Foo.fastq.gz').sample, 'Foo');
  assert.equal(parseFastqName('AM-1_S3_L001_I1_001.fastq.gz'), null, 'arquivo de índice não é read');
});

test('glob do schema aceita {1,2} e escapa o restante', () => {
  const re = globToRegex('*_R{1,2}_001.fastq.gz');
  assert.ok(re.test('A_S1_L001_R1_001.fastq.gz'));
  assert.ok(re.test('A_S1_L001_R2_001.fastq.gz'));
  assert.ok(!re.test('A_S1_L001_R3_001.fastq.gz'));
  assert.ok(!re.test('A_S1_L001_R1_001xfastq.gz'));
});

test('agrupa várias lanes na mesma amostra, inclusive em subpastas', async (t) => {
  const dir = tempDir(t);
  touchFastqs(dir, [
    'A_S1_L001_R1_001.fastq.gz', 'A_S1_L001_R2_001.fastq.gz',
    'sub/A_S1_L002_R1_001.fastq.gz', 'sub/A_S1_L002_R2_001.fastq.gz',
    'B_S2_L001_R1_001.fastq.gz', 'B_S2_L001_R2_001.fastq.gz',
    'notas.txt',
  ]);
  const { samples } = await scanFolder(dir, { pattern: '*_R{1,2}_001.fastq.gz' });
  assert.deepEqual(samples.map((s) => s.name), ['A', 'B']);
  const { A } = byName(samples);
  assert.equal(A.lanes, 2);
  assert.equal(A.units[1].r1, join(dir, 'sub/A_S1_L002_R1_001.fastq.gz'), 'guarda o caminho completo');
  assert.equal(A.invalid, false);
  assert.equal(A.sizeBytes, 40);
});

test('R2 ausente invalida a amostra, exceto com paired false', async (t) => {
  const dir = tempDir(t);
  touchFastqs(dir, ['C_S1_R1_001.fastq.gz']);
  const paired = await scanFolder(dir, {});
  assert.equal(paired.samples[0].reason, 'R2 ausente');
  assert.equal(paired.samples[0].selected, false);
  const single = await scanFolder(dir, { paired: false });
  assert.equal(single.samples[0].invalid, false);
  assert.equal(single.samples[0].selected, true);
});

test('R1 ausente e arquivo duplicado invalidam a amostra', async (t) => {
  const dir = tempDir(t);
  touchFastqs(dir, ['D_S1_L001_R2_001.fastq.gz', 'a/E_S1_L001_R1_001.fastq.gz', 'a/E_S1_L001_R2_001.fastq.gz', 'b/E_S1_L001_R1_001.fastq.gz', 'b/E_S1_L001_R2_001.fastq.gz']);
  const { D, E } = byName((await scanFolder(dir, {})).samples);
  assert.equal(D.reason, 'R1 ausente');
  assert.equal(E.reason, 'Arquivo duplicado');
});

test('Undetermined aparece desmarcada, sem ser inválida', async (t) => {
  const dir = tempDir(t);
  touchFastqs(dir, ['Undetermined_S0_R1_001.fastq.gz', 'Undetermined_S0_R2_001.fastq.gz']);
  const [sample] = (await scanFolder(dir, {})).samples;
  assert.equal(sample.invalid, false);
  assert.equal(sample.selected, false);
});

test('ordem natural, pastas ocultas ignoradas, link de pasta não seguido, link de arquivo aceito', async (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  touchFastqs(dir, ['S10_R1.fastq.gz', 'S10_R2.fastq.gz', 'S2_R1.fastq.gz', 'S2_R2.fastq.gz', '.oculta/X_R1.fastq.gz', '.oculta/X_R2.fastq.gz']);
  touchFastqs(outside, ['L_R1.fastq.gz', 'L_R2.fastq.gz', 'pasta/P_R1.fastq.gz', 'pasta/P_R2.fastq.gz']);
  symlinkSync(join(outside, 'L_R1.fastq.gz'), join(dir, 'L_R1.fastq.gz'));
  symlinkSync(join(outside, 'L_R2.fastq.gz'), join(dir, 'L_R2.fastq.gz'));
  symlinkSync(join(outside, 'pasta'), join(dir, 'link-pasta'));
  symlinkSync(dir, join(dir, 'ciclo'));
  const { samples } = await scanFolder(dir, {});
  assert.deepEqual(samples.map((s) => s.name), ['L', 'S2', 'S10']);
});

test('erros de pasta têm mensagem clara', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(scanFolder(join(dir, 'nao-existe'), {}), /Pasta não encontrada/);
  touchFastqs(dir, ['arq.fastq.gz']);
  await assert.rejects(scanFolder(join(dir, 'arq.fastq.gz'), {}), /Não é uma pasta/);
});
