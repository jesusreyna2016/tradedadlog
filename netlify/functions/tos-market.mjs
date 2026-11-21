// Trader OS · lente Contexto (Fase 1, composer determinista).
// Lee del repo git trader-os-bus lo que el snapshot dejó crudo:
//   live/feeds.json        (ultimo estado por fuente+simbolo: feed, command, orb, regime, trendcl, tdl_kl STATE)
//   events/<hoy>.jsonl      (eventos semanticos Tier B: tdl_kl, tdl_rev, tdl_po3)
// y compone live/market.json en la forma del esquema (una verdad por simbolo):
//   { verdict, bias, conviction, dayType, newsRisk, geo{...}, struct{regime,align,cisd,po3,lastLevelEvent} }
//
// geo  = passthrough fiel del FEED1 (geometria), con los numeros ya coercionados.
// struct = conducta/estructura de TDL_KL (+ PO3).
// verdict/bias/conviction = del feed 'command' (el motor de sesgo fusionado que ya
//   existe); NO duplicamos su logica. La inteligencia LLM del Session Analyst se
//   integra en Fase 4; aqui solo reestructuramos lo que ya llega.
import { ghGet, ghPut } from './_gh-bus.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';

// Eventos de la maquina de estados de niveles (para lastLevelEvent)
const LEVEL_EVENTS = new Set(['TOUCH', 'REJECT', 'SWEEP', 'ACCEPT_UP', 'ACCEPT_DOWN', 'CROSS', 'FAILED_BREAK', 'RETEST']);
const META_KEYS = new Set(['src', 'sym', 'ticker', 'ver', 'ts', 't', 'tf', 'time']);

const isNum = (v) => typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v);
function coerceNums(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (META_KEYS.has(k)) continue;
    out[k] = isNum(v) ? Number(v) : v;
  }
  return out;
}
const n = (v) => (isNum(v) ? Number(v) : (typeof v === 'number' ? v : null));

function parseCisd(s) {
  if (!s || typeof s !== 'string') return null;
  const [c0, h1, h2, h3] = s.split('/').map((x) => Number(x));
  return { chart: c0 ?? null, h1: h1 ?? null, h2: h2 ?? null, h3: h3 ?? null };
}

function parseJsonl(content) {
  const rows = [];
  if (!content) return rows;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* corrupta */ }
  }
  return rows;
}

// ultimo evento (mayor t) que cumple pred
function latest(rows, pred) {
  let best = null;
  for (const e of rows) if (pred(e) && (!best || (e.t || 0) >= (best.t || 0))) best = e;
  return best;
}

export async function runMarket() {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta TOS_BUS_TOKEN' };

  const feedsCur = await ghGet(OWNER, REPO, BRANCH, 'live/feeds.json', { token });
  let feeds = {};
  try { feeds = feedsCur?.content ? JSON.parse(feedsCur.content) : {}; } catch { feeds = {}; }

  const day = new Date().toISOString().slice(0, 10);
  const evCur = await ghGet(OWNER, REPO, BRANCH, `events/${day}.jsonl`, { token });
  const events = parseJsonl(evCur?.content);

  // simbolos presentes en cualquier fuente de feeds.json ("<src>:<SYM>")
  const syms = new Set();
  for (const key of Object.keys(feeds)) {
    const i = key.indexOf(':');
    if (i > 0) syms.add(key.slice(i + 1));
  }

  const get = (src, sym) => feeds[`${src}:${sym}`]?.raw || null;
  const symbols = {};

  for (const sym of syms) {
    const feed = get('feed', sym);
    const cmd = get('command', sym);
    const klState = get('tdl_kl', sym);
    const evThis = events.filter((e) => e.sym === sym);

    // struct: heartbeat STATE si existe; si no, el ultimo evento tdl_kl trae regime+align
    const klEv = latest(evThis, (e) => e.src === 'tdl_kl');
    const regime = klState?.regime || klEv?.data?.regime || null;
    const align = klState?.align || klEv?.data?.align || null;
    const cisd = parseCisd(klState?.cisd);   // solo el heartbeat STATE trae el CISD por TF

    const lvlEv = latest(evThis, (e) => e.src === 'tdl_kl' && LEVEL_EVENTS.has(e.event));
    const po3Ev = latest(evThis, (e) => e.src === 'tdl_po3');

    symbols[sym] = {
      verdict: cmd?.verdict || null,
      bias: n(cmd?.biasScore),
      dir: cmd?.dir || null,
      conviction: cmd?.strength || null,
      dayType: feed?.dayType || cmd?.dayType || null,
      newsRisk: feed?.newsRisk || cmd?.newsRisk || null,
      geo: feed ? coerceNums(feed) : null,
      struct: {
        regime,
        align,
        cisd,
        po3: po3Ev?.data?.phase || null,
        po3Dir: po3Ev?.data?.dir || null,
        lastLevelEvent: lvlEv ? {
          level: lvlEv.data?.level || lvlEv.kind || null,
          event: lvlEv.event,
          t: lvlEv.t,
          price: n(lvlEv.data?.price),
          dist: n(lvlEv.data?.dist),
          touches: n(lvlEv.data?.touches)
        } : null
      }
    };
  }

  const market = { _writer: 'contexto-composer', _schema: 1, asOf: new Date().toISOString(), symbols };
  const res = await ghPut(OWNER, REPO, BRANCH, 'live/market.json',
    JSON.stringify(market, null, 2) + '\n', `tos: market ${market.asOf} (${syms.size} sym)`, { token });
  return { ok: true, syms: [...syms], wrote: res };
}

// invocable por HTTP para pruebas: GET /api/tos-market
export default async () => {
  const r = await runMarket();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' }
  });
};
