import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../server/index.js';

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plataforma-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeExecutable(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

export function touchFastqs(root, relPaths, size = 10) {
  for (const rel of relPaths) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.alloc(size));
  }
}

// Nextflow de mentira. O comportamento depende do conteúdo do samplesheet:
// FAILME encerra com erro; SLOW fica rodando até receber um sinal; NOLINK não imprime URL.
export function fakeNextflow(dir) {
  const eventLog = join(dir, 'events.log');
  const path = writeExecutable(join(dir, 'bin', 'nextflow'), `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "NOTE: Nextflow is not tested with Java 1.8 -- recommended version 11 up to 23"
  echo "      version 25.04.0 build 5928"
  exit 0
fi
echo "$@" > args.txt
[ -n "$NXF_AGENT_MODE$CLAUDECODE" ] && touch modo-agente
[ -f seqera.config ] && ls -l seqera.config > seqera.perms && cp seqera.config seqera.seen
sample=$(sed -n 2p samplesheet.csv | cut -d, -f1)
# A retomada imprime outro link, como o Seqera faz em cada execução.
case "$*" in *-resume*) resumed=1; link="\${sample}res" ;; *) resumed=0; link="\${sample}abc" ;; esac
# O trap vem antes do "start": o teste só envia o sinal depois de ver essa linha.
trap 'echo "end $sample" >> "${eventLog}"; exit 143' TERM
echo "start $sample" >> "${eventLog}"
if ! grep -q NOLINK samplesheet.csv && [ -f seqera.config ]; then
  echo "Monitor the execution with Seqera Platform using this URL: https://cloud.seqera.io/orgs/lab/workspaces/prod/watch/$link"
fi
# FAILME falha só na primeira vez; ALWAYSFAIL falha também nas retomadas.
if grep -q ALWAYSFAIL samplesheet.csv || { grep -q FAILME samplesheet.csv && [ "$resumed" = 0 ]; }; then
  printf '\\033[33mNextflow novo disponivel\\033(B\\033[m\\n'
  echo "ERROR ~ falha simulada"
  echo "end $sample" >> "${eventLog}"
  exit 3
fi
if grep -q SLOW samplesheet.csv; then
  sleep 60 &
  wait $!
fi
echo "end $sample" >> "${eventLog}"
`);
  return { path, eventLog };
}

export async function startApp(t, { dataDir, settings } = {}) {
  const dir = dataDir ?? tempDir(t);
  const app = createApp({ dataDir: dir, pollMs: 30 });
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // Requisição crua: o fetch não permite definir Host nem Origin.
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (r) => {
      let text = '';
      r.on('data', (c) => { text += c; });
      r.on('end', () => res({ status: r.statusCode, text, headers: r.headers }));
    });
    req.on('error', rej);
    req.end(body);
  });

  const close = async () => {
    app.runner.stop();
    await new Promise((res) => app.server.close(res));
    app.store.close();
  };
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await close();
  };
  t.after(closeOnce);

  if (settings) app.store.setConnections({ ...app.store.getConnections(), ...settings });
  app.runner.start();
  return { ...app, dir, port, base, api, raw, close: closeOnce };
}

export const testAnalysis = (overrides = {}, samplesExtra = {}, outdir = '/tmp/saida') => ({
  id: 'teste',
  name: 'Análise de teste',
  category: 'Teste',
  description: '',
  pipeline: 'lab/teste',
  revision: '1.0',
  profile: '',
  minutes: 10,
  slots: 2,
  enabled: true,
  stub: false,
  schema: JSON.stringify({
    fields: [
      { key: 'input', type: 'samples', label: 'Amostras', pattern: '*.fastq.gz', ...samplesExtra },
      { key: 'outdir', type: 'folder', label: 'Resultados', required: true, default: outdir },
      { key: 'threads', type: 'number', label: 'Threads', default: 2 },
    ],
  }),
  ...overrides,
});

export async function waitFor(check, { timeout = 8000, label = 'condição' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Tempo esgotado aguardando ${label}`);
    await new Promise((res) => { setTimeout(res, 25); });
  }
}
