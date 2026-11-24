// Trader OS · captura manual de trades desde La Mesa. La razon y la emocion de cada
// entrada (lo que la API de MFP NO ve) es el sustrato de la review del Coach.
//
// POST  /api/tos-capture   body JSON { acct, openedAt, date, sym, side, entry, pnl,
//        reason, emotion, shot? (data URL base64) }
//        -> anexa una linea a trader-os-bus:trader/manual/<date>.jsonl (dedup por key)
//        -> si hay captura de imagen, la guarda en Netlify Blobs (no infla el git)
// GET   /api/tos-capture?shot=<date>:<openedAt>  -> devuelve la imagen guardada
//
// Seguridad (herramienta personal, bajo riesgo): solo acepta POST desde tradedadlog.com
// (o localhost) y exige que el trade exista de verdad en live/trader.json (tether), para
// que nadie pueda inyectar capturas sueltas. Sin secreto en la pagina publica.
import { ghGet, ghPut } from './_gh-bus.mjs';
import { getStore } from '@netlify/blobs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';
const MAX_SHOT = 700 * 1024;   // ~700KB de imagen ya reducida

const okOrigin = (req) => {
  const o = (req.headers.get('origin') || req.headers.get('referer') || '').toLowerCase();
  return /tradedadlog\.com/.test(o) || /localhost|127\.0\.0\.1/.test(o);
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return json({ ok: false, error: 'falta TOS_BUS_TOKEN' }, 500);

  // GET: servir una captura de imagen
  if (req.method === 'GET') {
    const shot = new URL(req.url).searchParams.get('shot');
    if (!shot || !/^[\w:-]{3,64}$/.test(shot)) return json({ ok: false, error: 'shot invalido' }, 400);
    try {
      const store = getStore('tos-shots');
      const buf = await store.get('shot:' + shot, { type: 'arrayBuffer' });
      if (!buf) return json({ ok: false, error: 'no existe' }, 404);
      return new Response(buf, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
    } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'metodo' }, 405);
  if (!okOrigin(req)) return json({ ok: false, error: 'origen no permitido' }, 403);

  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: 'body invalido' }, 400); }
  const date = String(b.date || '').slice(0, 10);
  const openedAt = +b.openedAt;
  const reason = String(b.reason || '').slice(0, 1200).trim();
  const emotion = String(b.emotion || '').slice(0, 40).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !openedAt) return json({ ok: false, error: 'date/openedAt' }, 400);
  if (!reason && !emotion) return json({ ok: false, error: 'falta razon o emocion' }, 400);

  // tether: el trade debe existir en el trader.json del dia (nadie inyecta capturas sueltas)
  let traderCur = null, tr = {};
  try { traderCur = await ghGet(OWNER, REPO, BRANCH, 'live/trader.json', { token }); tr = traderCur?.content ? JSON.parse(traderCur.content) : {}; } catch { tr = {}; }
  const all = [...(tr.todayTrades || []), ...(tr.openPositions || [])];
  const match = all.find((t) => +t.openedAt === openedAt);
  if (!match) return json({ ok: false, error: 'trade no encontrado hoy' }, 404);
  const acct = b.acct || match.acct || '';
  const key = (acct ? acct + ':' : '') + openedAt;

  // imagen opcional -> Netlify Blobs
  let shotRef = null;
  if (typeof b.shot === 'string' && b.shot.startsWith('data:image/')) {
    try {
      const base64 = b.shot.slice(b.shot.indexOf(',') + 1);
      const buf = Buffer.from(base64, 'base64');
      if (buf.length > MAX_SHOT) return json({ ok: false, error: 'imagen muy grande' }, 413);
      const store = getStore('tos-shots');
      const skey = date + ':' + openedAt;
      await store.set('shot:' + skey, new Blob([buf], { type: 'image/jpeg' }));
      shotRef = skey;
    } catch (e) { /* la imagen es best-effort; sigue con el texto */ }
  }

  // checklist de entrada (la regla entryOnlyIf: nivel + sesgo + gatillo). true/false/null.
  const tri = (v) => (v === true || v === false ? v : null);
  const checklist = { atLevel: tri(b.atLevel), withBias: tri(b.withBias), hadTrigger: tri(b.hadTrigger) };
  const wasOpen = (tr.openPositions || []).some((o) => +o.openedAt === openedAt);

  const cap = {
    key, date, sym: match.sym || b.sym || null, side: match.side || b.side || null,
    entry: match.entry ?? b.entry ?? null, pnl: match.pnl ?? b.pnl ?? null,
    openedAt, reason, emotion: emotion || null, checklist, atEntry: wasOpen, shot: shotRef,
    at: new Date().toISOString(), src: 'la-mesa'
  };

  // anexar a trader/manual/<date>.jsonl, dedup por key (recapturar reemplaza)
  const path = `trader/manual/${date}.jsonl`;
  const cur = await ghGet(OWNER, REPO, BRANCH, path, { token });
  const lines = [];
  if (cur?.content) for (const ln of cur.content.split('\n')) { const s = ln.trim(); if (!s) continue; try { const o = JSON.parse(s); if (o.key !== key) lines.push(s); } catch { lines.push(s); } }
  lines.push(JSON.stringify(cap));
  await ghPut(OWNER, REPO, BRANCH, path, lines.join('\n') + '\n', `tos: captura ${cap.sym || ''} ${date}`, { token, known: cur });

  return json({ ok: true, key, shot: shotRef });
};
