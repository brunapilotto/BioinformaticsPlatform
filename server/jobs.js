// Transforma um disparo em jobs. Sem efeitos colaterais: quem grava e executa é o runner.

export const DEFAULT_SHEET_COLUMNS = { sample: '{sample}', fastq_1: '{r1}', fastq_2: '{r2}' };

export const etaMinutes = (minutes, slots, n, mode) => {
  if (mode === 'single') return minutes;
  return mode === 'parallel' ? minutes * Math.ceil(n / Math.max(1, slots)) : minutes * n;
};

export const localDate = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const resolveTemplate = (value, analysisId, now) => (typeof value === 'string'
  ? value.replaceAll('{date}', localDate(now)).replaceAll('{analysis}', analysisId)
  : value);

const optionValue = (o) => (o && typeof o === 'object' ? o.value : o);

function defaultFor(field, analysisId, now) {
  if (field.default !== undefined) return resolveTemplate(field.default, analysisId, now);
  if (field.type === 'boolean') return false;
  if (field.type === 'select' || field.type === 'genome') return optionValue(field.options[0]);
  return '';
}

// Aplica defaults, confere tipos e obrigatórios, e descarta o que não está no schema.
export function resolveParams(fields, input = {}, analysisId, now = new Date()) {
  const params = {};
  const errors = [];
  for (const field of fields) {
    if (field.type === 'samples') continue;
    const label = field.label || field.key;
    let value = Object.hasOwn(input, field.key) ? input[field.key] : defaultFor(field, analysisId, now);
    if (typeof value === 'string') value = value.trim();

    if (field.type === 'boolean') {
      value = value === true;
    } else if (value === '' || value === null || value === undefined) {
      if (field.required) errors.push(`${label} é obrigatório`);
      continue;
    } else if (field.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) { errors.push(`${label} deve ser um número`); continue; }
    } else if (field.type === 'select' || field.type === 'genome') {
      if (!field.options.map(optionValue).includes(value)) { errors.push(`${label}: opção inválida`); continue; }
    } else if (typeof value !== 'string') {
      errors.push(`${label} deve ser texto`);
      continue;
    }
    params[field.key] = value;
  }
  return { params, errors };
}

const safeSegment = (name) => String(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'amostra';

function sheetRows(sample) {
  return sample.units.map((u) => ({ sample: sample.name, lane: u.lane, fastq_1: u.r1, fastq_2: u.r2 }));
}

export function buildJobs({ runId, analysis, fields, source, samples, params, mode, now = new Date() }) {
  const samplesField = fields.find((f) => f.type === 'samples');
  const kind = analysis.kind === 'command' ? 'command' : 'nextflow';
  const base = {
    analysis_id: analysis.id,
    kind,
    // O modelo do comando é copiado no disparo: editar a análise depois não muda o que já está na fila.
    ...(kind === 'command'
      ? { command: analysis.command, param_keys: fields.filter((f) => f.type !== 'samples').map((f) => f.key), slots: analysis.slots }
      : { pipeline: analysis.pipeline, revision: analysis.revision, profile: analysis.profile, stub: !!analysis.stub }),
    source,
    input_param: samplesField?.key ?? null,
    sheet_columns: samplesField ? samplesField.sheet?.columns ?? DEFAULT_SHEET_COLUMNS : null,
  };
  const n = samples.length;
  const jobs = !samplesField
    ? [{
      seq: 1,
      label: 'Execução única',
      payload: { ...base, run_id: runId, mode: 'single', params: { ...params }, samples: [], files: [], estimated_minutes: analysis.minutes },
    }]
    : mode === 'parallel'
    ? [{
      seq: 1,
      label: `Lote · ${n} amostra${n === 1 ? '' : 's'}`,
      payload: {
        ...base,
        run_id: runId,
        mode: 'batch',
        params: { ...params },
        samples: samples.flatMap(sheetRows),
        files: samples.flatMap((s) => s.files),
        estimated_minutes: etaMinutes(analysis.minutes, analysis.slots, n, 'parallel'),
      },
    }]
    : samples.map((sample, i) => ({
      seq: i + 1,
      label: `${i + 1}. ${sample.name}`,
      payload: {
        ...base,
        run_id: `${runId}-${String(i + 1).padStart(2, '0')}`,
        mode: 'sequential',
        sequence: { index: i + 1, total: n },
        // Cada amostra vira uma execução: com a mesma pasta, MultiQC e pipeline_info seriam sobrescritos.
        params: params.outdir ? { ...params, outdir: `${String(params.outdir).replace(/\/+$/, '')}/${safeSegment(sample.name)}` } : { ...params },
        samples: sheetRows(sample),
        files: sample.files,
        estimated_minutes: analysis.minutes,
      },
    }));

  const run = {
    id: runId,
    analysisId: analysis.id,
    analysisName: analysis.name,
    kind,
    n,
    mode,
    minutes: analysis.minutes,
    slots: analysis.slots,
    etaMin: etaMinutes(analysis.minutes, analysis.slots, n, mode),
    createdAt: now.getTime(),
    source,
    sampleNames: samples.map((s) => s.name),
    params,
  };
  return { run, jobs: jobs.map((j) => ({ ...j, id: `${runId}-${String(j.seq).padStart(3, '0')}` })) };
}

const csvCell = (v) => {
  const text = v == null ? '' : String(v);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function samplesheetCsv(columns, rows) {
  const names = Object.keys(columns);
  const fill = (template, row) => template
    // Com função, um "$" em caminhos e nomes não é interpretado como padrão de substituição.
    .replaceAll('{sample}', () => row.sample ?? '')
    .replaceAll('{lane}', () => row.lane ?? '1')
    .replaceAll('{r1}', () => row.fastq_1 ?? '')
    .replaceAll('{r2}', () => row.fastq_2 ?? '');
  const lines = rows.map((row) => names.map((name) => csvCell(fill(columns[name], row))).join(','));
  return [names.map(csvCell).join(','), ...lines].join('\n') + '\n';
}

export const shellQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

// Texto do comando para exibição e cópia. A execução em si usa a lista de argumentos, sem shell.
export const shellJoin = (args) => args.map(shellQuote).join(' ');

export const SAMPLE_PLACEHOLDERS = ['sample', 'r1', 'r2'];
export const COMMAND_RESERVED_KEYS = [...SAMPLE_PLACEHOLDERS, 'samplesheet'];
// {nome} vira valor; ${VAR} é do shell e fica como está.
const PLACEHOLDER_RE = /(?<!\$)\{([A-Za-z][A-Za-z0-9_.-]*)\}/g;

export function commandPlaceholders(template) {
  const names = [...new Set([...String(template).matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
  return { names, perSample: names.some((n) => SAMPLE_PLACEHOLDERS.includes(n)) };
}

// Nomes desconhecidos ficam como estão, para não quebrar algo como o {print} do awk.
const fillCommand = (template, values) => template.replace(PLACEHOLDER_RE, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole));

function groupSamples(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.sample)) byName.set(row.sample, { name: row.sample, r1: [], r2: [] });
    const s = byName.get(row.sample);
    if (row.fastq_1) s.r1.push(row.fastq_1);
    if (row.fastq_2) s.r2.push(row.fastq_2);
  }
  return [...byName.values()];
}

// Monta o comando.sh. Todo valor entra com quoting de shell: o formulário não consegue injetar comandos.
// Com {sample}, {r1} ou {r2}, o modelo se repete por amostra, em grupos de até `slots` ao mesmo tempo.
export function renderCommand({ template, params = {}, keys = [], rows = [], samplesheet = null, slots = 1 }) {
  const body = String(template).replaceAll('\r', '').trimEnd();
  const values = Object.fromEntries(keys.map((k) => [k, shellQuote(params[k] == null ? '' : String(params[k]))]));
  if (samplesheet) values.samplesheet = shellQuote(samplesheet);
  const lines = ['#!/bin/bash', '# Gerado pela Plataforma de Pipelines.', 'set -eo pipefail', ''];
  const samples = samplesheet && commandPlaceholders(body).perSample ? groupSamples(rows) : [];
  const blocks = samples.map((s) => fillCommand(body, {
    ...values,
    sample: shellQuote(s.name),
    r1: s.r1.map(shellQuote).join(' '),
    r2: s.r2.map(shellQuote).join(' '),
  }));
  if (blocks.length <= 1) return [...lines, blocks[0] ?? fillCommand(body, values), ''].join('\n');

  const size = Math.max(1, Math.floor(Number(slots)) || 1);
  lines.push('falhou=0');
  for (let i = 0; i < blocks.length; i += size) {
    const group = samples.slice(i, i + size);
    group.forEach((s, j) => lines.push('', `# Amostra ${s.name.replace(/\s+/g, ' ')}`, '(', blocks[i + j], `) & p${j}=$!`));
    lines.push('');
    group.forEach((s, j) => lines.push(`wait $p${j} || { falhou=1; echo "Falhou na amostra "${shellQuote(s.name)} >&2; }`));
  }
  lines.push('exit $falhou', '');
  return lines.join('\n');
}

// Nextflow só aceita nomes em minúsculas, com - ou _ sempre seguidos de letra ou número.
// O nome também não pode se repetir, nem com -resume: cada retomada ganha o sufixo -r<n>.
export function nextflowRunName(analysisId, jobId, attempt = 0) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `pl-${clean(analysisId).slice(0, 30).replace(/-+$/, '')}-${clean(jobId).replace(/^run-/, '')}`;
  return attempt ? `${base}-r${attempt}` : base;
}
