#!/usr/bin/env nextflow
// Pipeline mínima para testar a plataforma de ponta a ponta com o modo stub.
// Não precisa de Docker nem de dados reais: lê o samplesheet e cria um arquivo por amostra.

params.input = null
params.outdir = 'resultados'

process FAKE_ANALYSIS {
    publishDir params.outdir, mode: 'copy'

    input:
    val sample

    output:
    path "${sample}.txt"

    script:
    """
    echo "analise real de ${sample}" > ${sample}.txt
    """

    stub:
    """
    echo "stub de ${sample}" > ${sample}.txt
    """
}

workflow {
    if (!params.input) error "Informe --input com o samplesheet."
    channel.fromPath(params.input)
        | splitCsv(header: true)
        | map { row -> row.sample }
        | unique
        | FAKE_ANALYSIS
}
