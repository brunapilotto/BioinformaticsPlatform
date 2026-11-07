import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadFiles, listProjectFastqs, searchProjects, whoami } from '../server/basespace.js';
import { fakeNextflow, startApp, tempDir, testAnalysis, waitFor, writeExecutable } from './helpers.js';

// CLI de mentira: responde como o `bs` e registra cada chamada em calls.log.
function fakeBs(dir, { auth = true } = {}) {
  const calls = join(dir, 'calls.log');
  const path = writeExecutable(join(dir, 'bin', 'bs'), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const flag = (name) => (args.find((a) => a.startsWith('--' + name + '=')) || '').split('=').slice(1).join('=');
const out = (v) => console.log(JSON.stringify(v));
const cmd = args.slice(0, 2).join(' ');
if (args[0] === 'whoami') {
  if (!${auth}) { console.error('ERROR: no access token found'); process.exit(1); }
  console.log('+-------+----------------+');
  console.log('| Name  | Fulana de Tal  |');
  console.log('| Id    | 123            |');
  console.log('| Email | fulana@lab.org |');
  console.log('| Host  | https://api.basespace.illumina.com |');
  console.log('+-------+----------------+');
} else if (cmd === 'list projects') {
  const term = flag('filter-term').replace('(?i)', '').replace(/\\\\/g, '');
  const all = [{ Id: 1, Name: 'RUN0412' }, { Id: 2, Name: 'RUN0412_reanalise' }, { Id: 3, Name: 'Viral' }, { Id: 4, Name: 'a.b' }, { Id: 5, Name: '-traco' }];
  out(all.filter((p) => p.Name.toLowerCase().includes(term.toLowerCase())));
} else if (cmd === 'list datasets') {
  out(flag('project-id') === '3' ? [{ Id: 'ds.a', Name: 'A' }, { Id: 'ds.b', Name: 'B' }, { Id: 'ds.c', Name: 'C' }] : []);
} else if (cmd === 'contents dataset') {
  const id = flag('id');
  const s = id.slice(3).toUpperCase();
  if (id === 'ds.c') out([{ Id: 'f', FilePath: 'C_S3_L001_R1_001.fastq.gz', Size: 5 }]);
  else out([
    { Id: 'f1', FilePath: s + '_S1_L001_R1_001.fastq.gz', Size: 5 },
    { Id: 'f2', FilePath: 'sub/' + s + '_S1_L001_R2_001.fastq.gz', Size: 5 },
    { Id: 'f3', FilePath: s + '.json', Size: 5 },
  ]);
} else if (cmd === 'download dataset') {
  if (process.env.BS_HANG) setTimeout(() => {}, 60000);
  if (process.env.BS_HANG) return;
  const id = flag('id');
  const dest = args[args.indexOf('-o') + 1];
  const s = id.slice(3).toUpperCase();
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, s + '_S1_L001_R1_001.fastq.gz'), 'x'.repeat(5));
  fs.writeFileSync(path.join(dest, s + '_S1_L001_R2_001.fastq.gz'), process.env.BS_SHORT ? 'x' : 'x'.repeat(5));
} else {
  console.error('comando desconhecido: ' + args.join(' '));
  process.exit(2);
}
`);
  return { path, calls };
}

const callsOf = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('whoami: sucesso, sem autenticação e sem CLI', async (t) => {
  const ok = fakeBs(tempDir(t));
  assert.deepEqual(await whoami(ok.path), { account: 'fulana@lab.org', host: 'https://api.basespace.illumina.com' });
  const noAuth = fakeBs(tempDir(t), { auth: false });
  await assert.rejects(whoami(noAuth.path), /bs auth.*no access token/);
  await assert.rejects(whoami('/nao/existe/bs'), /CLI do BaseSpace não encontrada/);
});

test('busca de projeto: 0, 1 e vários resultados, sem interpretar o texto como regex ou opção', async (t) => {
  const { path, calls } = fakeBs(tempDir(t));
  assert.deepEqual(await searchProjects(path, 'nao-existe'), []);
  assert.deepEqual((await searchProjects(path, 'viral')).map((p) => p.id), ['3']);
  assert.equal((await searchProjects(path, 'run04')).length, 2);
  assert.deepEqual((await searchProjects(path, 'RUN0412')).map((p) => p.id), ['1'], 'nome exato vence');
  assert.deepEqual((await searchProjects(path, '-traco')).map((p) => p.id), ['5']);
  await assert.rejects(searchProjects(path, '  '), /Informe o nome/);

  await searchProjects(path, 'a.b');
  const last = callsOf(calls).at(-1);
  assert.ok(last.includes('--filter-term=(?i)a\\.b'), 'ponto escapado');
  assert.ok(last.includes('--filter-field=Name'));
  assert.ok(callsOf(calls).every((args) => args[0] === 'list' && args[1] === 'projects'), 'só consulta projetos, sem varrer a conta');
});

test('listagem usa só o projeto escolhido e filtra pelo padrão', async (t) => {
  const { path, calls } = fakeBs(tempDir(t));
  const files = await listProjectFastqs(path, '3', { pattern: '*_R{1,2}_001.fastq.gz' });
  assert.equal(files.length, 5);
  assert.deepEqual(files[1], { name: 'A_S1_L001_R2_001.fastq.gz', path: 'basespace://ds.a/A_S1_L001_R2_001.fastq.gz', size: 5, dataset: 'ds.a' });
  assert.deepEqual(callsOf(calls)[0], ['list', 'datasets', '--project-id=3', '-f', 'json']);
});

test('download: só os datasets pedidos, reaproveita arquivos e detecta download incompleto', async (t) => {
  const dir = tempDir(t);
  const { path, calls } = fakeBs(dir);
  const dest = join(dir, 'destino');
  const files = (await listProjectFastqs(path, '3')).filter((f) => f.dataset === 'ds.a');
  const before = callsOf(calls).length;

  const local = await downloadFiles(path, files, dest);
  assert.equal(local.get(files[0].path), join(dest, 'ds.a', files[0].name));
  const downloads = callsOf(calls).slice(before);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][2], '--id=ds.a');

  await downloadFiles(path, files, dest);
  assert.equal(callsOf(calls).length, before + 1, 'não baixa de novo');

  appendFileSync(local.get(files[0].path), 'corrompido');
  await downloadFiles(path, files, dest);
  assert.equal(callsOf(calls).length, before + 2, 'tamanho diferente força novo download');

  process.env.BS_SHORT = '1';
  t.after(() => { delete process.env.BS_SHORT; });
  await assert.rejects(downloadFiles(path, files, join(dir, 'outro')), /Download incompleto/);
});

test('fluxo pela API: verificação no Admin, busca por nome, disparo com download', async (t) => {
  const dir = tempDir(t);
  const bs = fakeBs(dir);
  const nf = fakeNextflow(dir);
  const app = await startApp(t, { settings: { bsPath: bs.path, nextflowPath: nf.path } });
  const outdir = join(dir, 'res');
  await app.api('POST', '/api/analyses', testAnalysis({}, { pattern: '*_R{1,2}_001.fastq.gz' }, outdir));

  const check = await app.api('POST', '/api/test/basespace', {});
  assert.equal(check.body.ok, true);
  assert.equal(check.body.account, 'fulana@lab.org');
  const saved = (await app.api('GET', '/api/bootstrap')).body.connections.bsCheck;
  assert.equal(saved.ok, true, 'check fica salvo');

  const many = await app.api('POST', '/api/basespace/scan', { analysisId: 'teste', query: 'run04' });
  assert.equal(many.body.matches.length, 2);
  assert.deepEqual(many.body.samples, []);

  const none = await app.api('POST', '/api/basespace/scan', { analysisId: 'teste', query: 'zzz' });
  assert.deepEqual(none.body.matches, []);
  assert.equal(none.body.project, null);

  const scan = await app.api('POST', '/api/basespace/scan', { analysisId: 'teste', query: 'viral' });
  assert.deepEqual(scan.body.project, { id: '3', name: 'Viral' });
  assert.deepEqual(scan.body.samples.map((s) => [s.name, s.invalid]), [['A', false], ['B', false], ['C', true]]);

  const res = await app.api('POST', '/api/runs', {
    runId: 'run-basespace', analysisId: 'teste', mode: 'parallel', params: { outdir },
    source: { type: 'basespace', projectId: '3', projectName: 'Viral' }, sampleIds: ['A'],
  });
  assert.equal(res.status, 200);
  const job = await waitFor(() => {
    const j = app.store.jobsForRun('run-basespace')[0];
    return ['succeeded', 'failed'].includes(j.state) ? j : null;
  }, { label: 'fim do job' });
  assert.equal(job.state, 'succeeded', job.message);

  const downloads = callsOf(bs.calls).filter((c) => c[0] === 'download');
  assert.deepEqual(downloads.map((c) => c[2]), ['--id=ds.a'], 'baixa só a amostra selecionada');
  const sheet = readFileSync(join(job.dir, 'samplesheet.csv'), 'utf8');
  assert.ok(sheet.includes(join(app.dir, 'basespace', '3', 'ds.a', 'A_S1_L001_R1_001.fastq.gz')), sheet);
  assert.ok(!sheet.includes('basespace://'));

  const invalid = await app.api('POST', '/api/runs', {
    runId: 'run-basespace2', analysisId: 'teste', mode: 'parallel', params: { outdir },
    source: { type: 'basespace', projectId: '3', projectName: 'Viral' }, sampleIds: ['C'],
  });
  assert.equal(invalid.status, 409);

  await app.api('PUT', '/api/settings', { bsPath: '/outro/bs' });
  assert.equal((await app.api('GET', '/api/bootstrap')).body.connections.bsCheck, null, 'trocar o caminho exige nova verificação');
});

test('cancelar durante o download encerra a CLI e não inicia o Nextflow', async (t) => {
  const dir = tempDir(t);
  const bs = fakeBs(dir);
  const nf = fakeNextflow(dir);
  const app = await startApp(t, { settings: { bsPath: bs.path, nextflowPath: nf.path } });
  const outdir = join(dir, 'res');
  await app.api('POST', '/api/analyses', testAnalysis({}, {}, outdir));
  await app.api('POST', '/api/basespace/scan', { analysisId: 'teste', query: 'viral' });
  process.env.BS_HANG = '1';
  t.after(() => { delete process.env.BS_HANG; });
  await app.api('POST', '/api/runs', {
    runId: 'run-cancelbs', analysisId: 'teste', mode: 'parallel', params: { outdir },
    source: { type: 'basespace', projectId: '3', projectName: 'Viral' }, sampleIds: ['A'],
  });
  await waitFor(() => callsOf(bs.calls).some((c) => c[0] === 'download'), { label: 'início do download' });
  assert.equal(app.store.jobsForRun('run-cancelbs')[0].state, 'downloading');
  await app.api('POST', '/api/runs/run-cancelbs/cancel', {});
  await waitFor(() => app.store.jobsForRun('run-cancelbs')[0].state === 'cancelled', { label: 'cancelamento' });
  assert.equal(existsSync(nf.eventLog), false, 'o Nextflow não chegou a rodar');
});

test('falha da CLI no download marca o job como falho', async (t) => {
  const dir = tempDir(t);
  const bs = fakeBs(dir);
  const nf = fakeNextflow(dir);
  const app = await startApp(t, { settings: { bsPath: bs.path, nextflowPath: nf.path } });
  const outdir = join(dir, 'res');
  await app.api('POST', '/api/analyses', testAnalysis({}, {}, outdir));
  await app.api('POST', '/api/basespace/scan', { analysisId: 'teste', query: 'viral' });
  await app.api('PUT', '/api/settings', { bsPath: '/nao/existe/bs' });
  await app.api('POST', '/api/runs', {
    runId: 'run-semcli', analysisId: 'teste', mode: 'parallel', params: { outdir },
    source: { type: 'basespace', projectId: '3', projectName: 'Viral' }, sampleIds: ['A'],
  });
  const job = await waitFor(() => {
    const j = app.store.jobsForRun('run-semcli')[0];
    return j.state === 'failed' ? j : null;
  }, { label: 'falha' });
  assert.match(job.message, /CLI do BaseSpace não encontrada/);
});
