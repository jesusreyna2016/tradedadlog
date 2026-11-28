// Helper generico de lectura/escritura via GitHub Contents API, parametrizado
// por owner/repo/branch (a diferencia de _sa-bus.mjs, que esta fijo al repo
// session-analyst-bus). Usado por funciones que escriben de vuelta a ESTE
// mismo repo (tradedadlog), por ejemplo x-growth-mark-posted.mjs.
//
// Requiere un fine-grained PAT con Contents RW solo sobre el repo destino.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// ---- Modo lote: varias escrituras al mismo repo/rama en UN solo commit ----
// ghBatchStart() abre el lote; mientras esta abierto, ghPut a ese repo/rama no hace commit:
// guarda el contenido, y ghGet devuelve lo ya escrito en el lote (asi un modulo lee lo que
// otro escribio antes en la misma pasada). ghBatchCommit() sube todo con la Git Data API
// (un arbol, un commit) y reintenta si la rama avanzo. Usado por tos-bus-cron: antes cada
// pasada de 15 min eran ~7 commits en trader-os-bus (unos 650 al dia).
let BATCH = null;
const inBatch = (owner, repo, branch) => BATCH && BATCH.owner === owner && BATCH.repo === repo && BATCH.branch === branch;

export function ghBatchStart(owner, repo, branch) {
  BATCH = { owner, repo, branch, files: new Map(), labels: [], token: null };
}

export function ghBatchAbort() { BATCH = null; }

async function ghApi(method, url, token, body) {
  const r = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'tradedadlog-gh-bus'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  return { ok: r.ok, status: r.status, j, text };
}

// Sube el lote en un commit. Devuelve { skipped } si no hubo cambios.
export async function ghBatchCommit({ message, token } = {}) {
  const b = BATCH;
  BATCH = null;
  if (!b || !b.files.size) return { skipped: true, files: 0 };
  const tok = token || b.token;
  if (!tok) throw new Error('ghBatchCommit: falta el token');
  const base = `/repos/${b.owner}/${b.repo}`;
  const msg = message || `batch: ${b.labels.join(' · ')}`.slice(0, 300);
  const tree = [...b.files].map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }));
  let last = '';
  for (let i = 0; i < 4; i++) {
    const ref = await ghApi('GET', `${base}/git/ref/heads/${b.branch}`, tok);
    if (!ref.ok) throw new Error(`ghBatchCommit ref: ${ref.status} ${ref.text}`);
    const head = ref.j.object.sha;
    const cm = await ghApi('GET', `${base}/git/commits/${head}`, tok);
    if (!cm.ok) throw new Error(`ghBatchCommit commit: ${cm.status}`);
    const t = await ghApi('POST', `${base}/git/trees`, tok, { base_tree: cm.j.tree.sha, tree });
    if (!t.ok) throw new Error(`ghBatchCommit tree: ${t.status} ${t.text}`);
    if (t.j.sha === cm.j.tree.sha) return { skipped: true, files: tree.length };
    const c = await ghApi('POST', `${base}/git/commits`, tok, { message: msg, tree: t.j.sha, parents: [head] });
    if (!c.ok) throw new Error(`ghBatchCommit new commit: ${c.status} ${c.text}`);
    const u = await ghApi('PATCH', `${base}/git/refs/heads/${b.branch}`, tok, { sha: c.j.sha, force: false });
    if (u.ok) return { skipped: false, files: tree.length, commit: c.j.sha, paths: [...b.files.keys()] };
    last = `${u.status} ${u.text}`;
    if (u.status !== 422 && u.status !== 409) break;          // otro error: no reintentar
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));  // la rama avanzo: reintentar sobre la nueva
  }
  throw new Error(`ghBatchCommit: no se pudo mover la rama (${last})`);
}

// Lee un archivo. Devuelve { content, sha } o null si no existe.
export async function ghGet(owner, repo, branch, path, { token } = {}) {
  if (inBatch(owner, repo, branch) && BATCH.files.has(path)) return { content: BATCH.files.get(path), sha: 'batched' };
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'tradedadlog-gh-bus'
    }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`ghGet ${path}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { content: unb64(j.content || ''), sha: j.sha };
}

// Escribe (crea o actualiza) un archivo. Si el contenido es identico, no hace
// commit y devuelve { skipped: true }. `known` (opcional) evita un GET extra.
export async function ghPut(owner, repo, branch, path, contentString, message, { token, known } = {}) {
  if (!token) throw new Error('ghPut: falta el token');
  if (inBatch(owner, repo, branch)) {
    BATCH.token = BATCH.token || token;
    let cur = BATCH.files.has(path) ? { content: BATCH.files.get(path) } : known;
    if (cur === undefined) { try { cur = await ghGet(owner, repo, branch, path, { token }); } catch { cur = null; } }
    if (cur && cur.content === contentString) return { skipped: true, path };
    BATCH.files.set(path, contentString);
    if (message) BATCH.labels.push(String(message).replace(/^tos: /, ''));
    return { skipped: false, path, batched: true };
  }
  let sha = null;
  try {
    const cur = (known !== undefined) ? known : await ghGet(owner, repo, branch, path, { token });
    if (cur) {
      if (cur.content === contentString) return { skipped: true, path };
      sha = cur.sha;
    }
  } catch (e) { /* si falla el GET, intentamos crear igual */ }

  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'tradedadlog-gh-bus'
    },
    body: JSON.stringify({
      message: message || `update ${path}`,
      content: b64(contentString),
      branch,
      ...(sha ? { sha } : {})
    })
  });
  if (!r.ok) throw new Error(`ghPut ${path}: ${r.status} ${await r.text()}`);
  return { skipped: false, path, commit: (await r.json()).commit?.sha || null };
}
