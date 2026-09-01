// Recibe la senal "ya publique este borrador" desde el boton del dashboard
// (x-growth.html) y la agrega a x-growth-reports/live/marked-posted.json en
// este mismo repo, para que el proximo ciclo del X Growth Agent (interactive
// o cloud) haga el chequeo de adopcion sin que Jesus/Claude tengan que cruzar
// datos a mano en X.
//
// Sin clave de por medio a proposito: lo unico que este endpoint puede hacer
// es anexar una linea a un log de "creo que publique esto" (nunca sobreescribe,
// nunca borra, no toca dinero ni cuentas), asi que el peor abuso posible es
// spam de lineas basura, facil de ignorar al leer el archivo. La escritura al
// repo usa X_BUS_TOKEN (PAT fine-grained, Contents RW, SOLO sobre
// jesusreyna2016/tradedadlog) via la Contents API — ESE si es secreto real.
import { ghGet, ghPut } from './_gh-bus.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'tradedadlog';
const BRANCH = 'main';
const PATH = 'x-growth-reports/live/marked-posted.json';

const cors = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'origin'
});

export default async (req) => {
  const origin = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors(origin) });

  let b;
  try { b = JSON.parse(await req.text()); }
  catch (e) { return new Response('bad JSON', { status: 400, headers: cors(origin) }); }

  const cycle = (b && b.cycle) ?? null;
  const draftFormat = (b && b.draftFormat) ?? null;
  const draftText = (b && typeof b.draftText === 'string') ? b.draftText.slice(0, 600) : null;
  const url = b && b.url;
  if (!url || typeof url !== 'string' || !/^https:\/\/x\.com\//.test(url)) {
    return new Response('bad body (need a real x.com post url)', { status: 400, headers: cors(origin) });
  }

  const token = process.env.X_BUS_TOKEN;
  if (!token) return new Response('X_BUS_TOKEN missing', { status: 503, headers: cors(origin) });

  try {
    const cur = await ghGet(OWNER, REPO, BRANCH, PATH, { token });
    let list = [];
    if (cur) { try { list = JSON.parse(cur.content); if (!Array.isArray(list)) list = []; } catch (e) { list = []; } }
    list.push({ markedAt: new Date().toISOString(), cycle, draftFormat, draftText, url });

    const body = JSON.stringify(list, null, 2) + '\n';
    const r = await ghPut(OWNER, REPO, BRANCH, PATH, body, `x-growth: mark draft posted (${url})`, { token, known: cur });
    return new Response(JSON.stringify({ ok: true, ...r }), {
      status: 200, headers: { ...cors(origin), 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 502, headers: { ...cors(origin), 'content-type': 'application/json' }
    });
  }
};
