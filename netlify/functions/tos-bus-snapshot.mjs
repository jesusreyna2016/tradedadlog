// Trader OS · snapshot cron. Espeja el store de Netlify Blobs 'tos' (lo que
// escribe tos-ingest.mjs) al repo git jesusreyna2016/trader-os-bus:
//
//   state:<src>:<SYM>   -> live/feeds.json   (mapa crudo del ultimo estado por fuente+simbolo)
//   events:<YYYY-MM-DD> -> events/<fecha>.jsonl  (log append-only de eventos semanticos Tier B)
//
// PUENTE Fase 4 / Paso 1 (opcion c): ademas espeja al bus las fuentes que el
// Session Analyst ya tiene en el store Blobs 'cc' (las rellenan sus alertas
// EXISTENTES via ind-ingest): command/regime/trendcl (ind:<src>:<SYM>) y el
// backbone orb (sym:<SYM>). Asi la lente Contexto Tier 2 tendra paridad con el
// SA sin tocar ninguna alerta de TradingView. Es aditivo y reversible: si una
// clave YA la escribe tos-ingest de forma nativa, NO se pisa (tos-ingest manda);
// el puente solo rellena lo que falta. Y escribe live/news.json (cc-news +
// cc-macro) para el pase de calendario. Cuando en el Paso 6 se corte el SA, esas
// alertas se reapuntan a tos-ingest (opcion a) y el puente deja de hacer falta.
//
// El snapshot es un ESPEJO FIEL, no compone: la lente Contexto es quien leera
// live/feeds.json + events/ + news y escribira el live/market.json del esquema.
// Aqui solo garantizamos que el dato llega al bus, merge-only (nunca encoge) y sin
// commit si no cambio (lo maneja ghPut). Procesa hoy y ayer para los eventos.
//
// Invocable por HTTP para pruebas (GET); el schedule vive en tos-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { ghGet, ghPut } from './_gh-bus.mjs';
import { TVBAR_FIELDS, mergeRows } from './_tvbars.mjs';
import newsHandler from './cc-news.mjs';
import macroHandler from './cc-macro.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';
const EVENTS_MAX = 5000;   // tope por archivo de dia

// Puente 'cc': simbolos del SA y sus fuentes. regime/trendcl viven en
// ind:<src>:<SYM>; el backbone orb en sym:<SYM>. SYM del store 'cc' es crudo
// (ETHUSDT), se normaliza a la convencion del bus (ETH) igual que tos-ingest.
// `command` NO se puentea: la alerta clasica CMDC1 esta retirada (la reemplazo
// FEED1 el ~1 nov) y su ultimo dato esta congelado 3 semanas; el veredicto
// fusionado lo forma la lente Tier 2 desde feed+orb+regime+trendcl, como el SA.
const BRIDGE_SYMS = ['NQ', 'ES', 'GC', 'YM', 'CL', 'ETHUSDT', 'BTCUSDT'];
const BRIDGE_IND_SRCS = ['regime', 'trendcl'];
const BRIDGE_ACTIVE = new Set(['orb', 'regime', 'trendcl']);   // srcs que el puente mantiene vivos
const bridgeNorm = (raw) => String(raw).toUpperCase()
  .replace(/[0-9!].*$/, '').replace(/\.?P$/, '').replace(/(USDT|USDC|USD|PERP)$/, '');

const evKey = (e) => `${e.t}|${e.src}|${e.sym}|${e.event || ''}`;

// Llama a un handler de funcion Netlify en proceso (sin red) y devuelve su JSON.
const readHandlerJson = async (handler) => {
  try { return await (await handler(new Request('https://tradedadlog.com/internal'))).json(); }
  catch (e) { return { error: String(e && e.message || e) }; }
};

function daysToProcess() {
  const now = Date.now();
  return [new Date(now - 864e5).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)];
}

function parseJsonl(content) {
  const map = new Map();
  if (!content) return map;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); map.set(evKey(e), e); } catch { /* linea corrupta */ }
  }
  return map;
}

function serializeEvents(map) {
  const rows = [...map.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export async function runSnapshot() {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta TOS_BUS_TOKEN' };

  const store = getStore('tos');
  const out = [];
  const deadline = Date.now() + 18000;

  // ---- 1. Estado crudo -> live/feeds.json (merge-only: nunca se pierde una clave) ----
  const feedsCur = await ghGet(OWNER, REPO, BRANCH, 'live/feeds.json', { token });
  let feeds = {};
  try { feeds = feedsCur?.content ? JSON.parse(feedsCur.content) : {}; } catch { feeds = {}; }

  const stateKeys = new Set(Object.keys(feeds).map((k) => `state:${k}`));
  let cursor;
  do {
    const page = await store.list({ prefix: 'state:', cursor });
    for (const b of page?.blobs || []) stateKeys.add(b.key);
    cursor = page?.cursor;
  } while (cursor && Date.now() < deadline);

  for (const key of stateKeys) {
    const rec = await store.get(key, { type: 'json' });   // get es fuertemente consistente
    if (rec) feeds[key.slice('state:'.length)] = rec;     // si get devuelve null, se conserva el valor previo
  }

  // ---- 1b. Puente (opcion c): fuentes del SA desde el store Blobs 'cc' ----
  // Rellena command/regime/trendcl (ind:<src>:<SYM>) y orb (sym:<SYM>) SOLO si la
  // clave no la provee ya tos-ingest de forma nativa (lo nativo no lleva _bridged
  // y manda). Marca lo puenteado con _bridged:'cc' para poder refrescarlo y para
  // que el Paso 6 sepa que viene del pipeline viejo.
  try {
    const cc = getStore('cc');
    for (const rawSym of BRIDGE_SYMS) {
      if (Date.now() > deadline) break;
      const sym = bridgeNorm(rawSym);
      for (const src of BRIDGE_IND_SRCS) {
        const key = `${src}:${sym}`;
        if (feeds[key] && !feeds[key]._bridged) continue;   // nativo de tos-ingest manda
        const rec = await cc.get(`ind:${src}:${rawSym}`, { type: 'json' });
        if (rec) feeds[key] = { ...rec, src, sym, receivedAt: rec.receivedAt || rec.updatedAt || null, _bridged: 'cc' };
      }
      const okey = `orb:${sym}`;
      if (!(feeds[okey] && !feeds[okey]._bridged)) {
        const orb = await cc.get(`sym:${rawSym}`, { type: 'json' });   // backbone orb_sesgo
        if (orb) feeds[okey] = { ...orb, src: 'orb', sym, receivedAt: orb.receivedAt || orb.updatedAt || null, _bridged: 'cc' };
      }
    }
    // Barrido de huerfanas: borra claves PUENTEADAS cuya src ya no mantiene el
    // puente (p.ej. command retirado). No toca claves nativas de tos-ingest.
    for (const k of Object.keys(feeds)) {
      if (k === '_updatedAt') continue;
      const rec = feeds[k];
      if (rec && rec._bridged === 'cc' && !BRIDGE_ACTIVE.has(k.slice(0, k.indexOf(':')))) delete feeds[k];
    }
  } catch (e) { out.push({ bridge: 'cc', error: String(e && e.message || e) }); }

  feeds._updatedAt = new Date().toISOString();
  if (Object.keys(feeds).length > 1) {
    out.push(await ghPut(OWNER, REPO, BRANCH, 'live/feeds.json',
      JSON.stringify(feeds, null, 2) + '\n', `tos: feeds ${feeds._updatedAt}`, { token, known: feedsCur }));
  }

  // ---- 2. Eventos semanticos -> events/<dia>.jsonl (merge-only + guard anti-borrado) ----
  for (const day of daysToProcess()) {
    const blob = await store.get(`events:${day}`, { type: 'json' });
    if (!Array.isArray(blob) || !blob.length) continue;

    const cur = await ghGet(OWNER, REPO, BRANCH, `events/${day}.jsonl`, { token });
    const map = parseJsonl(cur?.content);
    const before = map.size;
    for (const e of blob) map.set(evKey(e), e);
    if (map.size > EVENTS_MAX) {
      const rows = [...map.values()].sort((a, b) => (a.t || 0) - (b.t || 0)).slice(-EVENTS_MAX);
      map.clear();
      for (const e of rows) map.set(evKey(e), e);
    }

    // Guard: si el archivo ya existe (sha) y no ganamos filas o el contents API
    // devolvio vacio/parcial, no pisamos (mismo fallo que el heal del scalp-bus).
    const hadSha = !!(cur && cur.sha);
    const contentEmpty = !cur?.content || !cur.content.trim();
    if (hadSha && (map.size <= before || contentEmpty)) {
      out.push({ skipped: true, path: `events/${day}.jsonl`, guard: 'noshrink', before, wouldWrite: map.size });
      continue;
    }
    out.push(await ghPut(OWNER, REPO, BRANCH, `events/${day}.jsonl`, serializeEvents(map),
      `tos: events ${day} (${map.size})`, { token, known: cur }));
  }

  // ---- 2b. Velas de TradingView (FEED1) -> tvbars/<dia>.json (merge-only) ----
  // Fuente de la seccion Edgeful (edgeful/edge_stats.py). Una fila por vela de 5m
  // con el contexto del propio TDL Feed; ver _tvbars.mjs.
  try {
    for (const day of daysToProcess()) {
      if (Date.now() > deadline) break;
      const add = {};
      let c2;
      do {
        const page = await store.list({ prefix: `tvbar:${day}:`, cursor: c2 });
        for (const b of page?.blobs || []) {
          const rows = await store.get(b.key, { type: 'json' });
          if (Array.isArray(rows) && rows.length) add[b.key.slice(`tvbar:${day}:`.length)] = rows;
        }
        c2 = page?.cursor;
      } while (c2 && Date.now() < deadline);
      if (!Object.keys(add).length) continue;
      const path = `tvbars/${day}.json`;
      const cur = await ghGet(OWNER, REPO, BRANCH, path, { token });
      let prev = { symbols: {} };
      try { prev = cur?.content ? JSON.parse(cur.content) : prev; } catch { prev = { symbols: {} }; }
      if (cur?.sha && !(cur.content || '').trim()) {   // contents API vacio: no pisar
        out.push({ skipped: true, path, guard: 'empty-read' });
        continue;
      }
      const symbols = { ...(prev.symbols || {}) };
      for (const [sym, rows] of Object.entries(add)) symbols[sym] = mergeRows(symbols[sym], rows);
      const body = JSON.stringify({ source: 'tdl_feed', tf: '5', fields: TVBAR_FIELDS, symbols }) + '\n';
      out.push(await ghPut(OWNER, REPO, BRANCH, path, body, `tos: tvbars ${day}`, { token, known: cur }));
    }
  } catch (e) { out.push({ tvbars: true, error: String(e && e.message || e) }); }

  // ---- 3. Puente de noticias -> live/news.json (cc-news + cc-macro) ----
  // El Tier 2 lo leera como el SA lee market.json.news. Dedupe por los eventos del
  // calendario (builtAt y macro cambian cada llamada; macro viaja de arrastre como
  // en el SA). Best-effort: un fallo aqui nunca rompe el espejo de feeds/eventos.
  try {
    const [news, macro] = await Promise.all([readHandlerJson(newsHandler), readHandlerJson(macroHandler)]);
    if (news && Array.isArray(news.events)) {
      const cur = await ghGet(OWNER, REPO, BRANCH, 'live/news.json', { token });
      let prevFp = null;
      try { prevFp = cur?.content ? JSON.stringify(JSON.parse(cur.content).news?.events ?? null) : null; } catch { prevFp = null; }
      const fp = JSON.stringify(news.events);
      if (fp !== prevFp) {
        const body = JSON.stringify({ builtAt: new Date().toISOString(), news, macro: macro || null }, null, 2) + '\n';
        out.push(await ghPut(OWNER, REPO, BRANCH, 'live/news.json', body, `tos: news snapshot`, { token, known: cur }));
      } else {
        out.push({ skipped: true, path: 'live/news.json', guard: 'unchanged' });
      }
    }
  } catch (e) { out.push({ news: true, error: String(e && e.message || e) }); }

  // marcador de frescura (lo lee el watchdog unificado mas adelante)
  try { await store.setJSON('meta:lastSnapshot', { at: new Date().toISOString(), wrote: out.filter((w) => !w.skipped).length }); } catch { /* best effort */ }

  return { ok: true, wrote: out };
}

// invocable por HTTP para pruebas: GET /api/tos-bus-snapshot
export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' }
  });
};
