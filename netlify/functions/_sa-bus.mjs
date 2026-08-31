// Helper del bus GitHub para el Session Analyst.
// El entorno cloud de las rutinas NO puede salir a tradedadlog.com (egress
// bloqueado por politica de organizacion), pero SI puede clonar repos de
// GitHub. Asi que el canal de datos es un repo publico:
//
//   jesusreyna2016/session-analyst-bus
//     method/instructions.md      · metodo del agente (lo mantiene el equipo)
//     state/sa-state.json         · estado/aprendizaje acumulado (lo escribe la rutina)
//     live/market.json            · feed de mercado + noticias (lo escribe Netlify, este helper)
//     snapshots/<fecha>/<HH>.json · copia horaria de market.json para replay (Netlify, 1/hora)
//     plans/latest.json           · ultimo plan (lo escribe la rutina)
//     plans/<fecha>-<sesion>.json · historico de planes
//     reviews/<fecha>.md          · calificacion del dia (pre-asia)
//
// Netlify (con egress abierto) escribe live/market.json cada pocos minutos por
// la Contents API. La rutina clona el repo, lee live/ + method/ + state/, y
// escribe de vuelta plans/ + state/ + reviews/.
//
// Requiere env var SA_BUS_TOKEN (PAT fine-grained, solo este repo, Contents RW).

export const BUS_OWNER = 'jesusreyna2016';
export const BUS_REPO = 'session-analyst-bus';
export const BUS_BRANCH = 'main';

const API = `https://api.github.com/repos/${BUS_OWNER}/${BUS_REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${BUS_OWNER}/${BUS_REPO}/${BUS_BRANCH}`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// Lee un archivo del bus. Devuelve { content, sha } o null si no existe.
// Usa la Contents API si hay token (trae el sha, necesario para escribir),
// si no cae a raw.githubusercontent.com (solo lectura).
export async function busGet(path, { token } = {}) {
  if (token) {
    const r = await fetch(`${API}/${path}?ref=${BUS_BRANCH}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'tradedadlog-sa-bus'
      }
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`busGet ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return { content: unb64(j.content || ''), sha: j.sha };
  }
  const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tradedadlog-sa-bus' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`busGet raw ${path}: ${r.status}`);
  return { content: await r.text(), sha: null };
}

// Escribe (crea o actualiza) un archivo en el bus. Si el contenido es identico
// al que ya hay, no hace commit y devuelve { skipped: true }.
// `known` (opcional) = { content, sha } ya leido por quien llama, para evitar un
// busGet extra. Pasar `known: null` fuerza a NO leer (se asume que no existe).
export async function busPut(path, contentString, message, { token, known } = {}) {
  if (!token) throw new Error('busPut: falta SA_BUS_TOKEN');
  let sha = null;
  try {
    const cur = (known !== undefined) ? known : await busGet(path, { token });
    if (cur) {
      if (cur.content === contentString) return { skipped: true, path };
      sha = cur.sha;
    }
  } catch (e) { /* si falla el GET, intentamos crear igual */ }

  const r = await fetch(`${API}/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'tradedadlog-sa-bus'
    },
    body: JSON.stringify({
      message: message || `sa-bus: update ${path}`,
      content: b64(contentString),
      branch: BUS_BRANCH,
      ...(sha ? { sha } : {})
    })
  });
  if (!r.ok) throw new Error(`busPut ${path}: ${r.status} ${await r.text()}`);
  return { skipped: false, path, commit: (await r.json()).commit?.sha || null };
}

export { RAW as BUS_RAW_BASE };
