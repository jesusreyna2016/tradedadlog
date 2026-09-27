// Helper del bus GitHub para el agente de aprendizaje de Scalp CC.
// Mismo motivo que _sa-bus.mjs: el entorno cloud de las rutinas NO puede salir a
// tradedadlog.com, pero SI puede clonar repos de GitHub. El canal de datos es un
// repo publico:
//
//   jesusreyna2016/scalp-cc-bus
//     agent-instructions.md        · metodo del agente (lo mantiene el equipo)
//     signals/<fecha>.jsonl        · señales al disparo (lo escribe Netlify, este helper)
//     outcomes/<fecha>.jsonl       · resoluciones TP/SL/timeout (Netlify)
//     playbook/*.md                · conocimiento vivo por tipo de señal (lo escribe la rutina)
//     state.json                   · contadores + parametros recomendados (la rutina)
//     reviews/<fecha>.md           · revision semanal (la rutina)
//
// Requiere env var SCALP_BUS_TOKEN (PAT fine-grained, solo este repo, Contents RW).

import { createHash } from 'node:crypto';

export const BUS_OWNER = 'jesusreyna2016';
export const BUS_REPO = 'scalp-cc-bus';
export const BUS_BRANCH = 'main';

const API = `https://api.github.com/repos/${BUS_OWNER}/${BUS_REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${BUS_OWNER}/${BUS_REPO}/${BUS_BRANCH}`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
// git blob sha of a string, same value the contents API returns as `sha`
const blobSha = (s) => {
  const buf = Buffer.from(s, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

export async function busGet(path, { token } = {}) {
  if (token) {
    const r = await fetch(`${API}/${path}?ref=${BUS_BRANCH}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'tradedadlog-scalp-bus',
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`busGet ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    // Files over 1MB come back with encoding "none" and empty content. Re-fetch them
    // with the raw media type, otherwise callers see an empty file (blind merges and
    // no-op commits on every run).
    if (j.encoding === 'none' || (!j.content && j.size > 0)) {
      const rr = await fetch(`${API}/${path}?ref=${BUS_BRANCH}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github.raw+json',
          'user-agent': 'tradedadlog-scalp-bus',
        },
      });
      if (!rr.ok) throw new Error(`busGet raw ${path}: ${rr.status}`);
      return { content: await rr.text(), sha: j.sha };
    }
    return { content: unb64(j.content || ''), sha: j.sha };
  }
  const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tradedadlog-scalp-bus' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`busGet raw ${path}: ${r.status}`);
  return { content: await r.text(), sha: null };
}

export async function busPut(path, contentString, message, { token, known } = {}) {
  if (!token) throw new Error('busPut: falta SCALP_BUS_TOKEN');
  let sha = null;
  try {
    const cur = known !== undefined ? known : await busGet(path, { token });
    if (cur) {
      if (cur.content === contentString) return { skipped: true, path };
      if (cur.sha && cur.sha === blobSha(contentString)) return { skipped: true, path };
      sha = cur.sha;
    }
  } catch (e) { /* si falla el GET, intentamos crear igual */ }

  const r = await fetch(`${API}/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'tradedadlog-scalp-bus',
    },
    body: JSON.stringify({
      message: message || `scalp-bus: update ${path}`,
      content: b64(contentString),
      branch: BUS_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) throw new Error(`busPut ${path}: ${r.status} ${await r.text()}`);
  return { skipped: false, path, commit: (await r.json()).commit?.sha || null };
}

export { RAW as BUS_RAW_BASE };
