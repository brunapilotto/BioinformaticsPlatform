import { isAbsolute } from 'node:path';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function mergeBrand(current, patch) {
  const next = { ...current };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string') throw new Error('Nome da empresa inválido.');
    next.name = patch.name.slice(0, 120);
  }
  if (patch.accent !== undefined) {
    if (!HEX_RE.test(patch.accent)) throw new Error('Cor de destaque deve estar no formato #rrggbb.');
    next.accent = patch.accent;
  }
  if (patch.logo !== undefined) {
    if (patch.logo !== '') {
      if (typeof patch.logo !== 'string' || !LOGO_RE.test(patch.logo)) throw new Error('A logo precisa ser uma imagem PNG, JPEG, GIF, WEBP ou SVG.');
      const base64 = patch.logo.slice(patch.logo.indexOf(',') + 1);
      if (Buffer.byteLength(base64, 'base64') > MAX_LOGO_BYTES) throw new Error('A logo pode ter no máximo 2 MB.');
    }
    next.logo = patch.logo;
  }
  return next;
}

const asText = (v, label) => {
  if (typeof v !== 'string') throw new Error(`${label} inválido.`);
  return v.trim();
};

export function mergeConnections(current, patch) {
  const next = { ...current };
  if (patch.nextflowPath !== undefined) {
    next.nextflowPath = asText(patch.nextflowPath, 'Caminho do Nextflow') || 'nextflow';
  }
  if (patch.javaHome !== undefined) {
    next.javaHome = asText(patch.javaHome, 'JAVA_HOME');
    if (next.javaHome && !isAbsolute(next.javaHome)) throw new Error('JAVA_HOME precisa ser um caminho absoluto.');
  }
  if (patch.workDir !== undefined) {
    next.workDir = asText(patch.workDir, 'Pasta de trabalho');
    if (next.workDir && !isAbsolute(next.workDir)) throw new Error('A pasta de trabalho precisa ser um caminho absoluto.');
  }
  if (patch.maxConcurrent !== undefined) {
    const n = Number(patch.maxConcurrent);
    if (!Number.isInteger(n) || n < 1) throw new Error('O limite de execuções simultâneas deve ser um inteiro maior que zero.');
    next.maxConcurrent = n;
  }
  if (patch.seqeraApi !== undefined) {
    const url = asText(patch.seqeraApi, 'URL da API da Seqera');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('A URL da API da Seqera deve começar com http:// ou https://.');
    next.seqeraApi = url.replace(/\/+$/, '');
  }
  if (patch.seqeraWorkspaceId !== undefined) {
    next.seqeraWorkspaceId = asText(patch.seqeraWorkspaceId, 'ID do workspace');
    if (next.seqeraWorkspaceId && !/^\d+$/.test(next.seqeraWorkspaceId)) throw new Error('O ID do workspace da Seqera é numérico.');
  }
  // Campo vazio mantém o token salvo: o valor nunca volta para o navegador, então o campo sempre chega vazio.
  if (typeof patch.seqeraToken === 'string' && patch.seqeraToken.trim()) next.seqeraToken = patch.seqeraToken.trim();
  if (patch.clearSeqeraToken === true) next.seqeraToken = '';
  if (patch.bsPath !== undefined) {
    const path = asText(patch.bsPath, 'Caminho da CLI bs') || 'bs';
    if (path !== next.bsPath) next.bsCheck = null;
    next.bsPath = path;
  }
  return next;
}

export function publicConnections(conn) {
  const { seqeraToken, ...rest } = conn;
  return { ...rest, hasSeqeraToken: !!seqeraToken };
}
