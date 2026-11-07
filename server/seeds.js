// Conteúdo inicial, gravado somente na primeira execução. Tudo pode ser alterado pelo Admin.

const DEFAULT_ACCENT = '#9184d9';

const samplesField = (sheet) => ({
  key: 'input',
  type: 'samples',
  label: 'Amostras',
  required: true,
  sources: ['local', 'basespace'],
  pattern: '*_R{1,2}_001.fastq.gz',
  ...(sheet ? { sheet: { columns: sheet } } : {}),
});

const outdirField = (id) => ({
  key: 'outdir',
  type: 'folder',
  label: 'Pasta de resultados',
  required: true,
  default: `/data/resultados/${id}/{date}`,
});

const schema = (fields) => JSON.stringify({ fields }, null, 2);

export const SEED_ANALYSES = [
  {
    id: 'painel-onco', name: 'Painel oncológico', category: 'Oncologia',
    description: 'Variantes somáticas, CNVs e fusões em painel de genes de câncer.',
    pipeline: 'lab/onco-panel', revision: '2.1.0', profile: 'docker', minutes: 60, slots: 4, enabled: true, stub: false,
    schema: schema([
      samplesField(),
      { key: 'data_type', type: 'select', label: 'Tipo de dado', required: true, options: ['Tumor-only', 'Tumor-normal'], default: 'Tumor-only' },
      { key: 'panel_version', type: 'text', label: 'Versão do painel', required: true, default: 'v4' },
      { key: 'min_vaf', type: 'number', label: 'VAF mínima', default: 0.05, help: 'Frequência alélica mínima para reportar variantes.' },
      outdirField('painel-onco'),
      { key: 'call_fusions', type: 'boolean', label: 'Detectar fusões', default: true },
    ]),
  },
  {
    id: 'nutrigenetico', name: 'Nutrigenético', category: 'Nutrigenômica',
    description: 'Genotipagem de variantes associadas a metabolismo, nutrientes e intolerâncias.',
    pipeline: 'lab/nutrigen', revision: '1.4.0', profile: 'docker', minutes: 30, slots: 8, enabled: true, stub: false,
    schema: schema([
      samplesField(),
      { key: 'panel_version', type: 'text', label: 'Versão do painel', required: true, default: 'v3' },
      { key: 'min_depth', type: 'number', label: 'Profundidade mínima', default: 30 },
      outdirField('nutrigenetico'),
      { key: 'report', type: 'boolean', label: 'Gerar laudo automaticamente', default: true },
    ]),
  },
  {
    id: 'metagenomica', name: 'Metagenômica Shotgun', category: 'Microbioma',
    description: 'Remoção de hospedeiro, classificação taxonômica e montagem de metagenomas.',
    pipeline: 'nf-core/mag', revision: '3.0.3', profile: 'docker', minutes: 90, slots: 3, enabled: true, stub: false,
    schema: schema([
      samplesField({ sample: '{sample}', group: '0', short_reads_1: '{r1}', short_reads_2: '{r2}', long_reads: '' }),
      { key: 'kraken2_db', type: 'folder', label: 'Banco Kraken2', required: true, default: '/refs/kraken2/standard' },
      { key: 'min_contig_size', type: 'number', label: 'Tamanho mínimo de contig (pb)', default: 1500 },
      { key: 'host_removal', type: 'boolean', label: 'Remover reads do hospedeiro', default: true },
      outdirField('metagenomica'),
    ]),
  },
  {
    id: 'farmacogenetico', name: 'Farmacogenético', category: 'Farmacogenômica',
    description: 'Haplótipos e fenótipos metabolizadores para genes de resposta a fármacos.',
    pipeline: 'lab/pgx', revision: '1.1.0', profile: 'docker', minutes: 40, slots: 6, enabled: true, stub: false,
    schema: schema([
      samplesField(),
      { key: 'genes', type: 'text', label: 'Genes', required: true, default: 'CYP2D6,CYP2C19,CYP2C9,VKORC1,SLCO1B1', help: 'Separados por vírgula.' },
      { key: 'call_cnv', type: 'boolean', label: 'Detectar CNV em CYP2D6', default: true },
      outdirField('farmacogenetico'),
    ]),
  },
  {
    id: 'wes', name: 'Exoma (WES)', category: 'Genômica',
    description: 'Alinhamento, chamada e anotação de variantes germinativas em exoma.',
    pipeline: 'nf-core/sarek', revision: '3.4.2', profile: 'docker', minutes: 120, slots: 2, enabled: true, stub: false,
    schema: schema([
      samplesField({ patient: '{sample}', sample: '{sample}', lane: '{lane}', fastq_1: '{r1}', fastq_2: '{r2}' }),
      { key: 'intervals', type: 'file', label: 'Arquivo de regiões alvo (BED)', required: true, default: '/refs/exoma/twist_v2.bed' },
      { key: 'min_depth', type: 'number', label: 'Profundidade mínima', default: 20 },
      outdirField('wes'),
      { key: 'joint_germline', type: 'boolean', label: 'Genotipagem conjunta', default: false },
    ]),
  },
];

export const DEFAULT_BRAND = { name: 'Lab Genômica', logo: '', accent: DEFAULT_ACCENT };

export const DEFAULT_CONNECTIONS = {
  nextflowPath: 'nextflow',
  javaHome: '',
  workDir: '',
  maxConcurrent: 1,
  seqeraApi: 'https://api.cloud.seqera.io',
  seqeraWorkspaceId: '',
  seqeraToken: '',
  bsPath: 'bs',
  bsCheck: null,
};
