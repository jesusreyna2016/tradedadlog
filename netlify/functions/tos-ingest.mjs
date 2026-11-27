// Trader OS · ingest unico (Fase 1).
// Recibe los webhooks de TradingView para el cerebro Trader OS y enruta cada
// `src` a su capa, en el store de Netlify Blobs 'tos':
//
//   Tier A / estado (se sobreescribe el ultimo)   -> key  state:<src>:<SYM>
//     feed (FEED1, geometria) · command · orb · regime · trendcl · TDL_KL event=STATE (heartbeat)
//   Tier B / eventos semanticos (log append-only)  -> key  events:<YYYY-MM-DD>
//     TDL_KL (TOUCH/REJECT/SWEEP/ACCEPT/FAILED_BREAK/RETEST/CISD_*/ALIGN_*) ·
//     TDL_REV (entrada SELL/BUY + RESOLUTION TARGET_HIT/INVALIDATED) · TDL_PO3 (PHASE_CHANGE)
//
// Acepta DOS formatos de payload, uno o varios por webhook (TradingView manda una
// sola llamada por vela aunque haya varios alert(); se parten por salto de linea):
//   - JSON:  {"src":"TDL_KL", ... }          (los indicadores nuevos)
//   - Pipe:  FEED1|src=feed|sym=NQ|...        (FEED1 y el legacy)
//
// Un cron aparte (tos-bus-snapshot) espeja estos blobs al repo git trader-os-bus.
import { getStore } from '@netlify/blobs';
import { feedToRow, mergeRows, TVBAR_MAX } from './_tvbars.mjs';

// Prefijo pipe -> src (igual que ind-ingest, para heredar FEED1 y el legacy)
const PREFIX_SRC = {
  FEED1: 'feed', CMDC1: 'command', TDL1: 'orb', RGM1: 'regime', TCL1: 'trendcl',
  R3R1: '3reads', DRB1: 'drbias', SRZ1: 'srzones', HCZ1: 'htfzones'
};

// src que son ESTADO (ultimo snapshot). Todo lo demas que traiga evento va al log.
const STATE_SRCS = new Set(['feed', 'command', 'orb', 'regime', 'trendcl']);
// Micros -> su contrato principal
const SYM_ALIAS = { MNQ: 'NQ', MES: 'ES', MGC: 'GC', MYM: 'YM', MCL: 'CL', M2K: 'RTY' };
const EVENTS_MAX = 1500;   // tope por dia, por si una alerta se dispara en bucle

// "CME_MINI:NQ1!" -> "NQ" · "BINANCE:ETHUSDT25Z2026" / "ETHUSDT" / "ETHUSDT.P" -> "ETH"
function normSym(raw){
  if(!raw) return null;
  let s = String(raw);
  const c = s.lastIndexOf(':');
  if(c >= 0) s = s.slice(c + 1);              // quita el prefijo de exchange (BINANCE:)
  s = s.toUpperCase();
  s = s.replace(/[0-9!].*$/, '');             // corta en el primer digito o '!' (NQ1!, ETHUSDT25Z2026 -> ETHUSDT)
  s = s.replace(/\.?P$/, '');                 // perpetuos (ETHUSDT.P -> ETHUSDT)
  s = s.replace(/(USDT|USDC|USD|PERP)$/, ''); // quote de cripto (ETHUSDT -> ETH)
  return SYM_ALIAS[s] || s || null;
}

function parsePipe(text){
  const parts = String(text).trim().split('|');
  if(parts.length < 2) return null;
  const kv = {};
  for(let i = 1; i < parts.length; i++){
    const idx = parts[i].indexOf('=');
    if(idx > 0) kv[parts[i].slice(0, idx).trim()] = parts[i].slice(idx + 1).trim();
  }
  return { src: (kv.src || PREFIX_SRC[parts[0].trim()] || parts[0].trim()).toLowerCase(),
           sym: (normSym(kv.sym || kv.ticker) || 'NQ'),
           kv, fmt: 'pipe' };
}

// Normaliza una linea a { src, sym, ev, obj } o null
function parseLine(line){
  const s = line.trim();
  if(!s) return null;
  if(s[0] === '{'){
    let obj; try { obj = JSON.parse(s); } catch { return null; }
    const src = String(obj.src || 'unknown').toLowerCase();
    const sym = normSym(obj.sym || obj.ticker) || 'NQ';
    return { src, sym, ev: obj.event || obj.signal || null, obj, fmt: 'json' };
  }
  if(s.includes('|')){
    const p = parsePipe(s);
    if(p) return { src: p.src, sym: p.sym, ev: p.kv.event || null, obj: p.kv, fmt: 'pipe' };
  }
  return null;
}

async function appendEvent(store, rec){
  const day = (rec.t ? new Date(rec.t).toISOString() : new Date().toISOString()).slice(0, 10);
  const key = `events:${day}`;
  let log = [];
  try { log = (await store.get(key, { type: 'json' })) || []; } catch { log = []; }
  // dedup: misma fuente + simbolo + tiempo + evento (alerta reintentada)
  if(rec.t && log.some(e => e.t === rec.t && e.src === rec.src && e.sym === rec.sym && e.event === rec.event)) return false;
  log.push(rec);
  if(log.length > EVENTS_MAX) log = log.slice(-EVENTS_MAX);
  await store.setJSON(key, log);
  return true;
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.TOS_INGEST_SECRET || process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if(!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const lines = body.split('\n').map(parseLine).filter(Boolean);
  if(!lines.length) return new Response('bad payload (esperaba JSON {"src":...} o PREFIJO|k=v|...)', { status: 400 });

  const store = getStore('tos');
  let nState = 0, nEvent = 0;
  const now = new Date().toISOString();

  for(const ln of lines){
    const isState = STATE_SRCS.has(ln.src) || (ln.src === 'tdl_kl' && ln.ev === 'STATE');
    if(isState){
      // ultimo estado por fuente+simbolo (Tier A + heartbeat)
      await store.setJSON(`state:${ln.src}:${ln.sym}`, {
        src: ln.src, sym: ln.sym, ev: ln.ev || null, fmt: ln.fmt,
        raw: ln.obj, receivedAt: now
      });
      nState++;
      // FEED1 (una vela de 5m): ademas se archiva la fila vela + contexto (Edgeful)
      if(ln.src === 'feed'){
        const fr = feedToRow(ln.obj);
        if(fr){
          const k = `tvbar:${fr.day}:${ln.sym}`;
          let rows = [];
          try { rows = (await store.get(k, { type: 'json' })) || []; } catch { rows = []; }
          rows = mergeRows(rows, [fr.row]);
          if(rows.length > TVBAR_MAX) rows = rows.slice(-TVBAR_MAX);
          await store.setJSON(k, rows);
        }
      }
    } else {
      // evento semantico (Tier B) al log del dia
      const t = Number(ln.obj.time) || Number(ln.obj.t) || Date.now();
      const ok = await appendEvent(store, {
        t, src: ln.src, sym: ln.sym, tf: ln.obj.tf || null,
        event: ln.ev || null, kind: ln.obj.kind || ln.obj.level || ln.obj.type || null,
        data: ln.obj, receivedAt: now
      });
      if(ok) nEvent++;
    }
  }

  return new Response(`ok · tos · estado ${nState} · eventos ${nEvent} · ${now}`, { status: 200 });
};
