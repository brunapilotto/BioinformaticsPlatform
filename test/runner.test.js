import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeNextflow, startApp, tempDir, testAnalysis, touchFastqs, waitFor } from './helpers.js';

const pairs = (...names) => names.flatMap((n) => [`${n}_R1.fastq.gz`, `${n}_R2.fastq.gz`]);
const events = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

async function setup(t, { token = 'tok-secreto', settings = {}, samples = ['A', 'B', 'C'] } = {}) {
  const dir = tempDir(t);
  const fastqs = join(dir, 'fastqs');
  touchFastqs(fastqs, pairs(...samples));
  const nf = fakeNextflow(dir);
  const app = await startApp(t, { settings: { nextflowPath: nf.path, seqeraToken: token, ...settings } });
  const outdir = join(dir, 'resultados');
  assert.equal((await app.api('POST', '/api/analyses', testAnalysis({}, {}, outdir))).status, 200);
  let counter = 0;
  const dispatch = async (mode, sampleIds = samples, extra = {}) => {
    counter += 1;
    return app.api('POST', '/api/runs', {
      runId: `run-teste${counter}`, analysisId: 'teste', source: { type: 'local', path: fastqs }, sampleIds, params: { outdir }, mode, ...extra,
    });
  };
  const finished = (id) => waitFor(async () => {
    const { body } = await app.api('GET', `/api/runs/${id}`);
    return body.jobs.every((j) => !['queued', 'downloading', 'running'].includes(j.state)) ? body : null;
  }, { label: `fim de ${id}` });
  const state = (id) => app.api('GET', `/api/runs/${id}`).then((r) => r.body);
  return { app, dir, fastqs, outdir, nf, dispatch, finished, state };
}

test('todas ao mesmo tempo: 1 Nextflow, 1 link, samplesheet com todas as amostras', async (t) => {
  const { app, dispatch, finished, outdir, dir } = await setup(t);
  const res = await dispatch('parallel');
  assert.equal(res.status, 200);
  assert.equal(res.body.jobs.length, 1);
  assert.equal(res.body.etaMin, 20);

  const run = await finished(res.body.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.jobs[0].url, 'https://cloud.seqera.io/orgs/lab/workspaces/prod/watch/Aabc');

  const jobDir = app.store.getJob(run.jobs[0].id).dir;
  const sheet = readFileSync(join(jobDir, 'samplesheet.csv'), 'utf8').trim().split('\n');
  assert.equal(sheet[0], 'sample,fastq_1,fastq_2');
  assert.equal(sheet.length, 4);
  assert.ok(sheet[1].startsWith(`A,${dir}`));
  const params = JSON.parse(readFileSync(join(jobDir, 'params.json'), 'utf8'));
  assert.equal(params.outdir, outdir);
  assert.equal(params.input, join(jobDir, 'samplesheet.csv'));
  assert.equal(params.threads, 2);
  assert.ok(statSync(outdir).isDirectory(), 'pasta de resultados criada no disparo');
});

test('argumentos: revisão, perfil, stub e -c do Seqera', async (t) => {
  const { app, dispatch, finished } = await setup(t);
  await app.api('PUT', '/api/analyses/teste', testAnalysis({ profile: 'docker,test', stub: true }));
  const run = await finished((await dispatch('parallel')).body.id);
  const args = readFileSync(join(app.store.getJob(run.jobs[0].id).dir, 'args.txt'), 'utf8').trim();
  assert.match(args, /^run lab\/teste -r 1\.0 -profile docker,test -stub -name pl-teste-teste1-001 -work-dir work -params-file params\.json -c seqera\.config$/);
});

test('pipeline local não recebe -r e caminho relativo vira absoluto', async (t) => {
  const { app, dispatch, finished } = await setup(t);
  await app.api('PUT', '/api/analyses/teste', testAnalysis({ pipeline: 'examples/stub-pipeline', revision: 'main' }));
  const run = await finished((await dispatch('parallel')).body.id);
  const args = readFileSync(join(app.store.getJob(run.jobs[0].id).dir, 'args.txt'), 'utf8');
  assert.match(args, /^run \/.*examples\/stub-pipeline -name /);
});

test('seqera.config: 0600 durante a execução, apagado no fim, com o token', async (t) => {
  const { app, dispatch, finished } = await setup(t);
  const run = await finished((await dispatch('parallel')).body.id);
  const jobDir = app.store.getJob(run.jobs[0].id).dir;
  assert.match(readFileSync(join(jobDir, 'seqera.perms'), 'utf8'), /^-rw-------/);
  assert.match(readFileSync(join(jobDir, 'seqera.seen'), 'utf8'), /accessToken = 'tok-secreto'/);
  assert.equal(existsSync(join(jobDir, 'seqera.config')), false);
  assert.ok(!readFileSync(join(jobDir, 'args.txt'), 'utf8').includes('tok-secreto'), 'token fora da linha de comando');
});

test('Nextflow não roda em modo agente, que muda a saída de onde vem o link', async (t) => {
  const saved = { NXF_AGENT_MODE: process.env.NXF_AGENT_MODE, CLAUDECODE: process.env.CLAUDECODE };
  process.env.NXF_AGENT_MODE = 'true';
  process.env.CLAUDECODE = '1';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { app, dispatch, finished } = await setup(t);
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(existsSync(join(app.store.getJob(run.jobs[0].id).dir, 'modo-agente')), false);
});

test('sem token: não passa -c, não inventa link e avisa', async (t) => {
  const { app, dispatch, finished } = await setup(t, { token: '' });
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.jobs[0].url, null);
  assert.match(run.jobs[0].message, /token do Seqera não configurado/);
  assert.ok(!readFileSync(join(app.store.getJob(run.jobs[0].id).dir, 'args.txt'), 'utf8').includes('-c '));
});

test('com token e sem URL na saída: avisa em vez de inventar', async (t) => {
  const { dispatch, finished } = await setup(t, { samples: ['NOLINK'] });
  const run = await finished((await dispatch('parallel')).body.id);
  assert.equal(run.jobs[0].url, null);
  assert.match(run.jobs[0].message, /não informou um link/);
});

test('uma por vez: executa em ordem, um link por amostra, outdir separado', async (t) => {
  const { app, dispatch, finished, outdir, nf } = await setup(t, { settings: { maxConcurrent: 4 } });
  const res = await dispatch('sequential');
  assert.equal(res.body.jobs.length, 3);
  assert.equal(res.body.etaMin, 30);
  const run = await finished(res.body.id);
  assert.equal(run.state, 'succeeded');
  assert.deepEqual(events(nf.eventLog), ['start A', 'end A', 'start B', 'end B', 'start C', 'end C'], 'ordem mantida mesmo com limite maior');
  assert.deepEqual(run.jobs.map((j) => j.url.split('/').pop()), ['Aabc', 'Babc', 'Cabc']);
  const params = JSON.parse(readFileSync(join(app.store.getJob(run.jobs[1].id).dir, 'params.json'), 'utf8'));
  assert.equal(params.outdir, join(outdir, 'B'));
});

test('falha em uma amostra não interrompe as seguintes', async (t) => {
  const { dispatch, finished } = await setup(t, { samples: ['A', 'FAILME', 'Z'] });
  const run = await finished((await dispatch('sequential')).body.id);
  assert.deepEqual(run.jobs.map((j) => j.state), ['succeeded', 'failed', 'succeeded']);
  assert.match(run.jobs[1].message, /falha simulada/);
  assert.match(run.jobs[1].message, /Nextflow novo disponivel\n/);
  assert.doesNotMatch(run.jobs[1].message, /\x1b|\(B|\[33m/, 'sem códigos de cor do terminal');
  assert.equal(run.state, 'failed');
});

test('limite de execuções simultâneas segura o segundo disparo', async (t) => {
  const { app, dispatch, state, finished, nf } = await setup(t, { samples: ['SLOW', 'B'] });
  const first = await dispatch('parallel', ['SLOW']);
  await waitFor(() => events(nf.eventLog).includes('start SLOW'), { label: 'início' });
  const second = await dispatch('parallel', ['B']);
  assert.equal((await state(second.body.id)).jobs[0].state, 'queued');
  const { runs } = (await app.api('GET', '/api/runs')).body;
  assert.equal(runs.find((r) => r.id === second.body.id).ahead, 1, 'indica execuções à frente');

  await app.api('PUT', '/api/settings', { maxConcurrent: 2 });
  await waitFor(() => events(nf.eventLog).includes('start B'), { label: 'liberação pelo novo limite' });
  await finished(second.body.id);
  await app.api('POST', `/api/runs/${first.body.id}/cancel`, {});
  await finished(first.body.id);
});

test('cancelar encerra o processo e os jobs na fila', async (t) => {
  const { app, dispatch, finished, nf } = await setup(t, { samples: ['ASLOW', 'B', 'C'] });
  const res = await dispatch('sequential', ['ASLOW', 'B', 'C']);
  await waitFor(() => events(nf.eventLog).includes('start ASLOW'), { label: 'início' });
  const cancel = await app.api('POST', `/api/runs/${res.body.id}/cancel`, {});
  assert.equal(cancel.status, 200);
  const run = await finished(res.body.id);
  assert.deepEqual(run.jobs.map((j) => j.state), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(run.state, 'cancelled');
  assert.ok(events(nf.eventLog).includes('end ASLOW'), 'recebeu o sinal');
  assert.ok(!events(nf.eventLog).includes('start B'));
  assert.equal(existsSync(join(app.store.getJob(run.jobs[0].id).dir, 'seqera.config')), false);
});

test('Nextflow não encontrado vira falha clara e a fila segue', async (t) => {
  const { app, dispatch, finished } = await setup(t, { settings: { nextflowPath: '/nao/existe/nextflow' } });
  const run = await finished((await dispatch('sequential', ['A', 'B'])).body.id);
  assert.deepEqual(run.jobs.map((j) => j.state), ['failed', 'failed']);
  assert.match(run.jobs[0].message, /Nextflow não encontrado/);
  assert.equal(app.runner.active.size, 0);
});

test('disparo: repetição do mesmo run_id não duplica, e erros voltam para a tela', async (t) => {
  const { app, dispatch, finished, fastqs } = await setup(t);
  const first = await dispatch('parallel', ['A'], { runId: 'run-repetido' });
  const second = await dispatch('parallel', ['A'], { runId: 'run-repetido' });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(app.store.jobsForRun('run-repetido').length, 1);
  await finished('run-repetido');

  assert.match((await dispatch(undefined)).body.error, /Escolha como executar/);
  assert.match((await dispatch('parallel', ['NAO-EXISTE'])).body.error, /Amostras não encontradas/);
  assert.match((await dispatch('parallel', [])).body.error, /ao menos uma amostra/);
  assert.match((await dispatch('parallel', ['A'], { params: { outdir: 'relativa/x' } })).body.error, /caminho completo/);
  assert.match((await dispatch('parallel', ['A'], { params: { outdir: '' } })).body.error, /obrigatório/);
  assert.match((await dispatch('parallel', ['A'], { source: { type: 'local', path: `${fastqs}/nada` } })).body.error, /Pasta não encontrada/);
  assert.match((await dispatch('parallel', ['A'], { runId: '../x' })).body.error, /inválido/);
});

test('-resume: mesma pasta, nome novo, link novo e dados da tentativa anterior', async (t) => {
  const { app, dispatch, finished, nf, outdir } = await setup(t, { samples: ['A', 'FAILME', 'Z'] });
  const res = await dispatch('sequential');
  const run = await finished(res.body.id);
  assert.deepEqual(run.jobs.map((j) => [j.state, j.canResume]), [['succeeded', false], ['failed', true], ['succeeded', false]]);
  const failed = run.jobs[1];
  assert.equal(failed.url, 'https://cloud.seqera.io/orgs/lab/workspaces/prod/watch/FAILMEabc');
  assert.equal(failed.workDir, join(failed.dir, 'work'));
  assert.deepEqual(failed.attempts, []);
  const started = events(nf.eventLog).filter((e) => e.startsWith('start')).length;

  // A pasta de trabalho muda depois do disparo: a retomada precisa continuar na original.
  await app.api('PUT', '/api/settings', { workDir: join(outdir, 'outra-pasta') });
  const resumed = await app.api('POST', `/api/jobs/${failed.id}/resume`, {});
  assert.equal(resumed.status, 200);
  const after = await finished(res.body.id);
  const job = after.jobs[1];

  assert.equal(job.state, 'succeeded');
  assert.equal(after.state, 'succeeded');
  assert.equal(job.dir, failed.dir, 'mesma pasta, onde estão o cache e a work');
  assert.equal(job.url, 'https://cloud.seqera.io/orgs/lab/workspaces/prod/watch/FAILMEres', 'não reaproveita o link antigo');
  assert.match(job.command, / -name pl-teste-teste1-002-r1 -work-dir work -params-file params\.json -resume -c seqera\.config$/);
  assert.equal(events(nf.eventLog).filter((e) => e.startsWith('start')).length, started + 1, 'só a execução retomada roda de novo');
  assert.equal(after.jobs[0].url.endsWith('Aabc'), true);

  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].state, 'failed');
  assert.equal(job.attempts[0].url, failed.url);
  assert.match(job.attempts[0].message, /falha simulada/);
  assert.doesNotMatch(job.attempts[0].command, /-resume/);
  assert.ok(existsSync(join(job.dir, 'nextflow.tentativa-1.out')), 'log da tentativa anterior preservado');
  assert.doesNotMatch(readFileSync(join(job.dir, 'nextflow.out'), 'utf8'), /FAILMEabc/);
  assert.equal(existsSync(join(job.dir, 'seqera.config')), false);
});

test('-resume: pode repetir, sempre com nome novo', async (t) => {
  const { app, dispatch, finished } = await setup(t, { samples: ['ALWAYSFAIL'] });
  const res = await dispatch('parallel');
  let run = await finished(res.body.id);
  const { id } = run.jobs[0];
  await app.api('POST', `/api/jobs/${id}/resume`, {});
  run = await finished(res.body.id);
  assert.equal(run.jobs[0].state, 'failed');
  await app.api('POST', `/api/jobs/${id}/resume`, {});
  run = await finished(res.body.id);
  assert.equal(run.jobs[0].attempts.length, 2);
  assert.match(run.jobs[0].command, /-r2 -work-dir work -params-file params\.json -resume/);
});

test('-resume: recusa execução que não falhou e aceita interrompida', async (t) => {
  const { app, dispatch, finished } = await setup(t, { samples: ['A'] });
  const res = await dispatch('parallel');
  const run = await finished(res.body.id);
  const { id } = run.jobs[0];
  const refused = await app.api('POST', `/api/jobs/${id}/resume`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /falharam, foram interrompidas ou canceladas/);
  assert.equal((await app.api('POST', '/api/jobs/nao-existe/resume', {})).status, 404);

  app.store.updateJob(id, { state: 'interrupted' });
  assert.equal((await app.api('POST', `/api/jobs/${id}/resume`, {})).status, 200);
  assert.equal((await finished(res.body.id)).jobs[0].state, 'succeeded');
});

test('-resume: regrava o samplesheet a partir do job salvo', async (t) => {
  const { app, dispatch, finished, nf } = await setup(t, { samples: ['A'] });
  const res = await dispatch('parallel');
  const run = await finished(res.body.id);
  const { id, dir } = run.jobs[0];
  app.store.updateJob(id, { state: 'failed' });
  writeFileSync(join(dir, 'samplesheet.csv'), 'x');
  const before = events(nf.eventLog).length;
  await app.api('POST', `/api/jobs/${id}/resume`, {});
  const after = await finished(res.body.id);
  assert.equal(after.jobs[0].state, 'succeeded');
  assert.ok(events(nf.eventLog).length > before);
  assert.notEqual(readFileSync(join(dir, 'samplesheet.csv'), 'utf8'), 'x', 'samplesheet regravado igual ao original');
});

test('-resume em canceladas: em andamento e ainda na fila', async (t) => {
  const { app, dispatch, finished, nf, state } = await setup(t, { samples: ['ASLOW', 'B'] });
  const res = await dispatch('sequential', ['ASLOW', 'B']);
  await waitFor(() => events(nf.eventLog).includes('start ASLOW'), { label: 'início' });
  await app.api('POST', `/api/runs/${res.body.id}/cancel`, {});
  const run = await finished(res.body.id);
  const [started, queued] = run.jobs;
  assert.deepEqual(run.jobs.map((j) => [j.state, j.canResume]), [['cancelled', true], ['cancelled', true]]);
  assert.equal(queued.dir, null, 'a segunda amostra nunca começou');

  await app.api('POST', `/api/jobs/${queued.id}/resume`, {});
  const after = await waitFor(async () => {
    const r = await state(res.body.id);
    return r.jobs[1].state === 'succeeded' ? r : null;
  }, { label: 'amostra que estava na fila' });
  assert.match(after.jobs[1].command, /-r1 -work-dir work -params-file params\.json -resume/);
  assert.ok(after.jobs[1].dir);
  assert.equal(after.jobs[0].state, 'cancelled', 'a outra execução continua como estava');

  await app.api('POST', `/api/jobs/${started.id}/resume`, {});
  const running = await waitFor(async () => {
    const r = await state(res.body.id);
    return r.jobs[0].state === 'running' && app.store.getJob(started.id).pid ? r : null;
  }, { label: 'retomada em execução' });
  assert.equal(running.jobs[0].dir, started.dir, 'mesma pasta');
  assert.equal(running.jobs[0].canResume, false);

  // O pedido de cancelamento anterior não pode cancelar a retomada ao terminar.
  const refused = await app.api('POST', `/api/jobs/${started.id}/resume`, {});
  assert.equal(refused.status, 409, 'não retoma o que já está rodando');
  await app.api('POST', `/api/runs/${res.body.id}/cancel`, {});
  const final = await finished(res.body.id);
  assert.equal(final.jobs[0].state, 'cancelled');
  assert.equal(final.jobs[0].attempts.length, 1);
  assert.equal(final.jobs[0].attempts[0].state, 'cancelled');
  assert.equal(final.jobs[1].state, 'succeeded', 'cancelar de novo não afeta o que já terminou');
});

test('reinício: fila continua, processo vivo é retomado, processo morto vira interrompido', async (t) => {
  const { app, dispatch, nf } = await setup(t, { samples: ['ASLOW', 'B'] });
  const res = await dispatch('sequential', ['ASLOW', 'B']);
  await waitFor(() => events(nf.eventLog).includes('start ASLOW'), { label: 'início' });
  const jobId = res.body.jobs[0].id;
  const { pid, dir: jobDir } = app.store.getJob(jobId);
  assert.ok(pid);
  await app.close();
  assert.doesNotThrow(() => process.kill(pid, 0), 'o Nextflow sobrevive ao encerramento da plataforma');

  const reborn = await startApp(t, { dataDir: app.dir });
  assert.equal(reborn.store.getJob(jobId).state, 'running', 'retomado');
  assert.ok(reborn.runner.active.has(jobId));

  process.kill(-pid, 'SIGKILL');
  await waitFor(() => reborn.store.getJob(jobId).state === 'interrupted', { label: 'interrupção' });
  assert.match(reborn.store.getJob(jobId).message, /não pôde ser confirmado/);
  assert.equal(existsSync(join(jobDir, 'seqera.config')), false);

  await waitFor(() => reborn.store.jobsForRun(res.body.id)[1].state === 'succeeded', { label: 'amostra seguinte' });
  await reborn.close();
  const third = await startApp(t, { dataDir: app.dir });
  assert.equal(third.store.getRun(res.body.id).id, res.body.id, 'histórico persistido');
  assert.equal((await third.api('GET', '/api/bootstrap')).body.recentPaths.length, 1);
});
