import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fakeNextflow, startApp, tempDir, testAnalysis, touchFastqs, waitFor } from './helpers.js';

test('banco criado antes da coluna command é migrado sem perder dados', async (t) => {
  const dir = tempDir(t);
  const old = new DatabaseSync(join(dir, 'plataforma.db'));
  old.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL,
      pid INTEGER, dir TEXT, url TEXT, message TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, started_at INTEGER, finished_at INTEGER, payload TEXT NOT NULL);
  `);
  const run = { id: 'run-antiga', createdAt: 1, analysisName: 'Antiga', source: { type: 'local', path: '/d' }, params: { outdir: '/r' } };
  old.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(run.id, 1, JSON.stringify(run));
  old.prepare(`INSERT INTO jobs (id, run_id, seq, label, state, payload) VALUES ('j1', 'run-antiga', 1, 'Lote', 'succeeded', ?)`)
    .run(JSON.stringify({ params: { outdir: '/r' }, input_param: 'input', source: run.source }));
  old.close();

  const { api } = await startApp(t, { dataDir: dir });
  const { body } = await api('GET', '/api/runs');
  assert.equal(body.runs[0].id, 'run-antiga');
  assert.equal(body.runs[0].jobs[0].command, null);
  assert.equal((await api('DELETE', '/api/runs/run-antiga')).status, 200);
});

test('histórico traz comando e parâmetros, sem o token', async (t) => {
  const dir = tempDir(t);
  const nf = fakeNextflow(dir);
  const fastqs = join(dir, 'fastqs');
  touchFastqs(fastqs, ['A_R1.fastq.gz', 'A_R2.fastq.gz', 'B_R1.fastq.gz', 'B_R2.fastq.gz']);
  const { api, raw } = await startApp(t, { settings: { nextflowPath: nf.path, seqeraToken: 'tok-secreto-historico' } });
  const outdir = join(dir, 'res');
  await api('POST', '/api/analyses', testAnalysis({}, {}, outdir));
  await api('POST', '/api/runs', { runId: 'run-hist', analysisId: 'teste', mode: 'sequential', sampleIds: ['A', 'B'], source: { type: 'local', path: fastqs }, params: { outdir, threads: 8 } });

  const run = await waitFor(async () => {
    const { body } = await api('GET', '/api/runs/run-hist');
    return body.jobs.every((j) => j.state === 'succeeded') ? body : null;
  }, { label: 'fim dos jobs' });
  assert.deepEqual(run.params, { outdir, threads: 8 });
  assert.match(run.jobs[0].command, / run lab\/teste -r 1\.0 -name pl-teste-hist-001 -work-dir work -params-file params\.json -c seqera\.config$/);
  assert.ok(run.jobs[0].command.startsWith(nf.path), 'mostra o executável usado');
  assert.equal(run.jobs[1].params.outdir, join(outdir, 'B'), 'outdir efetivo de cada amostra');
  assert.equal(run.jobs[1].params.input, join(run.jobs[1].dir, 'samplesheet.csv'));
  assert.ok(!(await raw('/api/runs')).text.includes('tok-secreto-historico'));
});

test('excluir execução: só depois de terminar, sem apagar arquivos', async (t) => {
  const dir = tempDir(t);
  const nf = fakeNextflow(dir);
  const fastqs = join(dir, 'fastqs');
  touchFastqs(fastqs, ['ASLOW_R1.fastq.gz', 'ASLOW_R2.fastq.gz']);
  const { api, store } = await startApp(t, { settings: { nextflowPath: nf.path } });
  const outdir = join(dir, 'res');
  await api('POST', '/api/analyses', testAnalysis({}, {}, outdir));
  await api('POST', '/api/runs', { runId: 'run-excluir', analysisId: 'teste', mode: 'parallel', sampleIds: ['ASLOW'], source: { type: 'local', path: fastqs }, params: { outdir } });
  const job = await waitFor(() => {
    const j = store.jobsForRun('run-excluir')[0];
    return j.pid ? j : null;
  }, { label: 'início' });

  const blocked = await api('DELETE', '/api/runs/run-excluir');
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Cancele antes/);
  assert.ok(store.getRun('run-excluir'));

  await api('POST', '/api/runs/run-excluir/cancel', {});
  await waitFor(() => store.jobsForRun('run-excluir')[0].state === 'cancelled', { label: 'cancelamento' });
  assert.equal((await api('DELETE', '/api/runs/run-excluir')).status, 200);
  assert.equal(store.getRun('run-excluir'), null);
  assert.deepEqual(store.jobsForRun('run-excluir'), []);
  assert.equal((await api('GET', '/api/runs/run-excluir')).status, 404);
  assert.ok(statSync(job.dir).isDirectory(), 'pasta do job continua no disco');
  assert.ok(statSync(outdir).isDirectory(), 'pasta de resultados continua no disco');
  assert.equal((await api('DELETE', '/api/runs/run-excluir')).status, 404);
  assert.deepEqual((await api('GET', '/api/bootstrap')).body.recentPaths, [], 'sai dos recentes');
});

test('segurança: rejeita Host e Origin de fora', async (t) => {
  const { raw, port } = await startApp(t);
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await raw('/api/bootstrap')).status, 200);
  assert.equal((await raw('/api/bootstrap', { headers: { Host: `localhost:${port}` } })).status, 200);
  assert.equal((await raw('/api/bootstrap', { headers: { Host: `malicioso.com:${port}` } })).status, 403, 'DNS rebinding');
  assert.equal((await raw('/api/fs/browse', { headers: { Host: 'malicioso.com' } })).status, 403);
  assert.equal((await raw('/api/settings', { method: 'PUT', headers: { ...json, Origin: 'https://malicioso.com' }, body: '{}' })).status, 403, 'CSRF');
  assert.equal((await raw('/api/settings', { method: 'PUT', headers: { ...json, Origin: 'null' }, body: '{}' })).status, 403);
  assert.equal((await raw('/api/settings', { method: 'PUT', headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: '{}' })).status, 200);
  assert.equal((await raw('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415, 'formulário simples não passa');
});

test('segurança: arquivos estáticos só da lista permitida', async (t) => {
  const { raw } = await startApp(t);
  const page = encodeURIComponent('Plataforma de Pipelines.dc.html');
  assert.equal((await raw('/')).status, 302);
  assert.equal((await raw(`/${page}`)).status, 200);
  assert.equal((await raw('/support.js')).status, 200);
  assert.equal((await raw('/vendor/react.production.min.js')).status, 200);
  for (const path of [
    '/server/index.js', '/package.json', '/data/plataforma.db', '/_ds/..%2fserver/index.js', '/vendor/..%2fpackage.json',
    '/_ds/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/vendor/../server/index.js', '/vendor',
  ]) {
    assert.equal((await raw(path)).status, 404, path);
  }
});

test('segurança: token da Seqera nunca volta para o navegador', async (t) => {
  const { api, raw, store } = await startApp(t);
  const saved = await api('PUT', '/api/settings', { seqeraToken: 'tok-muito-secreto' });
  assert.equal(saved.body.hasSeqeraToken, true);
  assert.equal(saved.body.seqeraToken, undefined);
  assert.ok(!(await raw('/api/bootstrap')).text.includes('tok-muito-secreto'));
  assert.equal(store.getConnections().seqeraToken, 'tok-muito-secreto');

  await api('PUT', '/api/settings', { seqeraToken: '', seqeraWorkspaceId: '42' });
  assert.equal(store.getConnections().seqeraToken, 'tok-muito-secreto', 'campo vazio mantém o valor');
  const cleared = await api('PUT', '/api/settings', { clearSeqeraToken: true });
  assert.equal(cleared.body.hasSeqeraToken, false);
});

test('banco fica protegido por permissão', async (t) => {
  const { dir } = await startApp(t);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'plataforma.db')).mode & 0o777, 0o600);
});

test('persistência: marca, conexões e análises sobrevivem a um reinício', async (t) => {
  const first = await startApp(t);
  const logo = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`;
  await first.api('PUT', '/api/brand', { name: 'Empresa X', accent: '#4fb3b0', logo });
  await first.api('PUT', '/api/settings', { maxConcurrent: 3 });
  await first.api('POST', '/api/analyses', testAnalysis());
  await first.api('DELETE', '/api/analyses/wes');
  await first.close();

  const second = await startApp(t, { dataDir: first.dir });
  const { body } = await second.api('GET', '/api/bootstrap');
  assert.deepEqual(body.brand, { name: 'Empresa X', accent: '#4fb3b0', logo });
  assert.equal(body.connections.maxConcurrent, 3);
  assert.ok(body.analyses.some((a) => a.id === 'teste'));
  assert.ok(!body.analyses.some((a) => a.id === 'wes'), 'análise excluída não volta com os seeds');
});

test('marca: valida cor e logo', async (t) => {
  const { api } = await startApp(t);
  assert.match((await api('PUT', '/api/brand', { accent: 'azul' })).body.error, /#rrggbb/);
  assert.match((await api('PUT', '/api/brand', { logo: 'data:text/html;base64,AAAA' })).body.error, /imagem/);
  const big = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`;
  assert.match((await api('PUT', '/api/brand', { logo: big })).body.error, /2 MB/);
  assert.equal((await api('PUT', '/api/brand', { logo: '' })).status, 200);
});

test('conexões: valida os campos', async (t) => {
  const { api } = await startApp(t);
  const put = (patch) => api('PUT', '/api/settings', patch);
  assert.match((await put({ maxConcurrent: 0 })).body.error, /inteiro/);
  assert.match((await put({ seqeraApi: 'ftp://x' })).body.error, /http/);
  assert.match((await put({ seqeraWorkspaceId: 'abc' })).body.error, /numérico/);
  assert.match((await put({ workDir: 'relativo' })).body.error, /absoluto/);
  assert.equal((await put({ seqeraApi: 'https://api.exemplo.com//' })).body.seqeraApi, 'https://api.exemplo.com');
});

test('análises: valida ao salvar e impede identificador repetido', async (t) => {
  const { api } = await startApp(t);
  assert.equal((await api('POST', '/api/analyses', testAnalysis())).status, 200);
  assert.equal((await api('POST', '/api/analyses', testAnalysis())).status, 409);
  assert.match((await api('POST', '/api/analyses', testAnalysis({ id: 'x', schema: '{' }))).body.error, /JSON inválido/);
  assert.equal((await api('PUT', '/api/analyses/teste', testAnalysis({ id: 'wes' }))).status, 409);
  assert.equal((await api('PUT', '/api/analyses/teste', testAnalysis({ id: 'renomeada' }))).status, 200);
  assert.equal((await api('PUT', '/api/analyses/teste', testAnalysis())).status, 404);
});

test('navegador de pastas lista só subpastas visíveis', async (t) => {
  const { api } = await startApp(t);
  const dir = tempDir(t);
  touchFastqs(dir, ['pasta10/x', 'pasta2/x', '.oculta/x', 'A_R1.fastq.gz']);
  const { body } = await api('GET', `/api/fs/browse?path=${encodeURIComponent(dir)}`);
  assert.deepEqual(body.dirs, ['pasta2', 'pasta10']);
  assert.equal(body.fastqs, 1);
  assert.equal(body.path, dir);
  assert.ok(body.parent);
  assert.equal((await api('GET', '/api/fs/browse?path=/')).body.parent, null);
  assert.match((await api('GET', `/api/fs/browse?path=${encodeURIComponent(`${dir}/nada`)}`)).body.error, /não encontrada/);
});

test('scan pela API respeita o padrão e o paired do schema', async (t) => {
  const { api } = await startApp(t);
  const dir = tempDir(t);
  touchFastqs(dir, ['A_S1_R1_001.fastq.gz', 'B_S1_R1_001.fastq.gz', 'B_S1_R2_001.fastq.gz', 'C_R1.fastq.gz', 'C_R2.fastq.gz']);
  const { body } = await api('POST', '/api/scan', { analysisId: 'wes', path: dir });
  assert.deepEqual(body.samples.map((s) => [s.name, s.reason]), [['A', 'R2 ausente'], ['B', null]]);
  assert.match((await api('POST', '/api/scan', { analysisId: 'wes', path: 'relativo' })).body.error, /caminho completo/);
  assert.equal((await api('POST', '/api/scan', { analysisId: 'nao-existe', path: dir })).status, 404);
});

test('samplesheet do sarek traz patient e lane, uma linha por lane', async (t) => {
  const { api } = await startApp(t);
  const dir = tempDir(t);
  touchFastqs(dir, ['A_S1_L001_R1_001.fastq.gz', 'A_S1_L001_R2_001.fastq.gz', 'A_S1_L002_R1_001.fastq.gz', 'A_S1_L002_R2_001.fastq.gz']);
  const { body } = await api('POST', '/api/runs/preview', {
    analysisId: 'wes', mode: 'parallel', sampleIds: ['A'], source: { type: 'local', path: dir }, params: { outdir: '/tmp/x', intervals: '/refs/a.bed' },
  });
  assert.deepEqual(Object.keys(body.jobs[0].sheet_columns), ['patient', 'sample', 'lane', 'fastq_1', 'fastq_2']);
  assert.deepEqual(body.jobs[0].samples.map((s) => s.lane), ['L001', 'L002']);
  assert.equal(body.jobs[0].analysis_id, 'wes');
});

test('testes de conexão: Nextflow e Seqera', async (t) => {
  const dir = tempDir(t);
  const nf = fakeNextflow(dir);
  const { api } = await startApp(t, { settings: { nextflowPath: nf.path } });

  const version = await api('POST', '/api/test/nextflow', {});
  assert.deepEqual(version.body, { ok: true, text: 'Nextflow 25.04.0' }, 'não confunde com a versão citada no aviso do Java');

  await api('PUT', '/api/settings', { nextflowPath: '/nao/existe/nextflow' });
  assert.match((await api('POST', '/api/test/nextflow', {})).body.text, /não encontrado/);

  assert.match((await api('POST', '/api/test/seqera', {})).body.text, /Informe o token/);

  const seqera = createServer((req, res) => {
    const ok = req.url === '/user-info' && req.headers.authorization === 'Bearer certo';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { user: { userName: 'fulana' } } : {}));
  });
  await new Promise((res) => seqera.listen(0, '127.0.0.1', res));
  t.after(() => seqera.close());
  await api('PUT', '/api/settings', { seqeraApi: `http://127.0.0.1:${seqera.address().port}`, seqeraToken: 'errado' });
  assert.match((await api('POST', '/api/test/seqera', {})).body.text, /Token recusado/);
  await api('PUT', '/api/settings', { seqeraToken: 'certo' });
  assert.deepEqual((await api('POST', '/api/test/seqera', {})).body, { ok: true, text: 'Conectado como fulana' });
  await api('PUT', '/api/settings', { seqeraApi: 'http://127.0.0.1:1' });
  assert.match((await api('POST', '/api/test/seqera', {})).body.text, /Não foi possível conectar/);
});
