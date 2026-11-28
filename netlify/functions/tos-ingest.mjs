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
import { tosIngestBody } from './_tos-core.mjs';

export default async (req) => {
  if(req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.TOS_INGEST_SECRET || process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if(!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const r = await tosIngestBody(body);
  // Las lineas de indicadores del Session Analyst (FEED1, CMDC1, RGM1, TCL1...) tambien van a
  // ind-ingest: si la alerta de TradingView apunta solo aqui, el Session Analyst no se queda sin
  // feed (2026-11-28: la alerta nueva de TDL Feed iba solo a tos-ingest y el SA paso 11 h sin datos).
  // noTos=1 evita que ind-ingest lo vuelva a mandar aqui.
  if(/^\s*(FEED1|CMDC1|RGM1|TCL1|R3R1|DRB1|SRZ1|HCZ1|MMZ1)\|/.test(body) && process.env.CC_INGEST_SECRET){
    try {
      const u = new URL('/.netlify/functions/ind-ingest', req.url);
      u.searchParams.set('key', process.env.CC_INGEST_SECRET);
      u.searchParams.set('noTos', '1');
      await fetch(u, { method: 'POST', body, signal: AbortSignal.timeout(6000) });
    } catch (e) { /* secundario: no rompe la ingesta de Trader OS */ }
  }
  if(!r) return new Response('bad payload (esperaba JSON {"src":...} o PREFIJO|k=v|...)', { status: 400 });
  return new Response(`ok · tos · estado ${r.nState} · eventos ${r.nEvent} · ${r.now}`, { status: 200 });
};
