# Plataforma de Pipelines

Plataforma white label para disparar pipelines Nextflow de bioinformática na máquina local. O usuário escolhe uma análise, seleciona a pasta ou o projeto do BaseSpace, confirma as amostras identificadas e acompanha a execução pelo link da Seqera.

## Requisitos

| Item | Para quê | Obrigatório |
|---|---|---|
| Node.js 24 ou superior | Rodar a plataforma (sem outras dependências) | Sim |
| Nextflow e Java compatível | Executar as pipelines | Sim |
| Token da Seqera | Gerar o link de acompanhamento | Para ter o link |
| CLI `bs`, autenticada com `bs auth` | Usar projetos do BaseSpace | Para usar BaseSpace |
| Docker ou similar | Pipelines com perfil de contêiner | Conforme a pipeline |

## Como iniciar

```sh
npm start
```

Abra <http://127.0.0.1:4173>. Para usar outra porta: `PORT=8080 npm start`. Para guardar os dados em outro lugar: `PLATAFORMA_DATA=/caminho npm start`.

A plataforma só aceita acessos desta máquina e não tem login, então qualquer pessoa usando o computador consegue abrir o Admin.

## Primeira configuração (Admin)

1. **Identidade visual:** nome da empresa, logo e cor de destaque.
2. **Conexões › Execução local:** caminho do Nextflow e `JAVA_HOME`, se necessário. Use **Testar Nextflow** para conferir.
3. **Conexões › Seqera Platform:** token, URL da API e ID do workspace (opcional). Use **Testar conexão** para conferir.
4. **Conexões › Illumina BaseSpace:** caminho da CLI e **Verificar funcionamento**, que roda `bs whoami`. Sem esse check, a busca no BaseSpace fica bloqueada na tela de disparo.
5. **Análises:** revise as análises de exemplo e cadastre as suas. Os exemplos `lab/*` não existem de verdade e devem ser trocados ou excluídos.

## Schema das análises

Cada análise tem um schema JSON que vira os campos do formulário de disparo:

```json
{
  "fields": [
    {
      "key": "input",
      "type": "samples",
      "label": "Amostras",
      "sources": ["local", "basespace"],
      "pattern": "*_R{1,2}_001.fastq.gz",
      "paired": true,
      "sheet": { "columns": { "sample": "{sample}", "fastq_1": "{r1}", "fastq_2": "{r2}" } }
    },
    { "key": "data_type", "type": "select", "label": "Tipo de dado", "required": true, "options": ["WES", "WGS"], "default": "WES" },
    { "key": "outdir", "type": "folder", "label": "Pasta de resultados", "required": true, "default": "/data/resultados/{analysis}/{date}" }
  ]
}
```

**Tipos:** `samples`, `folder`, `file`, `select`, `genome`, `text`, `number`, `boolean`.

**Propriedades:** `key`, `type`, `label`, `help`, `required`, `default`, `options`, `placeholder`. Em `default`, `{date}` vira a data do disparo e `{analysis}` vira o identificador da análise.

**Campo `samples`** (exatamente um por schema):

| Propriedade | Efeito | Padrão |
|---|---|---|
| `sources` | Origens aceitas: `local`, `basespace` | As duas |
| `pattern` | Filtro pelo nome do arquivo; aceita `*`, `?` e `{a,b}` | Qualquer FASTQ |
| `paired` | Com `false`, aceita amostras single-end | `true` |
| `sheet.columns` | Colunas do samplesheet; aceita `{sample}`, `{lane}`, `{r1}`, `{r2}` e texto fixo | `sample,fastq_1,fastq_2` |

O samplesheet gerado tem uma linha por lane e é passado à pipeline no parâmetro com a `key` desse campo. Se a pipeline espera `--samplesheet` em vez de `--input`, troque a `key` para `samplesheet`. No editor, o botão **Samplesheet** em "Adicionar campo" inclui `sheet.columns` no campo de amostras, ou cria o campo se ele não existir.

**Campo `outdir`:** essa `key` identifica a pasta de resultados. A plataforma cria a pasta no disparo, e no modo "uma por vez" cada amostra usa uma subpasta.

## Como a execução funciona

Cada disparo gera um ou mais jobs, guardados em uma fila no SQLite. Cada job executa:

```sh
nextflow run <pipeline> [-r <revisão>] [-profile <perfil>] [-stub] \
  -name <nome único> -work-dir work -params-file params.json [-resume] [-c seqera.config]
```

| Modo | Execuções | Links | Estimativa |
|---|---|---|---|
| Uma amostra por vez | 1 por amostra, em ordem | 1 por amostra | `tempo × amostras` |
| Todas ao mesmo tempo | 1 com todas as amostras | 1 | `tempo × ⌈amostras ÷ paralelo⌉` |

- **Pasta `work`:** fica sempre em `work`, dentro da pasta do job, mesmo que `NXF_WORK` esteja definido no ambiente.
- **Limite global:** "Execuções simultâneas" em Conexões controla quantos Nextflow rodam juntos. O padrão é 1, e os demais disparos aguardam na fila.
- **Falhas:** no modo "uma por vez", a falha de uma amostra não interrompe as seguintes.
- **Reinício da plataforma:** a fila continua e o Nextflow em andamento segue rodando. Se ele terminar com a plataforma desligada, o job fica como "Interrompida", porque o código de saída se perde. Confira o resultado no Seqera ou nos logs.
- **Arquivos de cada job:** `data/runs/<execução>/<job>/` (ou a pasta de trabalho configurada) guarda `job.json`, `samplesheet.csv`, `params.json`, `nextflow.out` e a pasta `work` do Nextflow.
- **BaseSpace:** só as amostras selecionadas são baixadas, para `data/basespace/<projeto>/`. Arquivos já baixados com o tamanho certo são reaproveitados. Essas pastas não são limpas automaticamente.

## Histórico e informações da execução

O **Histórico** lista os disparos e seus status:

| Status | Cor |
|---|---|
| Sucesso | Verde |
| Em execução, Baixando do BaseSpace | Laranja |
| Na fila | Azul |
| Falhou | Vermelho |
| Interrompida | Amarelo |
| Cancelada | Cinza |

**Informações** abre tudo sobre a execução: tempo estimado, parâmetros, origem, amostras e, para cada execução do Nextflow, o link da Seqera, o comando, a pasta `work` e a pasta do job. O comando não inclui o token.

Com mais de 3 execuções, os detalhes de cada uma ficam recolhidos, exceto as que falharam ou foram interrompidas.

**Retomar (-resume)** aparece em cada execução que falhou, foi interrompida ou cancelada. No modo "uma por vez", cada amostra tem o próprio botão. Uma amostra cancelada enquanto ainda estava na fila não tem cache e roda do início. A retomada roda na mesma pasta do job, o que permite ao Nextflow reaproveitar as etapas prontas de `work`. Ela usa um novo `-name`, gera um novo link da Seqera e aplica as configurações atuais de Conexões. O link, o comando e o erro de cada tentativa anterior continuam disponíveis, e os logs ficam em `nextflow.tentativa-<n>.out`.

Para repetir um comando manualmente, rode-o na pasta do job. Como o `seqera.config` é apagado ao fim de cada job, recrie esse arquivo ou remova o `-c`.

**Excluir** tira a execução do histórico e dos "Recentes", sem apagar resultados, logs ou a pasta `work`. Essa exclusão não pode ser desfeita. Execuções em andamento precisam ser canceladas antes.

## O que os números significam

- **Tempo estimado:** vem do valor definido no Admin, não de uma medição. Não inclui download do BaseSpace nem espera na fila.
- **Amostras em paralelo:** afeta só a estimativa. A concorrência real de um `nextflow run` depende da configuração de cada pipeline.

## Segurança e dados

- Tudo fica em `data/`, com acesso restrito ao usuário do sistema. Inclua essa pasta no seu backup.
- **O token da Seqera é guardado sem criptografia no banco**, protegido só pela permissão da pasta. Ele nunca é enviado ao navegador. Durante a execução, fica em um `seqera.config` com permissão `0600`, apagado quando o job termina.
- A plataforma não guarda credenciais do BaseSpace: quem autentica é a CLI `bs`.

## Testes

```sh
npm test
```

Os testes usam versões simuladas do `nextflow` e do `bs`, então não precisam de instalação nem de credenciais.

Para testar com o Nextflow real sem Docker, cadastre uma análise com a pipeline `examples/stub-pipeline`, **Modo stub** ligado e perfil vazio.

## Licença

O código deste projeto é distribuído sob a [licença Apache 2.0](LICENSE). React e Phosphor Icons, em `vendor/`, mantêm a licença MIT de cada um, com os textos na mesma pasta. `support.js` e `_ds/` foram gerados no Claude Design e não estão cobertos por essa licença.
