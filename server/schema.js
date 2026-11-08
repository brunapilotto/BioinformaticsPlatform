// Validação do schema de cada análise. O front faz uma checagem leve para a pré-visualização;
// a regra que vale é esta, aplicada ao salvar.

import { COMMAND_RESERVED_KEYS } from './jobs.js';

const FIELD_TYPES = new Set(['samples', 'folder', 'file', 'select', 'genome', 'text', 'number', 'boolean']);
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SOURCES = new Set(['local', 'basespace']);
const KINDS = new Set(['nextflow', 'command']);

// Pipelines Nextflow recebem sempre um samplesheet. Comandos podem rodar só com parâmetros.
export function parseSchema(text, { kind = 'nextflow' } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON inválido: ${err.message}`, fields: [] };
  }
  const fields = Array.isArray(parsed) ? parsed : parsed?.fields;
  if (!Array.isArray(fields)) return { ok: false, error: 'O schema precisa ter uma lista "fields".', fields: [] };

  const fail = (error) => ({ ok: false, error, fields: [] });
  const keys = new Set();
  for (const [i, f] of fields.entries()) {
    const where = `Campo ${i + 1}`;
    if (!f || typeof f !== 'object' || !f.key || !f.type) return fail(`${where} sem "key" ou "type".`);
    if (!KEY_RE.test(f.key)) return fail(`${where}: "key" inválida (${f.key}). Use letras, números, _ . ou -, começando com letra.`);
    if (!FIELD_TYPES.has(f.type)) return fail(`${where}: tipo desconhecido (${f.type}).`);
    if (keys.has(f.key)) return fail(`${where}: "key" repetida (${f.key}).`);
    if (kind === 'command' && f.type !== 'samples' && COMMAND_RESERVED_KEYS.includes(f.key)) {
      return fail(`${where}: "${f.key}" é reservado nos comandos. Use outra "key".`);
    }
    keys.add(f.key);
    if ((f.type === 'select' || f.type === 'genome') && (!Array.isArray(f.options) || f.options.length === 0)) {
      return fail(`${where}: "${f.key}" precisa de uma lista "options".`);
    }
    if (f.type === 'samples') {
      const problem = samplesFieldProblem(f);
      if (problem) return fail(`${where}: ${problem}`);
    }
  }
  const samples = fields.filter((f) => f.type === 'samples');
  if (kind === 'command' ? samples.length > 1 : samples.length !== 1) {
    return fail(kind === 'command' ? 'O schema aceita no máximo um campo do tipo "samples".' : 'O schema precisa ter exatamente um campo do tipo "samples".');
  }
  return { ok: true, fields, samplesField: samples[0] ?? null };
}

function samplesFieldProblem(f) {
  if (f.sources !== undefined && (!Array.isArray(f.sources) || !f.sources.length || f.sources.some((s) => !SOURCES.has(s)))) {
    return '"sources" aceita apenas local e basespace.';
  }
  if (f.pattern !== undefined && typeof f.pattern !== 'string') return '"pattern" precisa ser texto.';
  if (f.paired !== undefined && typeof f.paired !== 'boolean') return '"paired" precisa ser true ou false.';
  if (f.sheet !== undefined) {
    const cols = f.sheet?.columns;
    if (!cols || typeof cols !== 'object' || Array.isArray(cols) || !Object.keys(cols).length) return '"sheet.columns" precisa ser um objeto com as colunas do samplesheet.';
    if (Object.values(cols).some((v) => typeof v !== 'string')) return 'Os valores de "sheet.columns" precisam ser texto.';
  }
  return null;
}

// Retorna a análise normalizada ou lança Error com a lista de problemas.
export function normalizeAnalysis(input) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const kind = input.kind === undefined ? 'nextflow' : input.kind;
  const isCommand = kind === 'command';
  const a = {
    id: text(input.id),
    kind,
    name: text(input.name),
    category: text(input.category),
    description: text(input.description),
    pipeline: isCommand ? '' : text(input.pipeline),
    revision: isCommand ? '' : text(input.revision),
    profile: isCommand ? '' : text(input.profile),
    command: isCommand && typeof input.command === 'string' ? input.command.replaceAll('\r', '').trim() : '',
    minutes: Number(input.minutes),
    slots: Math.floor(Number(input.slots)),
    enabled: input.enabled !== false,
    stub: !isCommand && input.stub === true,
    schema: typeof input.schema === 'string' ? input.schema : '',
  };
  const problems = [];
  if (!a.name) problems.push('nome é obrigatório');
  if (!ID_RE.test(a.id)) problems.push('identificador deve usar letras minúsculas, números, - ou _');
  if (!KINDS.has(kind)) problems.push('tipo deve ser nextflow ou command');
  if (isCommand && !a.command) problems.push('comando é obrigatório');
  if (!isCommand && !a.pipeline) problems.push('pipeline é obrigatória');
  // Estes três viram argumentos do nextflow: um valor iniciado por "-" seria lido como opção.
  for (const [label, value] of [['pipeline', a.pipeline], ['revisão', a.revision], ['perfil', a.profile]]) {
    if (value.startsWith('-')) problems.push(`${label} não pode começar com "-"`);
  }
  if (!(a.minutes > 0)) problems.push(isCommand ? 'tempo médio deve ser maior que zero' : 'tempo por amostra deve ser maior que zero');
  if (!(a.slots >= 1)) problems.push('amostras em paralelo deve ser ao menos 1');
  const schema = parseSchema(a.schema, { kind });
  if (!schema.ok) problems.push(`schema: ${schema.error}`);
  if (problems.length) throw new Error(problems.join('; '));
  return a;
}
