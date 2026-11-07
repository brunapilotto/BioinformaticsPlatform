import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { whoami } from './basespace.js';

const exec = promisify(execFile);

export async function testNextflow(conn) {
  const env = { ...process.env, NXF_ANSI_LOG: 'false' };
  if (conn.javaHome) env.JAVA_HOME = conn.javaHome;
  try {
    const { stdout } = await exec(conn.nextflowPath, ['-version'], { env, timeout: 120_000 });
    // Ancorado no início da linha: avisos do Java também trazem a palavra "version".
    const version = /^\s*(?:nextflow\s+)?version\s+([\w.-]+)/im.exec(stdout)?.[1];
    if (!version) throw new Error(`Resposta inesperada do Nextflow: ${stdout.trim().slice(0, 200)}`);
    return { ok: true, text: `Nextflow ${version}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, text: `Nextflow não encontrado (${conn.nextflowPath}).` };
    const detail = String(err.stderr || err.stdout || err.message).trim().split('\n').slice(-3).join(' ');
    return { ok: false, text: detail.slice(0, 500) };
  }
}

export async function testSeqera(conn) {
  if (!conn.seqeraToken) return { ok: false, text: 'Informe o token de acesso.' };
  try {
    const res = await fetch(`${conn.seqeraApi}/user-info`, {
      headers: { Authorization: `Bearer ${conn.seqeraToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, text: 'Token recusado pelo Seqera.' };
    if (!res.ok) return { ok: false, text: `O Seqera respondeu com erro ${res.status}.` };
    const data = await res.json();
    const user = data?.user?.userName || data?.user?.email;
    return { ok: true, text: user ? `Conectado como ${user}` : 'Conectado' };
  } catch (err) {
    return { ok: false, text: `Não foi possível conectar a ${conn.seqeraApi}: ${err.cause?.message || err.message}` };
  }
}

export async function testBaseSpace(conn) {
  const at = Date.now();
  try {
    const { account, host } = await whoami(conn.bsPath);
    return { ok: true, account, host, at, text: `Funcionando · ${account}` };
  } catch (err) {
    return { ok: false, at, text: err.message };
  }
}
