import { createReadStream, statSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSpaceError, listProjectFastqs, searchProjects } from './basespace.js';
import { testBaseSpace, testNextflow, testSeqera } from './connections.js';
import { ACTIVE_STATES, Store } from './db.js';
import { groupFastqFiles, scanFolder } from './fastq.js';
import { buildJobs, resolveParams } from './jobs.js';
import { logName, readLogTail, RESUMABLE_STATES, Runner, runState } from './runner.js';
import { normalizeAnalysis, parseSchema } from './schema.js';
import { mergeBrand, mergeConnections, publicConnections } from './settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'Plataforma de Pipelines.dc.html';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const RUN_ID_RE = /^run-[a-z0-9]{4,32}$/;
const REMOTE_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Envie o corpo em JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Requisição grande demais.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

// O servidor lista pastas e dispara processos. Sem esta checagem, qualquer página aberta no navegador
// poderia chamá-lo por POST (CSRF) ou apontar um domínio próprio para 127.0.0.1 (DNS rebinding).
export function isTrustedRequest(headers) {
  let host;
  try {
    host = new URL(`http://${headers.host}`);
  } catch {
    return false;
  }
  if (!LOCAL_HOSTS.has(host.hostname)) return false;
  return !headers.origin || headers.origin === `http://${headers.host}`;
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') {
    res.writeHead(302, { Location: `/${encodeURIComponent(PAGE)}` });
    res.end();
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  let file;
  try {
    file = resolve(ROOT, decodeURIComponent(pathname).slice(1));
  } catch {
    throw new HttpError(400, 'Caminho inválido.');
  }
  // A lista é conferida depois de resolver o caminho, para que "_ds/..%2f" não escape dela.
  const rel = relative(ROOT, file);
  const allowed = rel === PAGE || rel === 'support.js' || rel.startsWith(`_ds${sep}`) || rel.startsWith(`vendor${sep}`);
  if (!allowed) throw new HttpError(404, 'Não encontrado.');
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new HttpError(404, 'Não encontrado.');
  }
  if (!info.isFile()) throw new HttpError(404, 'Não encontrado.');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  createReadStream(file).pipe(res);
}

export function createApp({ dataDir = process.env.PLATAFORMA_DATA || join(ROOT, 'data'), pollMs } = {}) {
  const store = new Store(dataDir);
  const runner = new Runner({ store, dataDir, rootDir: ROOT, pollMs });
  const bsCache = new Map();

  function runView(run, ahead = 0) {
    const jobs = store.jobsForRun(run.id);
    return {
      ...run,
      kind: run.kind ?? 'nextflow',
      state: runState(jobs),
      ahead,
      jobs: jobs.map((j) => ({
        id: j.id, seq: j.seq, label: j.label, state: j.state, url: j.url, message: j.message, startedAt: j.startedAt, finishedAt: j.finishedAt,
        command: j.command,
        dir: j.dir,
        workDir: j.dir && j.payload.kind !== 'command' ? join(j.dir, 'work') : null,
        log: j.dir ? join(j.dir, logName(j)) : null,
        attempts: j.attempts,
        canResume: RESUMABLE_STATES.includes(j.state),
        estimatedMinutes: j.payload.estimated_minutes,
        // Os valores que a pipeline recebe no params.json: o samplesheet só existe depois que o job começa.
        params: { ...j.payload.params, ...(j.dir && j.payload.input_param ? { [j.payload.input_param]: join(j.dir, 'samplesheet.csv') } : {}) },
      })),
    };
  }

  function runViews(limit) {
    const runs = store.listRuns(limit);
    const pending = store.jobsInState(...ACTIVE_STATES);
    const createdAt = new Map(runs.map((r) => [r.id, r.createdAt]));
    return runs.map((run) => {
      const ahead = pending.filter((j) => j.runId !== run.id && (createdAt.get(j.runId) ?? store.getRun(j.runId)?.createdAt) < run.createdAt).length;
      return runView(run, store.jobsForRun(run.id).some((j) => ACTIVE_STATES.includes(j.state)) ? ahead : 0);
    });
  }

  function analysisAndSchema(id) {
    const analysis = store.getAnalysis(id);
    if (!analysis) throw new HttpError(404, 'Análise não encontrada.');
    const schema = parseSchema(analysis.schema, { kind: analysis.kind });
    if (!schema.ok) throw new HttpError(400, `Schema da análise inválido: ${schema.error}`);
    return { analysis, schema };
  }

  function samplesFieldOf(analysisId) {
    const { schema } = analysisAndSchema(analysisId);
    if (!schema.samplesField) throw new HttpError(400, 'Esta análise não usa amostras.');
    return schema.samplesField;
  }

  async function basespaceScan(body) {
    const { pattern, paired } = samplesFieldOf(body.analysisId);
    const conn = store.getConnections();
    let projectId = body.projectId ? String(body.projectId) : null;
    let projectName = body.projectName ? String(body.projectName) : null;
    if (!projectId) {
      const matches = await searchProjects(conn.bsPath, String(body.query ?? ''));
      if (matches.length !== 1) return { matches, project: null, samples: [] };
      projectId = matches[0].id;
      projectName = matches[0].name;
    }
    const files = await listProjectFastqs(conn.bsPath, projectId, { pattern });
    bsCache.set(`${body.analysisId}|${projectId}`, files);
    return { matches: [], project: { id: projectId, name: projectName || projectId }, samples: groupFastqFiles(files, { paired }), warnings: [] };
  }

  async function resolveDispatch(body) {
    const { analysis, schema } = analysisAndSchema(body.analysisId);
    const sf = schema.samplesField;
    const { params, errors } = resolveParams(schema.fields, body.params, analysis.id);
    if (errors.length) throw new HttpError(400, `Revise os parâmetros: ${errors.join('; ')}.`);
    // Comando sem campo de amostras: roda uma vez, só com os parâmetros.
    if (!sf) {
      if (body.source?.type !== 'none') throw new HttpError(400, 'Esta análise não usa amostras.');
      return { analysis, schema, params, samples: [], source: { type: 'none' }, mode: 'single' };
    }
    if (body.source?.type === 'none') throw new HttpError(400, 'Selecione as amostras.');
    if (body.mode !== 'parallel' && body.mode !== 'sequential') throw new HttpError(400, 'Escolha como executar as amostras.');
    if (!Array.isArray(body.sampleIds) || !body.sampleIds.length) throw new HttpError(400, 'Selecione ao menos uma amostra.');

    // As amostras são identificadas de novo no servidor. Assim, arquivos removidos depois da
    // confirmação viram erro aqui, em vez de falhar no meio do Nextflow.
    let available;
    let source;
    if (body.source?.type === 'local') {
      const path = String(body.source.path ?? '');
      if (!isAbsolute(path)) throw new HttpError(400, 'Informe o caminho completo da pasta.');
      ({ samples: available } = await scanFolder(path, { pattern: sf.pattern, paired: sf.paired }));
      source = { type: 'local', path };
    } else if (body.source?.type === 'basespace') {
      const projectId = String(body.source.projectId ?? '');
      if (!projectId) throw new HttpError(400, 'Selecione o projeto do BaseSpace.');
      const key = `${analysis.id}|${projectId}`;
      if (!bsCache.has(key)) bsCache.set(key, await listProjectFastqs(store.getConnections().bsPath, projectId, { pattern: sf.pattern }));
      available = groupFastqFiles(bsCache.get(key), { paired: sf.paired });
      source = { type: 'basespace', project_id: projectId, project_name: String(body.source.projectName ?? projectId) };
    } else {
      throw new HttpError(400, 'Origem dos dados inválida.');
    }
    if (!(sf.sources ?? ['local', 'basespace']).includes(source.type)) throw new HttpError(400, 'Esta análise não aceita essa origem de dados.');

    const wanted = new Set(body.sampleIds);
    const samples = available.filter((s) => wanted.has(s.id));
    const missing = [...wanted].filter((id) => !samples.some((s) => s.id === id));
    if (missing.length) throw new HttpError(409, `Amostras não encontradas: ${missing.join(', ')}. Identifique os FASTQs novamente.`);
    const invalid = samples.filter((s) => s.invalid);
    if (invalid.length) throw new HttpError(409, `Amostras com arquivos faltando: ${invalid.map((s) => s.name).join(', ')}.`);
    return { analysis, schema, params, samples, source, mode: body.mode };
  }

  const routes = {
    'GET /api/bootstrap': async () => ({
      analyses: store.listAnalyses(),
      brand: store.getBrand(),
      connections: publicConnections(store.getConnections()),
      runs: runViews(50),
      recentPaths: store.recentLocalPaths(),
    }),
    'PUT /api/brand': async ({ body }) => {
      const brand = mergeBrand(store.getBrand(), body);
      store.setBrand(brand);
      return brand;
    },
    'PUT /api/settings': async ({ body }) => {
      const conn = mergeConnections(store.getConnections(), body);
      store.setConnections(conn);
      runner.tick();
      return publicConnections(conn);
    },
    'POST /api/analyses': async ({ body }) => {
      const analysis = normalizeAnalysis(body);
      if (store.getAnalysis(analysis.id)) throw new HttpError(409, 'Já existe uma análise com esse identificador.');
      store.saveAnalysis(null, analysis);
      return analysis;
    },
    'PUT /api/analyses/:id': async ({ body, id }) => {
      if (!store.getAnalysis(id)) throw new HttpError(404, 'Análise não encontrada.');
      const analysis = normalizeAnalysis(body);
      if (analysis.id !== id && store.getAnalysis(analysis.id)) throw new HttpError(409, 'Já existe uma análise com esse identificador.');
      store.saveAnalysis(id, analysis);
      return analysis;
    },
    'DELETE /api/analyses/:id': async ({ id }) => {
      store.deleteAnalysis(id);
      return { ok: true };
    },
    'GET /api/fs/browse': async ({ query }) => {
      const path = resolve(query.get('path') || homedir());
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new HttpError(404, `Pasta não encontrada: ${path}`);
        if (err.code === 'EACCES' || err.code === 'EPERM') throw new HttpError(403, `Sem permissão para abrir: ${path}`);
        throw err;
      }
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const fastqs = entries.filter((e) => /\.(fastq|fq)(\.gz)?$/i.test(e.name)).length;
      return { path, parent: dirname(path) === path ? null : dirname(path), dirs, fastqs };
    },
    'POST /api/scan': async ({ body }) => {
      const { pattern, paired } = samplesFieldOf(body.analysisId);
      const path = String(body.path ?? '').trim();
      if (!isAbsolute(path)) throw new HttpError(400, 'Informe o caminho completo da pasta.');
      return scanFolder(path, { pattern, paired });
    },
    'POST /api/basespace/scan': async ({ body }) => basespaceScan(body),
    'POST /api/runs/preview': async ({ body }) => {
      const { analysis, schema, params, samples, source, mode } = await resolveDispatch(body);
      const { jobs } = buildJobs({ runId: body.runId || 'run-preview', analysis, fields: schema.fields, source, samples, params, mode });
      return { jobs: jobs.map((j) => j.payload) };
    },
    'GET /api/runs': async ({ query }) => ({ runs: runViews(Math.min(Number(query.get('limit')) || 50, 500)) }),
    'POST /api/runs': async ({ body }) => {
      if (!RUN_ID_RE.test(String(body.runId))) throw new HttpError(400, 'Identificador de execução inválido.');
      const existing = store.getRun(body.runId);
      if (existing) return runView(existing);
      const { analysis, schema, params, samples, source, mode } = await resolveDispatch(body);
      if (params.outdir && !REMOTE_PATH_RE.test(params.outdir)) {
        if (!isAbsolute(params.outdir)) throw new HttpError(400, 'A pasta de resultados precisa ser um caminho completo.');
        try {
          await mkdir(params.outdir, { recursive: true });
        } catch (err) {
          throw new HttpError(400, `Não foi possível criar a pasta de resultados (${params.outdir}): ${err.code || err.message}`);
        }
      }
      const { run, jobs } = buildJobs({ runId: body.runId, analysis, fields: schema.fields, source, samples, params, mode });
      try {
        store.insertRun(run, jobs);
      } catch (err) {
        // Dois envios simultâneos do mesmo disparo: o segundo perde a corrida e devolve o primeiro.
        const winner = store.getRun(body.runId);
        if (winner) return runView(winner);
        throw err;
      }
      runner.tick();
      return runView(run);
    },
    'GET /api/runs/:id': async ({ id }) => {
      const run = store.getRun(id);
      if (!run) throw new HttpError(404, 'Execução não encontrada.');
      return runView(run);
    },
    // Tira a execução do histórico. Resultados e logs ficam no disco.
    'DELETE /api/runs/:id': async ({ id }) => {
      if (!store.getRun(id)) throw new HttpError(404, 'Execução não encontrada.');
      if (store.jobsForRun(id).some((j) => ACTIVE_STATES.includes(j.state))) {
        throw new HttpError(409, 'Esta execução ainda está em andamento. Cancele antes de excluir.');
      }
      store.deleteRun(id);
      return { ok: true };
    },
    'POST /api/runs/:id/cancel': async ({ id }) => {
      const run = store.getRun(id);
      if (!run) throw new HttpError(404, 'Execução não encontrada.');
      runner.cancelRun(id);
      return runView(run);
    },
    'POST /api/jobs/:id/resume': async ({ id }) => {
      const job = store.getJob(id);
      if (!job) throw new HttpError(404, 'Execução não encontrada.');
      if (!RESUMABLE_STATES.includes(job.state)) throw new HttpError(409, 'Só execuções que falharam, foram interrompidas ou canceladas podem ser retomadas.');
      runner.resumeJob(id);
      return runView(store.getRun(job.runId));
    },
    'GET /api/jobs/:id/log': async ({ id }) => {
      const job = store.getJob(id);
      if (!job) throw new HttpError(404, 'Execução não encontrada.');
      if (!job.dir) return { text: '', size: 0, truncated: false, path: null };
      const path = join(job.dir, logName(job));
      return { ...readLogTail(path), path };
    },
    'POST /api/test/nextflow': async () => testNextflow(store.getConnections()),
    'POST /api/test/seqera': async () => testSeqera(store.getConnections()),
    'POST /api/test/basespace': async () => {
      const result = await testBaseSpace(store.getConnections());
      store.setConnections({ ...store.getConnections(), bsCheck: result });
      return result;
    },
  };

  function match(method, pathname) {
    const direct = routes[`${method} ${pathname}`];
    if (direct) return { handler: direct };
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method || !pattern.includes(':id')) continue;
      const re = new RegExp(`^${pattern.replace(':id', '([^/]+)')}$`);
      const found = re.exec(pathname);
      if (found) return { handler, id: decodeURIComponent(found[1]) };
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    try {
      if (!isTrustedRequest(req.headers)) throw new HttpError(403, 'Origem não permitida.');
      const url = new URL(req.url, 'http://local');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
        serveStatic(req, res, url.pathname);
        return;
      }
      const route = match(req.method, url.pathname);
      if (!route) throw new HttpError(404, 'Rota não encontrada.');
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      json(res, 200, await route.handler({ body, id: route.id, query: url.searchParams }));
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Erros de validação usam Error simples ou tipos próprios; o resto é falha inesperada.
      const expected = err.constructor === Error || err instanceof HttpError || err instanceof BaseSpaceError;
      if (!expected) console.error(err);
      json(res, err.status || (expected ? 400 : 500), { error: expected ? err.message : 'Erro inesperado no servidor.' });
    }
  });

  return { server, store, runner };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  const { server, runner } = createApp();
  runner.start();
  // Só esta máquina acessa: o servidor nunca escuta em outras interfaces.
  server.listen(port, '127.0.0.1', () => {
    console.log(`Plataforma de Pipelines em http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      runner.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
}
