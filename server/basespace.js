// Toda a comunicação com o BaseSpace passa pela CLI `bs`, autenticada na máquina com `bs auth`.
// Os argumentos usam o formato --flag=valor, para que um nome de projeto iniciado por "-" não vire opção.

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { globToRegex } from './fastq.js';

const exec = promisify(execFile);
const LIST_TIMEOUT_MS = 120_000;
const LIST_CONCURRENCY = 6;
const FASTQ_RE = /\.(?:fastq|fq)(?:\.gz)?$/i;

export class BaseSpaceError extends Error {}

async function runBs(bsPath, args, { signal, timeout = LIST_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec(bsPath, args, { signal, timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.code === 'ENOENT') {
      throw new BaseSpaceError(`CLI do BaseSpace não encontrada (${bsPath}). Instale a CLI "bs" ou informe o caminho do executável em Conexões.`);
    }
    if (err.killed) throw new BaseSpaceError('A CLI do BaseSpace demorou demais para responder.');
    const detail = String(err.stderr || err.stdout || err.message).trim().split('\n').slice(-3).join(' ');
    throw new BaseSpaceError(detail || 'A CLI do BaseSpace retornou um erro.');
  }
}

function parseJsonList(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BaseSpaceError('A CLI do BaseSpace devolveu uma resposta em formato inesperado.');
  }
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.Items) ? data.Items : [];
}

// A saída de `bs whoami` é uma tabela: | Email | fulano@lab.org |
function parseWhoami(stdout) {
  const fields = {};
  for (const line of stdout.split('\n')) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2) fields[cells[0].toLowerCase()] = cells[1];
  }
  return { account: fields.email || fields.name || '', host: fields.host || fields.apiserver || '' };
}

export async function whoami(bsPath) {
  let stdout;
  try {
    stdout = await runBs(bsPath, ['whoami'], { timeout: 30_000 });
  } catch (err) {
    if (err instanceof BaseSpaceError && !err.message.startsWith('CLI do BaseSpace não encontrada')) {
      throw new BaseSpaceError(`A CLI não conseguiu autenticar. Rode "bs auth" no terminal. Detalhe: ${err.message}`);
    }
    throw err;
  }
  const { account, host } = parseWhoami(stdout);
  if (!account) throw new BaseSpaceError('A CLI respondeu, mas sem identificar a conta. Rode "bs auth" no terminal.');
  return { account, host };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --filter-term é uma expressão regular: o nome digitado é escapado para ser tratado como texto.
export async function searchProjects(bsPath, query) {
  const term = query.trim();
  if (!term) throw new BaseSpaceError('Informe o nome do projeto.');
  const stdout = await runBs(bsPath, ['list', 'projects', '--filter-field=Name', `--filter-term=(?i)${escapeRegex(term)}`, '-f', 'json']);
  const projects = parseJsonList(stdout).map((p) => ({ id: String(p.Id), name: p.Name ?? String(p.Id) }));
  const exact = projects.filter((p) => p.name.toLowerCase() === term.toLowerCase());
  return exact.length === 1 ? exact : projects;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Lista só os FASTQs do projeto escolhido, sem varrer o restante da conta.
export async function listProjectFastqs(bsPath, projectId, { pattern } = {}) {
  const matches = pattern ? globToRegex(pattern) : FASTQ_RE;
  const datasets = parseJsonList(await runBs(bsPath, ['list', 'datasets', `--project-id=${projectId}`, '-f', 'json']));
  const perDataset = await mapLimit(datasets, LIST_CONCURRENCY, async (dataset) => {
    const id = String(dataset.Id);
    const contents = parseJsonList(await runBs(bsPath, ['contents', 'dataset', `--id=${id}`, '-f', 'json']));
    return contents.map((file) => {
      const name = basename(String(file.FilePath ?? file.Path ?? file.Name ?? ''));
      return { name, path: `basespace://${id}/${name}`, size: Number(file.Size) || null, dataset: id };
    }).filter((file) => FASTQ_RE.test(file.name) && matches.test(file.name));
  });
  return perDataset.flat();
}

async function filesUnder(dir, found = new Map()) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, found);
    else if (entry.isFile()) found.set(entry.name, full);
  }
  return found;
}

async function hasFile(local, wanted) {
  if (!local) return false;
  if (wanted.size == null) return true;
  return (await stat(local)).size === wanted.size;
}

// Baixa os datasets das amostras do job, reaproveitando o que já foi baixado com o tamanho certo.
// Retorna um mapa de basespace://<dataset>/<arquivo> para o caminho local.
export async function downloadFiles(bsPath, files, destRoot, { signal } = {}) {
  const byDataset = new Map();
  for (const file of files) {
    byDataset.set(file.dataset, [...(byDataset.get(file.dataset) ?? []), file]);
  }
  const resolved = new Map();
  for (const [dataset, wanted] of byDataset) {
    const dest = join(destRoot, dataset);
    await mkdir(dest, { recursive: true });
    let local = await filesUnder(dest);
    const present = await Promise.all(wanted.map((f) => hasFile(local.get(f.name), f)));
    if (!present.every(Boolean)) {
      await runBs(bsPath, ['download', 'dataset', `--id=${dataset}`, '--extension=fastq.gz', '--extension=fq.gz', '-o', dest], { signal, timeout: 0 });
      local = await filesUnder(dest);
      for (const file of wanted) {
        if (!(await hasFile(local.get(file.name), file))) {
          throw new BaseSpaceError(`Download incompleto do arquivo ${file.name}.`);
        }
      }
    }
    for (const file of wanted) resolved.set(file.path, local.get(file.name));
  }
  return resolved;
}
