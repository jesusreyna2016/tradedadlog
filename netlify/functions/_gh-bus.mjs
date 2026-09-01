// Helper generico de lectura/escritura via GitHub Contents API, parametrizado
// por owner/repo/branch (a diferencia de _sa-bus.mjs, que esta fijo al repo
// session-analyst-bus). Usado por funciones que escriben de vuelta a ESTE
// mismo repo (tradedadlog), por ejemplo x-growth-mark-posted.mjs.
//
// Requiere un fine-grained PAT con Contents RW solo sobre el repo destino.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// Lee un archivo. Devuelve { content, sha } o null si no existe.
export async function ghGet(owner, repo, branch, path, { token } = {}) {
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
