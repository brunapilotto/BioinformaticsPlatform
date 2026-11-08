import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp, tempDir, testAnalysis, touchFastqs, waitFor } from './helpers.js';

// Análises do tipo comando rodam um shell de verdade: nada aqui é simulado.
const commandAnalysis = (command, overrides = {}, outdir = '/tmp/saida') => testAnalysis({ kind: 'command', command, pipeline: '', revision: '', ...overrides }, {}, outdir);

async function setup(t, command, { overrides, samples = true } = {}) {
  const dir = tempDir(t);
  const fastqs = join(dir, 'fastqs');
  // Conteúdo de texto: o cat junta os arquivos e o teste confere a ordem das lanes.
  for (const name of ['A_L001', 'A_L002', 'B_L001']) {
    for (const r of ['R1', 'R2']) {
      touchFastqs(fastqs, [`${name}_${r}_001.fastq.gz`]);
      writeFileSync(join(fastqs, `${name}_${r}_001.fastq.gz`), `${name}_${r}\n`);
    }
  }
  const app = await startApp(t);
  const outdir = join(dir, 'resultados');
  const analysis = commandAnalysis(command, overrides, outdir);
  if (!samples) analysis.schema = JSON.stringify({ fields: [{ key: 'outdir', type: 'folder', default: outdir }, { key: 'nome', type: 'text', required: true }] });
  const saved = await app.api('POST', '/api/analyses', analysis);
  assert.equal(saved.status, 200, saved.body?.error);
  let counter = 0;
  const dispatch = (mode, extra = {}) => {
    counter += 1;
    return app.api('POST', '/api/runs', {
      runId: `run-cmd${counter}`, analysisId: 'teste', source: { type: 'local', path: fastqs }, sampleIds: ['A', 'B'], params: { outdir }, mode, ...extra,
    });
  };
  const finished = (id) => waitFor(async () => {
    const { body } = await app.api('GET', `/api/runs/${id}`);
    return body.jobs.every((j) => !['queued', 'downloading', 'running'].includes(j.state)) ? body : null;
  }, { label: `fim de ${id}` });
  return { app, dir, fastqs, outdir, dispatch, finished };
}

const CAT = 'cat {r1} > {outdir}/{sample}_R1.fastq.gz\ncat {r2} > {outdir}/{sample}_R2.fastq.gz';

test('comando por amostra, uma por vez: subpasta de cada amostra criada e lanes em ordem', async (t) => {
  const { app, outdir, dispatch, finished } = await setup(t, CAT);
  const run = await finished((await dispatch('sequential')).body.id);
  assert.deepEqual(run.jobs.map((j) => j.state), ['succeeded', 'succeeded']);
  assert.equal(readFileSync(join(outdir, 'A', 'A_R1.fastq.gz'), 'utf8'), 'A_L001_R1\nA_L002_R1\n');
  assert.equal(readFileSync(join(outdir, 'B', 'B_R2.fastq.gz'), 'utf8'), 'B_L001_R2\n');
  assert.equal(run.kind, 'command');
  assert.equal(run.jobs[0].message, null, 'sem aviso de link da Seqera');
  assert.equal(run.jobs[0].workDir, null);
  assert.equal(run.jobs[0].log, join(run.jobs[0].dir, 'comando.out'));
  assert.match(run.jobs[0].command, /^#!\/bin\/bash\n/);
  assert.ok(existsSync(join(app.store.getJob(run.jobs[0].id).dir, 'comando.sh')));
});

test('comando por amostra, todas ao mesmo tempo: 1 job, todas as amostras na pasta de resultados', async (t) => {
  const { outdir, dispatch, finished } = await setup(t, CAT);
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.jobs.length, 1);
  assert.equal(run.jobs[0].state, 'succeeded', run.jobs[0].message);
  assert.equal(readFileSync(join(outdir, 'A_R2.fastq.gz'), 'utf8'), 'A_L001_R2\nA_L002_R2\n');
  assert.equal(readFileSync(join(outdir, 'B_R1.fastq.gz'), 'utf8'), 'B_L001_R1\n');
});

test('comando com samplesheet roda uma vez com todas as amostras', async (t) => {
  const { outdir, dispatch, finished } = await setup(t, 'cut -d, -f1 {samplesheet} > {outdir}/amostras.txt');
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.jobs[0].state, 'succeeded', run.jobs[0].message);
  assert.equal(readFileSync(join(outdir, 'amostras.txt'), 'utf8'), 'sample\nA\nA\nB\n');
});

test('falha do comando: últimas linhas do log e amostra que falhou', async (t) => {
  const { dispatch, finished } = await setup(t, 'echo "processando {sample}"\n[ {sample} != B ] || { echo "erro em B" >&2; exit 4; }');
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.jobs[0].state, 'failed');
  assert.match(run.jobs[0].message, /erro em B/);
  assert.match(run.jobs[0].message, /Falhou na amostra B/);
  assert.doesNotMatch(run.jobs[0].message, /Falhou na amostra A/);
});

test('cancelar encerra o comando e executar novamente guarda o log anterior', async (t) => {
  const { app, dispatch, finished } = await setup(t, 'echo inicio\nsleep 60');
  const res = await dispatch('parallel');
  const jobId = res.body.jobs[0].id;
  const started = await waitFor(() => {
    const j = app.store.getJob(jobId);
    return j.pid && existsSync(join(j.dir, 'comando.out')) && readFileSync(join(j.dir, 'comando.out'), 'utf8').includes('inicio') ? j : null;
  }, { label: 'início do comando' });
  await app.api('POST', `/api/runs/${res.body.id}/cancel`, {});
  const cancelled = await finished(res.body.id);
  assert.equal(cancelled.jobs[0].state, 'cancelled');
  assert.equal(cancelled.jobs[0].canResume, true);
  assert.throws(() => process.kill(started.pid, 0), 'processo encerrado');

  assert.equal((await app.api('POST', `/api/jobs/${jobId}/resume`, {})).status, 200);
  await waitFor(() => existsSync(join(started.dir, 'comando.tentativa-1.out')), { label: 'log da tentativa anterior' });
  assert.match(readFileSync(join(started.dir, 'comando.tentativa-1.out'), 'utf8'), /inicio/);
  await app.api('POST', `/api/runs/${res.body.id}/cancel`, {});
  const again = await finished(res.body.id);
  assert.equal(again.jobs[0].attempts.length, 1);
});

test('comando sem amostras: roda uma vez só com os parâmetros', async (t) => {
  const { app, outdir, finished } = await setup(t, 'echo {nome} > {outdir}/nome.txt\npython3 -c \'import json; print(json.load(open("params.json"))["nome"])\'', { samples: false });
  const wrongSource = await app.api('POST', '/api/runs', { runId: 'run-semamostra0', analysisId: 'teste', source: { type: 'local', path: '/tmp' }, sampleIds: ['A'], params: { nome: 'x' }, mode: 'parallel' });
  assert.equal(wrongSource.status, 400);
  assert.match(wrongSource.body.error, /não usa amostras/);
  assert.equal((await app.api('POST', '/api/scan', { analysisId: 'teste', path: '/tmp' })).status, 400);

  const res = await app.api('POST', '/api/runs', { runId: 'run-semamostra1', analysisId: 'teste', source: { type: 'none' }, sampleIds: [], params: { nome: "Ana d'Ávila" } });
  assert.equal(res.status, 200, res.body?.error);
  assert.deepEqual([res.body.n, res.body.mode, res.body.etaMin, res.body.jobs.length], [0, 'single', 10, 1]);
  const run = await finished(res.body.id);
  assert.equal(run.jobs[0].state, 'succeeded', run.jobs[0].message);
  assert.equal(readFileSync(join(outdir, 'nome.txt'), 'utf8'), "Ana d'Ávila\n");
  assert.equal(readFileSync(run.jobs[0].log, 'utf8'), "Ana d'Ávila\n", 'o script lê o params.json da pasta do job');
  assert.ok(!existsSync(join(run.jobs[0].dir, 'samplesheet.csv')));
  assert.deepEqual(run.jobs[0].params, { outdir, nome: "Ana d'Ávila" });
});

test('análise com amostras recusa disparo sem amostras', async (t) => {
  const { app } = await setup(t, CAT);
  const res = await app.api('POST', '/api/runs', { runId: 'run-semamostra2', analysisId: 'teste', source: { type: 'none' }, sampleIds: [], params: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Selecione as amostras/);
});

test('reinício: comando vivo é retomado e reconhecido pelo comando.sh', async (t) => {
  const { app, dispatch } = await setup(t, 'echo inicio\nsleep 60');
  const res = await dispatch('parallel');
  const jobId = res.body.jobs[0].id;
  const { pid } = await waitFor(() => {
    const j = app.store.getJob(jobId);
    return j.pid && existsSync(join(j.dir, 'comando.out')) && readFileSync(join(j.dir, 'comando.out'), 'utf8').includes('inicio') ? j : null;
  }, { label: 'início do comando' });
  await app.close();
  assert.doesNotThrow(() => process.kill(pid, 0), 'o comando sobrevive ao encerramento da plataforma');

  const reborn = await startApp(t, { dataDir: app.dir });
  assert.equal(reborn.store.getJob(jobId).state, 'running', 'retomado');
  process.kill(-pid, 'SIGKILL');
  await waitFor(() => reborn.store.getJob(jobId).state === 'interrupted', { label: 'interrupção' });
});
