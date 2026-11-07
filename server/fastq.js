import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_DEPTH = 8;
const MAX_FILES = 20000;

const EXT = String.raw`\.(?:fastq|fq)(?:\.gz)?$`;
const NAME_PATTERNS = [
  // Nome_S1_L001_R1_001.fastq.gz (bcl2fastq / BCL Convert), com lane opcional
  { re: new RegExp(String.raw`^(?<sample>.+?)_S\d+(?:_L(?<lane>\d{3}))?_R(?<read>[12])_(?<chunk>\d{3})${EXT}`, 'i') },
  // Nome_L001_R1.fastq.gz, Nome_R1.fastq.gz, Nome.R1.fq.gz, Nome_R1_001.fastq.gz
  { re: new RegExp(String.raw`^(?<sample>.+?)(?:_L(?<lane>\d{3}))?[._-]R(?<read>[12])(?:[._-](?<chunk>\d{3}))?${EXT}`, 'i') },
  // Nome_1.fq.gz, Nome.2.fastq
  { re: new RegExp(String.raw`^(?<sample>.+?)(?:_L(?<lane>\d{3}))?[._-](?<read>[12])${EXT}`, 'i') },
  // Nome.fastq.gz (um único arquivo, sem indicação de read)
  { re: new RegExp(String.raw`^(?<sample>.+?)${EXT}`, 'i') },
];
// Arquivos de índice do sequenciador não são reads da amostra.
const INDEX_RE = new RegExp(String.raw`_I[12]_\d{3}${EXT}`, 'i');
const FASTQ_RE = new RegExp(EXT, 'i');

export function parseFastqName(name) {
  if (INDEX_RE.test(name)) return null;
  for (const { re } of NAME_PATTERNS) {
    const m = re.exec(name);
    if (m) {
      const { sample, lane, read, chunk } = m.groups;
      return { sample, lane: lane ? `L${lane}` : null, read: read === '2' ? 2 : 1, unit: `${lane || ''}|${chunk || ''}` };
    }
  }
  return null;
}

// Aceita o glob usado nos schemas: *, ? e {a,b}. Compara com o nome do arquivo, sem a pasta.
export function globToRegex(pattern) {
  let out = '';
  let depth = 0;
  for (const c of pattern) {
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { out += '(?:'; depth++; }
    else if (c === '}' && depth) { out += ')'; depth--; }
    else if (c === ',' && depth) out += '|';
    else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  out += ')'.repeat(depth);
  return new RegExp(`^${out}$`);
}

export function fmtBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i && value < 100 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

// files: [{ name, path, size, dataset? }]. Usado tanto para pasta local quanto para o BaseSpace.
export function groupFastqFiles(files, { paired = true } = {}) {
  const samples = new Map();
  for (const file of files) {
    const parsed = parseFastqName(file.name);
    if (!parsed) continue;
    const sample = samples.get(parsed.sample) ?? { name: parsed.sample, units: new Map(), duplicate: false };
    samples.set(parsed.sample, sample);
    const unit = sample.units.get(parsed.unit) ?? { lane: parsed.lane, r1: null, r2: null };
    sample.units.set(parsed.unit, unit);
    const slot = parsed.read === 2 ? 'r2' : 'r1';
    if (unit[slot]) sample.duplicate = true;
    unit[slot] = file;
  }
  return [...samples.values()]
    .map((sample) => toSample(sample, paired))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function toSample(sample, paired) {
  const units = [...sample.units.values()].sort((a, b) => String(a.lane).localeCompare(String(b.lane)));
  let reason = null;
  if (sample.duplicate) reason = 'Arquivo duplicado';
  else if (units.some((u) => !u.r1)) reason = 'R1 ausente';
  else if (paired && units.some((u) => !u.r2)) reason = 'R2 ausente';
  const files = units.flatMap((u) => [u.r1, u.r2]).filter(Boolean);
  const sizeBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const undetermined = /^undetermined$/i.test(sample.name);
  return {
    id: sample.name,
    name: sample.name,
    r1: units[0].r1?.name ?? null,
    r2: units[0].r2?.name ?? null,
    lanes: units.length,
    units: units.map((u) => ({ lane: u.lane, r1: u.r1?.path ?? null, r2: u.r2?.path ?? null })),
    files: files.map((f) => ({ name: f.name, path: f.path, size: f.size ?? null, dataset: f.dataset ?? null })),
    sizeBytes,
    size: fmtBytes(sizeBytes),
    invalid: !!reason,
    reason,
    selected: !reason && !undetermined,
  };
}

export async function scanFolder(root, { pattern, paired = true } = {}) {
  const matches = pattern ? globToRegex(pattern) : FASTQ_RE;
  const files = [];
  const warnings = [];
  let truncated = false;

  async function walk(dir, depth) {
    let handle;
    try {
      handle = await opendir(dir);
    } catch (err) {
      if (depth === 0) throw folderError(err, root);
      warnings.push(`Sem acesso a ${dir}`);
      return;
    }
    for await (const entry of handle) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
        continue;
      }
      // Links para arquivos são comuns em pastas de sequenciamento e entram na busca.
      // Links para pastas ficam de fora, porque podem criar ciclos.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!FASTQ_RE.test(entry.name) || !matches.test(entry.name)) continue;
      if (files.length >= MAX_FILES) { truncated = true; continue; }
      try {
        const info = await stat(full);
        if (info.isFile()) files.push({ name: entry.name, path: full, size: info.size });
      } catch {
        warnings.push(`Link quebrado: ${full}`);
      }
    }
  }

  await walk(root, 0);
  if (truncated) warnings.push(`A busca parou em ${MAX_FILES} arquivos. Selecione uma pasta mais específica.`);
  return { samples: groupFastqFiles(files, { paired }), warnings };
}

function folderError(err, path) {
  if (err.code === 'ENOENT') return new Error(`Pasta não encontrada: ${path}`);
  if (err.code === 'ENOTDIR') return new Error(`Não é uma pasta: ${path}`);
  if (err.code === 'EACCES' || err.code === 'EPERM') return new Error(`Sem permissão para ler a pasta: ${path}`);
  return err;
}
