// Vigilante de shock entre corridas del Session Analyst. El plan se arma 3 veces al dia
// (2 en fin de semana); si a mitad de sesion sale un titular grande o el precio da un
// tiron, el plan queda viejo hasta la siguiente corrida. Esto lo detecta cada 10 min:
//   headline -> titular de las ultimas 30 min con tema geo/trump/fed/hack y palabra fuerte
//   price    -> movimiento de 15 min fuera de lo normal (NQ/ES/GC/CL/ETH/BTC, velas 5m)
//   vix      -> VIX +8 % en la ultima hora (solo horario de NY)
//   dvol     -> DVOL de ETH +4 puntos en la ultima hora
// Cada shock vive 60 min. GET /api/cc-shock lo sirve al Command Center (banner + sonido +
// notificacion) y, cuando cambia, se escribe en el bus (live/shock.json) para que la
// siguiente corrida del plan lo lea. El schedule vive en cc-shock-cron.mjs (Netlify no deja
// llamar por URL a una funcion programada); ?run=1 fuerza una deteccion a mano.
import { getStore } from '@netlify/blobs';
import newsHandler from './cc-news.mjs';
import { busPut } from './_sa-bus.mjs';

const LIFE_MS = 60 * 60 * 1000;
const UA = { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)', accept: 'application/json' };
// umbral de movimiento en 15 min (% absoluto) por simbolo
const MOVE = { NQ: ['NQ=F', 0.6], ES: ['ES=F', 0.45], GC: ['GC=F', 0.6], CL: ['CL=F', 1.2], ETHUSDT: ['ETH-USD', 1.5], BTCUSDT: ['BTC-USD', 1.2] };
const STRONG = /\b(attack|strikes?|missile|invasion|war|tariffs?|emergency|halt(ed)?|ban(ned)?|resign\w*|default|sanctions?|hack(ed)?|exploit(ed)?|drain(ed)?|crash\w*|plunges?|surges?|soars?|collapse\w*|rate (cut|hike)|ceasefire)\b/i;
const HEAD_TAGS = ['geo', 'trump', 'fed', 'hack', 'oil'];
// opinion y pronostico no son hechos: "Will X cause a crash?", "Here's why..."
const OPINION = /\?\s*$|^(will|could|should|might|can|is|are|why|how|what|here's|here is)\b|\b(could|might|may|forecast|prediction|outlook|analysts? say)\b/i;

async function closes(sym, interval, range){
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + interval + '&range=' + range;
  const r = await fetch(u, { headers: UA });
  if(!r.ok) throw new Error('yahoo ' + sym + ' ' + r.status);
  const res = (await r.json())?.chart?.result?.[0];
  const c = res?.indicators?.quote?.[0]?.close || [];
  return (res?.timestamp || []).map((t, i) => [t * 1000, c[i]]).filter((x) => x[1] != null);
}

async function detect(){
  const now = Date.now();
  const found = [];
  // 1) titulares fuertes recientes
  try {
    const news = await (await newsHandler()).json();
    for(const h of news.headlines || []){
      if(!h.ts || now - h.ts > 30 * 60e3) continue;
      if(!h.tags?.some((t) => HEAD_TAGS.includes(t)) || !STRONG.test(h.title) || OPINION.test(h.title)) continue;
      const crypto = h.tags.includes('crypto');
      found.push({ kind: 'headline', sym: crypto ? 'CRYPTO' : 'ALL', key: 'h:' + h.title.slice(0, 80),
        msg: h.title, source: h.source || '', tags: h.tags, at: h.ts });
    }
  } catch(e){ /* sin titulares: seguimos con precio */ }
  // 2) tirones de precio de 15 min
  await Promise.all(Object.entries(MOVE).map(async ([k, [sym, th]]) => {
    try {
      const c = await closes(sym, '5m', '1d');
      if(c.length < 4) return;
      const last = c[c.length - 1];
      if(now - last[0] > 20 * 60e3) return;   // mercado cerrado o vela vieja
      const ref = c.slice().reverse().find((x) => x[0] <= last[0] - 15 * 60e3);
      if(!ref) return;
      const pct = (last[1] / ref[1] - 1) * 100;
      if(Math.abs(pct) >= th){
        found.push({ kind: 'price', sym: k, key: 'p:' + k + ':' + Math.round(last[0] / 1800e3),
          msg: k.replace(/USDT$/, '') + ' ' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '% en 15 min', pct: Math.round(pct * 100) / 100, at: last[0] });
      }
    } catch(e){}
  }));
  // 3) VIX +8 % en 1 h
  try {
    const c = await closes('^VIX', '5m', '1d');
    const last = c[c.length - 1];
    const ref = last && c.slice().reverse().find((x) => x[0] <= last[0] - 60 * 60e3);
    if(last && ref && now - last[0] < 20 * 60e3){
      const pct = (last[1] / ref[1] - 1) * 100;
      if(pct >= 8) found.push({ kind: 'vix', sym: 'ALL', key: 'v:' + Math.round(last[0] / 3600e3), msg: 'VIX +' + pct.toFixed(1) + '% en 1 h', pct: Math.round(pct * 10) / 10, at: last[0] });
    }
  } catch(e){}
  // 4) DVOL de ETH +4 en 1 h
  try {
    const r = await fetch('https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=ETH&resolution=600&start_timestamp=' + (now - 80 * 60e3) + '&end_timestamp=' + now, { headers: UA });
    const d = (await r.json())?.result?.data || [];
    if(d.length >= 2){
      const last = d[d.length - 1], ref = d.find((x) => x[0] >= now - 65 * 60e3) || d[0];
      const ch = last[4] - ref[4];
      if(ch >= 4) found.push({ kind: 'dvol', sym: 'ETHUSDT', key: 'd:' + Math.round(last[0] / 3600e3), msg: 'DVOL ETH +' + ch.toFixed(1) + ' en 1 h', at: last[0] });
    }
  } catch(e){}
  return found;
}

export async function runShock(){
  const now = Date.now();
  let store = null;
  try { store = getStore('cc'); } catch(e){}
  let prev = { active: [] };
  try { prev = (store && await store.get('shock', { type: 'json' })) || prev; } catch(e){}
  const keep = (prev.active || []).filter((x) => now - x.seenAt < LIFE_MS);
  const known = new Set(keep.map((x) => x.key));
  const fresh = (await detect()).filter((x) => !known.has(x.key)).map((x) => ({ ...x, seenAt: now }));
  const active = [...fresh, ...keep].sort((a, b) => b.seenAt - a.seenAt).slice(0, 12);
  const state = { updatedAt: new Date(now).toISOString(), active };
  if(store){ try { await store.setJSON('shock', state); } catch(e){} }
  // al bus solo cuando cambia el conjunto (alta o baja), no en cada vuelta
  const sig = (l) => l.map((x) => x.key).sort().join('|');
  let bus = null;
  if(sig(active) !== sig(prev.active || []) && process.env.SA_BUS_TOKEN){
    try {
      bus = await busPut('live/shock.json', JSON.stringify(state, null, 1) + '\n',
        'sa-bus: shock ' + (fresh.length ? fresh.map((x) => x.kind + ':' + x.sym).join(',') : 'expired'), { token: process.env.SA_BUS_TOKEN });
    } catch(e){ bus = { error: String(e.message || e) }; }
  }
  return { ...state, newCount: fresh.length, bus };
}

export default async (req) => {
  // GET desde el Center solo lee el estado; ?run=1 fuerza una deteccion
  let body;
  if(!(req && req.url && /[?&]run=1/.test(req.url))){
    let store = null;
    try { store = getStore('cc'); } catch(e){}
    let s = null;
    try { s = store && await store.get('shock', { type: 'json' }); } catch(e){}
    const now = Date.now();
    body = { updatedAt: s?.updatedAt || null, active: (s?.active || []).filter((x) => now - x.seenAt < LIFE_MS) };
  } else {
    body = await runShock();
  }
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  });
};
