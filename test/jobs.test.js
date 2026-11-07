import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJobs, etaMinutes, localDate, nextflowRunName, resolveParams, samplesheetCsv, shellJoin } from '../server/jobs.js';
import { parseSchema, normalizeAnalysis } from '../server/schema.js';
import { SEED_ANALYSES } from '../server/seeds.js';
import { seqeraConfig } from '../server/runner.js';

const sample = (name, lanes = ['L001']) => ({
  id: name,
  name,
  units: lanes.map((lane) => ({ lane, r1: `/d/${name}_${lane}_R1.fq.gz`, r2: `/d/${name}_${lane}_R2.fq.gz` })),
  files: [],
});
const analysis = { id: 'wes', name: 'Exoma', pipeline: 'nf-core/sarek', revision: '3.4.2', profile: 'docker', minutes: 120, slots: 2, stub: false };
const fields = [{ key: 'input', type: 'samples' }, { key: 'outdir', type: 'folder' }];
const build = (mode, samples) => buildJobs({ runId: 'run-abc123', analysis, fields, source: { type: 'local', path: '/d' }, samples, params: { outdir: '/res/' }, mode });

test('todas ao mesmo tempo: 1 job com todas as amostras e todas as lanes', () => {
  const { run, jobs } = build('parallel', [sample('A', ['L001', 'L002']), sample('B')]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.mode, 'batch');
  assert.equal(jobs[0].payload.samples.length, 3);
  assert.equal(jobs[0].payload.params.outdir, '/res/');
  assert.equal(run.etaMin, 120);
});

test('uma por vez: 1 job por amostra, com outdir próprio', () => {
  const { run, jobs } = build('sequential', [sample('A', ['L001', 'L002']), sample('B/../x')]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].payload.sequence, { index: 1, total: 2 });
  assert.equal(jobs[0].payload.samples.length, 2);
  assert.equal(jobs[0].payload.params.outdir, '/res/A');
  assert.equal(jobs[1].payload.params.outdir, '/res/B_.._x', 'nome da amostra não escapa da pasta');
  assert.equal(run.etaMin, 240);
});

test('estimativa de tempo', () => {
  assert.equal(etaMinutes(60, 4, 10, 'sequential'), 600);
  assert.equal(etaMinutes(60, 4, 10, 'parallel'), 180);
  assert.equal(etaMinutes(60, 4, 4, 'parallel'), 60);
});

test('samplesheet segue as colunas do schema e escapa o CSV', () => {
  const rows = [{ sample: 'A', lane: 'L001', fastq_1: '/d/a,b_R1.fq.gz', fastq_2: '/d/$&_R2.fq.gz' }, { sample: 'B', lane: null, fastq_1: '/d/b.fq.gz', fastq_2: null }];
  assert.equal(
    samplesheetCsv({ patient: '{sample}', lane: '{lane}', fastq_1: '{r1}', fastq_2: '{r2}', group: '0' }, rows),
    'patient,lane,fastq_1,fastq_2,group\nA,L001,"/d/a,b_R1.fq.gz",/d/$&_R2.fq.gz,0\nB,1,/d/b.fq.gz,,0\n',
  );
});

test('parâmetros: defaults, {date}, obrigatórios, tipos e opções', () => {
  const schema = [
    { key: 'input', type: 'samples' },
    { key: 'outdir', type: 'folder', required: true, default: '/r/{analysis}/{date}/{date}' },
    { key: 'n', type: 'number', default: 2 },
    { key: 'g', type: 'genome', options: ['GRCh38', 'GRCh37'] },
    { key: 'b', type: 'boolean' },
    { key: 'txt', type: 'text', required: true },
  ];
  const now = new Date(2026, 10, 7, 23, 30);
  const missing = resolveParams(schema, {}, 'wes', now);
  assert.deepEqual(missing.errors, ['txt é obrigatório']);
  assert.equal(missing.params.outdir, '/r/wes/2026-11-07/2026-11-07', 'usa a data local e todas as ocorrências');
  assert.equal(missing.params.g, 'GRCh38');
  assert.equal(missing.params.b, false);

  const bad = resolveParams(schema, { txt: 'x', n: 'abc', g: 'hg19', extra: 'y' }, 'wes', now);
  assert.deepEqual(bad.errors, ['n deve ser um número', 'g: opção inválida']);
  assert.ok(!('extra' in bad.params), 'campos fora do schema são descartados');
  assert.equal(localDate(now), '2026-11-07');
});

test('comando exibido escapa o que o shell interpretaria', () => {
  assert.equal(shellJoin(['nextflow', 'run', 'nf-core/sarek', '-r', '3.4.2', '-profile', 'docker,test']), 'nextflow run nf-core/sarek -r 3.4.2 -profile docker,test');
  assert.equal(shellJoin(['/Meus Apps/nextflow', 'run', "it's", '$HOME;rm', '']), `'/Meus Apps/nextflow' run 'it'\\''s' '$HOME;rm' ''`);
});

test('nome da execução é aceito pelo Nextflow', () => {
  const valid = /^[a-z](?:[a-z\d]|[-_](?=[a-z\d])){0,79}$/;
  assert.match(nextflowRunName('painel-onco', 'run-a1b2c3-001'), valid);
  assert.match(nextflowRunName('a_b--c_', 'run-a1b2c3-001'), valid);
  assert.match(nextflowRunName('x'.repeat(60), `run-${'y'.repeat(32)}-001`, 12), valid);
  assert.equal(nextflowRunName('wes', 'run-a1b2c3-001', 2), 'pl-wes-a1b2c3-001-r2');
});

test('schema: rejeita problemas com mensagem clara', () => {
  const check = (fieldsList, expected) => assert.match(parseSchema(JSON.stringify({ fields: fieldsList })).error, expected);
  const samples = { key: 'input', type: 'samples' };
  assert.match(parseSchema('{').error, /JSON inválido/);
  assert.match(parseSchema('{}').error, /lista "fields"/);
  check([], /exatamente um campo/);
  check([samples, { key: 'b', type: 'samples' }], /exatamente um campo/);
  check([samples, { key: 'a' }], /sem "key" ou "type"/);
  check([samples, { key: 'a', type: 'cor' }], /tipo desconhecido/);
  check([samples, { key: 'input', type: 'text' }], /repetida/);
  check([samples, { key: 'a b', type: 'text' }], /inválida/);
  check([samples, { key: 'a', type: 'select' }], /options/);
  check([{ ...samples, sources: ['ftp'] }], /sources/);
  check([{ ...samples, sheet: {} }], /sheet.columns/);
});

test('análise: campos que viram argumentos não podem começar com -', () => {
  const schema = JSON.stringify({ fields: [{ key: 'input', type: 'samples' }] });
  const base = { id: 'a', name: 'A', pipeline: 'x/y', minutes: 1, slots: 1, schema };
  assert.equal(normalizeAnalysis(base).revision, '');
  assert.throws(() => normalizeAnalysis({ ...base, pipeline: '-c /etc/x' }), /pipeline não pode/);
  assert.throws(() => normalizeAnalysis({ ...base, revision: '--help' }), /revisão não pode/);
  assert.throws(() => normalizeAnalysis({ ...base, profile: '-x' }), /perfil não pode/);
  assert.throws(() => normalizeAnalysis({ ...base, id: 'A B' }), /identificador/);
  assert.throws(() => normalizeAnalysis({ ...base, minutes: 0 }), /tempo por amostra/);
});

test('as análises iniciais têm schema válido', () => {
  for (const seed of SEED_ANALYSES) assert.ok(normalizeAnalysis(seed), seed.id);
});

test('config da Seqera escapa os valores', () => {
  const config = seqeraConfig({ seqeraToken: "to'k\\en", seqeraApi: 'https://api.cloud.seqera.io', seqeraWorkspaceId: '123' });
  assert.match(config, /accessToken = 'to\\'k\\\\en'/);
  assert.match(config, /endpoint = 'https:\/\/api.cloud.seqera.io'/);
  assert.match(config, /workspaceId = '123'/);
  assert.doesNotMatch(seqeraConfig({ seqeraToken: 'x', seqeraApi: 'https://a', seqeraWorkspaceId: '' }), /workspaceId/);
});
