// Velas de 5m al bus del Session Analyst (bars/<YYYY-MM-DD>.json, dia UTC), para que la
// calificacion de cada plan salga de precios reales y no de la memoria del agente.
// Las rutinas cloud no tienen red hacia afuera, asi que el grader
// (method/grade_plans.py) solo puede leer lo que esta en el repo.
//
// Cada hora a :07 baja los ultimos 2 dias de Yahoo y reescribe los archivos de hoy y
// ayer (union por timestamp, asi una vela tardia de Yahoo no borra nada).
// Formato compacto: { builtAt, tf: "5m", symbols: { NQ: [[tSec, o, h, l, c], ...] } }
import { busGet, busPut } from './_sa-bus.mjs';

export const config = { schedule: '7 * * * *' };

const SYMS = { NQ: 'NQ=F', ES: 'ES=F', GC: 'GC=F', YM: 'YM=F', CL: 'CL=F', ETHUSDT: 'ETH-USD', BTCUSDT: 'BTC-USD' };
const UA = { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)', accept: 'application/json' };

async function bars(sym){
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=5m&range=2d';
  const r = await fetch(u, { headers: UA });
  if(!r.ok) throw new Error('yahoo ' + sym + ' ' + r.status);
  const res = (await r.json())?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if(!res?.timestamp || !q) return [];
  const rd = (x) => Math.round(x * 1e4) / 1e4;
  const out = [];
  res.timestamp.forEach((t, i) => {
    if(q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    out.push([t, rd(q.open[i] ?? q.close[i]), rd(q.high[i]), rd(q.low[i]), rd(q.close[i])]);
  });
  return out;
}

export async function runBars(){
  const token = process.env.SA_BUS_TOKEN;
  if(!token) return { ok: false, reason: 'SA_BUS_TOKEN no configurado' };
  const byDay = {};
  const errors = {};
  await Promise.all(Object.entries(SYMS).map(async ([k, sym]) => {
    try {
      for(const b of await bars(sym)){
        const day = new Date(b[0] * 1000).toISOString().slice(0, 10);
        ((byDay[day] ||= {})[k] ||= []).push(b);
      }
    } catch(e){ errors[k] = String(e.message || e); }
  }));
  const written = [];
  for(const day of Object.keys(byDay).sort()){
    const path = `bars/${day}.json`;
    let cur = null, prev = { symbols: {} };
    try {
      cur = await busGet(path, { token });
      if(cur && cur.content) prev = JSON.parse(cur.content);
    } catch(e){ cur = undefined; }
    const symbols = { ...(prev.symbols || {}) };
    for(const [k, list] of Object.entries(byDay[day])){
      const m = new Map((symbols[k] || []).map((b) => [b[0], b]));
      for(const b of list) m.set(b[0], b);
      symbols[k] = [...m.values()].sort((a, b) => a[0] - b[0]);
    }
    const body = JSON.stringify({ builtAt: new Date().toISOString(), tf: '5m', source: 'yahoo', symbols }) + '\n';
    try {
      const r = await busPut(path, body, `sa-bus: bars ${day}`, { token, known: cur });
      written.push({ day, ...r });
    } catch(e){ written.push({ day, error: String(e.message || e) }); }
  }
  return { ok: true, written, errors };
}

export default async () => {
  const r = await runBars();
  return new Response(JSON.stringify(r), {
    status: r.ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
