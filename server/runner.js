import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { downloadFiles } from './basespace.js';
import { ACTIVE_STATES } from './db.js';
import { nextflowRunName, renderCommand, samplesheetCsv, shellJoin } from './jobs.js';

const POLL_MS = 1000;
const KILL_GRACE_MS = 60_000;
const SEQERA_URL_RE = /https?:\/\/[^\s'"<>]+\/watch\/[A-Za-z0-9]+/;
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\([A-Z0-9])/g;
const MAX_MESSAGE = 1500;
export const RESUMABLE_STATES = ['failed', 'interrupted', 'cancelled'];
const INTERRUPTED_MESSAGE = 'A plataforma foi reiniciada durante esta execução e o resultado não pôde ser confirmado. Confira no Seqera ou nos logs da pasta de trabalho.';
const REMOTE_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHELL = '/bin/bash';
const EXIT_FILE = 'exitcode';

// Grava o código de saída na pasta do job: se a plataforma estiver fora do ar quando o processo
// terminar, o resultado continua disponível na volta. O trap com handler (e não '') faz o shell
// esperar o processo encerrar depois de um SIGTERM do cancelamento, e não é herdado por ele.
const EXIT_WRAPPER = `trap true TERM INT HUP
"$@"
code=$?
echo "$code" > ${EXIT_FILE}.tmp && mv ${EXIT_FILE}.tmp ${EXIT_FILE}
exit "$code"`;

const isCommand = (job) => job.payload.kind === 'command';
export const logName = (job) => (isCommand(job) ? 'comando.out' : 'nextflow.out');
const scriptPath = (dir) => join(dir, 'comando.sh');

const groovyString = (v) => `'${String(v).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '')}'`;

export function seqeraConfig({ seqeraToken, seqeraApi, seqeraWorkspaceId }) {
  const lines = [
    'tower {',
    '  enabled = true',
    `  accessToken = ${groovyString(seqeraToken)}`,
    `  endpoint = ${groovyString(seqeraApi)}`,
  ];
  if (seqeraWorkspaceId) lines.push(`  workspaceId = ${groovyString(seqeraWorkspaceId)}`);
  lines.push('}', '');
  return lines.join('\n');
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// O PID pode ter sido reaproveitado pelo sistema depois de um reinício.
// Comandos rodam pelo caminho completo do comando.sh, que identifica o job.
function isJobProcess(job) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(job.pid)], { encoding: 'utf8' })
      .includes(isCommand(job) ? scriptPath(job.dir) : 'nextflow');
  } catch {
    return false;
  }
}

function readExitCode(dir) {
  try {
    const text = readFileSync(join(dir, EXIT_FILE), 'utf8').trim();
    return /^\d+$/.test(text) ? { code: Number(text), at: statSync(join(dir, EXIT_FILE)).mtimeMs } : null;
  } catch {
    return null;
  }
}

function findSeqeraUrl(logPath) {
  try {
    return SEQERA_URL_RE.exec(readFileSync(logPath, 'utf8').replace(ANSI_RE, ''))?.[0] ?? null;
  } catch {
    return null;
  }
}

// Com o wrapper, o spawn sempre encontra o shell: a ausência do programa precisa ser conferida antes.
function findExecutable(file, envPath = '') {
  const candidates = file.includes('/') ? [file] : envPath.split(delimiter).filter(Boolean).map((d) => join(d, file));
  return candidates.find((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

// Final do log para a tela. Lido do disco a cada pedido: funciona com a plataforma reiniciada no meio da execução.
export function readLogTail(file, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { text: '', size: 0, truncated: false };
  }
  try {
    const { size } = statSync(file);
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8').replace(ANSI_RE, '');
    // Começando no meio do arquivo, a primeira linha estaria cortada.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function lastLines(file, count = 15) {
  try {
    const text = readFileSync(file, 'utf8').replace(ANSI_RE, '');
    return text.trim().split('\n').slice(-count).join('\n').slice(-MAX_MESSAGE);
  } catch {
    return '';
  }
}

export class Runner {
  constructor({ store, dataDir, rootDir, pollMs = POLL_MS, killGraceMs = KILL_GRACE_MS }) {
    this.store = store;
    this.dataDir = dataDir;
    this.rootDir = rootDir;
    this.pollMs = pollMs;
    this.killGraceMs = killGraceMs;
    this.active = new Map();
    this.stopped = false;
  }

  start() {
    this.recover();
    this.tick();
  }

  // Encerra só o acompanhamento. Processos do Nextflow seguem rodando e são retomados na próxima inicialização.
  stop() {
    this.stopped = true;
    for (const handle of this.active.values()) {
      clearInterval(handle.timer);
      handle.child?.removeAllListeners('exit');
      handle.abort?.abort();
    }
    this.active.clear();
  }

  recover() {
    for (const job of this.store.jobsInState('downloading')) {
      this.store.updateJob(job.id, { state: 'queued' });
    }
    for (const job of this.store.jobsInState('running')) {
      if (job.pid && isProcessAlive(job.pid) && isJobProcess(job)) {
        this.follow(job);
        continue;
      }
      // Terminou com a plataforma fora do ar: o resultado vem do exitcode e o link, do log.
      const logPath = job.dir ? join(job.dir, logName(job)) : null;
      const exit = job.dir ? readExitCode(job.dir) : null;
      if (!job.url && !isCommand(job) && logPath) {
        const url = findSeqeraUrl(logPath);
        if (url) this.store.updateJob(job.id, { url });
      }
      const { state, message } = this.outcome(job.id, exit ? exit.code : null, logPath);
      this.removeSeqeraConfig(job.dir);
      this.store.updateJob(job.id, { state, message, finished_at: exit?.at ? Math.round(exit.at) : Date.now(), pid: null });
    }
  }

  tick() {
    if (this.stopped) return;
    const limit = Math.max(1, Number(this.store.getConnections().maxConcurrent) || 1);
    while (this.active.size < limit) {
      const job = this.nextRunnable();
      if (!job) return;
      this.launch(job);
    }
  }

  nextRunnable() {
    const busyRuns = new Set([...this.active.values()].map((h) => h.runId));
    return this.store.jobsInState('queued').find((job) => !busyRuns.has(job.runId));
  }

  jobDir(job) {
    const { workDir } = this.store.getConnections();
    return join(workDir || join(this.dataDir, 'runs'), job.runId, job.id);
  }

  launch(job) {
    const abort = new AbortController();
    this.active.set(job.id, { runId: job.runId, abort });
    this.prepareAndSpawn(job, abort.signal).catch((err) => {
      if (this.stopped) return;
      const handle = this.active.get(job.id);
      if (err.name === 'AbortError' || handle?.cancelling) this.finish(job.id, 'cancelled', null);
      else this.finish(job.id, 'failed', err.message);
    });
  }

  async prepareAndSpawn(job, signal) {
    const conn = this.store.getConnections();
    // Na retomada, a pasta é sempre a original: é nela que estão o cache e a pasta work.
    const dir = job.dir || this.jobDir(job);
    mkdirSync(dir, { recursive: true });
    this.store.updateJob(job.id, { dir, started_at: Date.now(), state: job.payload.source.type === 'basespace' ? 'downloading' : 'running' });

    let rows = job.payload.samples;
    if (job.payload.source.type === 'basespace') {
      const dest = join(this.dataDir, 'basespace', String(job.payload.source.project_id));
      const local = await downloadFiles(conn.bsPath, job.payload.files, dest, { signal });
      rows = rows.map((row) => ({
        ...row,
        fastq_1: local.get(row.fastq_1) ?? row.fastq_1,
        fastq_2: local.get(row.fastq_2) ?? row.fastq_2,
      }));
    }
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');

    // Sem campo de amostras (comandos só com parâmetros), não há samplesheet.
    const sheetPath = job.payload.input_param ? join(dir, 'samplesheet.csv') : null;
    if (sheetPath) writeFileSync(sheetPath, samplesheetCsv(job.payload.sheet_columns, rows));
    writeFileSync(join(dir, 'params.json'), JSON.stringify({ ...job.payload.params, ...(sheetPath ? { [job.payload.input_param]: sheetPath } : {}) }, null, 2));
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job.payload, null, 2));

    const { file, args, env, notFound } = isCommand(job) ? this.commandProcess(job, dir, rows, sheetPath) : this.nextflowProcess(job, dir, conn);
    const executable = findExecutable(file, env.PATH);
    if (!executable) throw new Error(notFound);
    rmSync(join(dir, EXIT_FILE), { force: true });

    // Cada tentativa tem seu log. Se fosse o mesmo arquivo, o link antigo da Seqera seria lido de novo.
    const name = logName(job);
    const logPath = join(dir, name);
    if (job.attempts.length && existsSync(logPath)) renameSync(logPath, join(dir, name.replace(/\.out$/, `.tentativa-${job.attempts.length}.out`)));
    const log = openSync(logPath, 'a');
    let child;
    try {
      // detached: o processo ganha sessão própria (como nohup + &), sobrevive ao fim da plataforma
      // e do terminal, e pode ser encerrado junto com seus filhos.
      child = spawn('/bin/sh', ['-c', EXIT_WRAPPER, 'plataforma', executable, ...args], { cwd: dir, env, detached: true, stdio: ['ignore', log, log] });
    } finally {
      closeSync(log);
    }
    child.unref();

    await new Promise((res, rej) => {
      child.once('spawn', res);
      child.once('error', (err) => {
        rej(err.code === 'ENOENT' ? new Error(notFound) : err);
      });
    });

    const current = this.store.getJob(job.id);
    this.store.updateJob(job.id, { state: 'running', pid: child.pid });
    this.follow({ ...current, dir, pid: child.pid }, { child });
    if (this.active.get(job.id)?.cancelling) this.signalGroup(child.pid);
  }

  nextflowProcess(job, dir, conn) {
    const useSeqera = !!conn.seqeraToken;
    if (useSeqera) writeFileSync(join(dir, 'seqera.config'), seqeraConfig(conn), { mode: 0o600 });

    const args = this.nextflowArgs(job, useSeqera);
    this.store.updateJob(job.id, { command: shellJoin([conn.nextflowPath, ...args]) });
    const env = { ...process.env, NXF_ANSI_LOG: 'false' };
    // Essas variáveis ativam o modo agente do Nextflow, que muda a saída da qual o link da Seqera é lido.
    delete env.NXF_AGENT_MODE;
    delete env.CLAUDECODE;
    if (conn.javaHome) env.JAVA_HOME = conn.javaHome;
    return {
      file: conn.nextflowPath,
      args,
      env,
      notFound: `Nextflow não encontrado (${conn.nextflowPath}). Instale o Nextflow ou informe o caminho em Conexões.`,
    };
  }

  commandProcess(job, dir, rows, sheetPath) {
    const { command, params, param_keys: keys, slots } = job.payload;
    // Diferente do Nextflow, um "cat > {outdir}/..." não cria a pasta. No modo "uma por vez" ela é a subpasta da amostra.
    if (typeof params.outdir === 'string' && isAbsolute(params.outdir) && !REMOTE_PATH_RE.test(params.outdir)) {
      mkdirSync(params.outdir, { recursive: true });
    }
    const script = renderCommand({ template: command, params, keys, rows, samplesheet: sheetPath, slots });
    const path = scriptPath(dir);
    writeFileSync(path, script);
    this.store.updateJob(job.id, { command: script });
    return { file: SHELL, args: [path], env: { ...process.env }, notFound: `Shell não encontrado (${SHELL}).` };
  }

  nextflowArgs(job, useSeqera) {
    const { pipeline, revision, profile, stub } = job.payload;
    const localPath = isAbsolute(pipeline) ? pipeline : resolve(this.rootDir, pipeline);
    const isLocal = existsSync(localPath);
    const args = ['run', isLocal ? localPath : pipeline];
    // O Nextflow recusa -r em pipelines locais.
    if (revision && !isLocal) args.push('-r', revision);
    if (profile) args.push('-profile', profile);
    if (stub) args.push('-stub');
    // Explícito porque NXF_WORK ou um workDir na configuração mudariam o local exibido como pasta work.
    args.push('-name', nextflowRunName(job.payload.analysis_id, job.id, job.attempts.length), '-work-dir', 'work', '-params-file', 'params.json');
    if (job.attempts.length) args.push('-resume');
    if (useSeqera) args.push('-c', 'seqera.config');
    return args;
  }

  follow(job, { child } = {}) {
    const logPath = join(job.dir, logName(job));
    let offset = 0;
    let carry = '';
    // Comandos não têm link da Seqera: o log não precisa ser lido durante a execução.
    let foundUrl = !!job.url || isCommand(job);

    const readNew = () => {
      if (foundUrl || !existsSync(logPath)) return;
      const size = statSync(logPath).size;
      if (size <= offset) return;
      const buffer = Buffer.alloc(size - offset);
      const fd = openSync(logPath, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      const text = carry + buffer.toString('utf8').replace(ANSI_RE, '');
      const match = SEQERA_URL_RE.exec(text);
      if (match) {
        foundUrl = true;
        this.store.updateJob(job.id, { url: match[0] });
      }
      carry = text.slice(-512);
    };

    const handle = this.active.get(job.id) ?? { runId: job.runId };
    this.active.set(job.id, handle);
    handle.pid = job.pid;
    handle.child = child;
    handle.logPath = logPath;
    handle.timer = setInterval(() => {
      readNew();
      if (!child && !isProcessAlive(job.pid)) {
        // Sem o objeto do processo (retomado após reinício), o código de saída vem do arquivo do wrapper.
        const { state, message } = this.outcome(job.id, readExitCode(job.dir)?.code ?? null, logPath);
        this.finish(job.id, state, message);
      }
    }, this.pollMs);
    handle.timer.unref?.();

    if (child) {
      child.once('exit', (code, signal) => {
        readNew();
        const { state, message } = this.outcome(job.id, code ?? signal, logPath);
        this.finish(job.id, state, message);
      });
    }
    readNew();
  }

  // Estado final a partir do código de saída. Sem código (null), o resultado é desconhecido.
  outcome(jobId, code, logPath) {
    const job = this.store.getJob(jobId);
    if (job.cancelRequested) return { state: 'cancelled', message: null };
    if (code === null) return { state: 'interrupted', message: INTERRUPTED_MESSAGE };
    if (code === 0) return { state: 'succeeded', message: isCommand(job) ? null : this.noLinkNote(jobId) };
    const how = typeof code === 'number' ? `com código ${code}` : `pelo sinal ${code}`;
    return { state: 'failed', message: lastLines(logPath) || `${isCommand(job) ? 'Comando' : 'Nextflow'} terminou ${how}.` };
  }

  noLinkNote(jobId) {
    if (this.store.getJob(jobId).url) return null;
    return this.store.getConnections().seqeraToken
      ? 'O Nextflow não informou um link da Seqera. Confira o token e o workspace em Conexões.'
      : 'Sem link: token da Seqera não configurado em Conexões.';
  }

  finish(jobId, state, message) {
    const handle = this.active.get(jobId);
    if (handle) {
      clearInterval(handle.timer);
      clearTimeout(handle.killTimer);
      this.active.delete(jobId);
    }
    const job = this.store.getJob(jobId);
    this.removeSeqeraConfig(job?.dir);
    this.store.updateJob(jobId, { state, message: message ?? null, finished_at: Date.now(), pid: null });
    this.tick();
  }

  removeSeqeraConfig(dir) {
    if (dir) rmSync(join(dir, 'seqera.config'), { force: true });
  }

  signalGroup(pid, signal = 'SIGTERM') {
    try {
      process.kill(-pid, signal);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  // Volta o job para a fila, guardando os dados da tentativa que terminou.
  resumeJob(jobId) {
    const job = this.store.getJob(jobId);
    const previous = {
      attempt: job.attempts.length + 1,
      state: job.state,
      url: job.url,
      command: job.command,
      message: job.message,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
    this.store.updateJob(jobId, {
      state: 'queued',
      attempts: JSON.stringify([...job.attempts, previous]),
      url: null,
      command: null,
      message: null,
      pid: null,
      started_at: null,
      finished_at: null,
      cancel_requested: 0,
    });
    this.tick();
  }

  cancelRun(runId) {
    for (const job of this.store.jobsForRun(runId)) {
      if (!ACTIVE_STATES.includes(job.state)) continue;
      if (job.state === 'queued') {
        this.store.updateJob(job.id, { state: 'cancelled', cancel_requested: 1, finished_at: Date.now() });
        continue;
      }
      this.store.updateJob(job.id, { cancel_requested: 1 });
      const handle = this.active.get(job.id);
      if (!handle) continue;
      handle.cancelling = true;
      handle.abort?.abort();
      if (handle.pid) {
        this.signalGroup(handle.pid);
        handle.killTimer = setTimeout(() => this.signalGroup(handle.pid, 'SIGKILL'), this.killGraceMs);
        handle.killTimer.unref?.();
      }
    }
    this.tick();
  }
}

export function runState(jobs) {
  if (jobs.some((j) => j.state === 'running' || j.state === 'downloading')) return 'running';
  if (jobs.some((j) => j.state === 'queued')) return jobs.some((j) => j.startedAt) ? 'running' : 'queued';
  if (jobs.some((j) => j.state === 'failed')) return 'failed';
  if (jobs.some((j) => j.state === 'interrupted')) return 'interrupted';
  if (jobs.some((j) => j.state === 'cancelled')) return 'cancelled';
  return 'succeeded';
}
