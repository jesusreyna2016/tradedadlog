// Feed unificado para el agente Session Analyst. Devuelve, por simbolo
// (NQ / ES / GC / YM / CL), el ultimo estado de cada fuente:
//   orb      -> backbone orb_sesgo (sym:<SYM>, lo guarda cc-ingest)
//   3reads   -> Rutina 3 Reads          (ind:3reads:<SYM>)
//   drbias   -> Daily Range & Bias Pro  (ind:drbias:<SYM>)
//   srzones  -> Support & Resistance MTF (ind:srzones:<SYM>)
//   htfzones -> HTF Context & Zones     (ind:htfzones:<SYM>)
//   command  -> NQ Command All-in-One   (ind:command:<SYM>) · sesgo fusionado + veredicto Portero
//   regime   -> Market Regime           (ind:regime:<SYM>) · CHOP/BULL/BEAR, caja y ultimo evento
//   trendcl  -> Trend Checklist         (ind:trendcl:<SYM>) · confirmed D/4H/1H verdict, flip levels, zone touches
// ETHUSDT / BTCUSDT van aparte en `crypto` (mismo esquema por simbolo): solo los lee la rutina
// crypto-weekend del Session Analyst, las corridas de futuros no los tocan.
// `scalp` = frescura de la tuberia Scalp CC (ultimo webhook recibido y ultima copia al
// bus scalp-cc-bus); el watchdog del Session Analyst la vigila.
// El calendario economico se pide aparte a /api/cc-news.
import { getStore } from '@netlify/blobs';

const SYMBOLS = ['NQ', 'ES', 'GC', 'YM', 'CL'];
const CRYPTO = ['ETHUSDT', 'BTCUSDT'];
const SOURCES = ['3reads', 'drbias', 'srzones', 'htfzones', 'command', 'regime', 'trendcl'];

export default async () => {
  const store = getStore('cc');
  const symbols = {};
  const crypto = {};

  await Promise.all([...SYMBOLS, ...CRYPTO].map(async (sym) => {
    const entry = {};
    try {
      const orb = await store.get('sym:' + sym, { type: 'json' });
      if (orb) {
        // el backbone (cc-ingest) estampa `updatedAt`; el resto de fuentes (ind-ingest)
        // usan `receivedAt`. Normalizamos para que el chequeo de frescura del agente
        // (umbrales por `receivedAt`) valga tambien para orb.
        if (!orb.receivedAt && orb.updatedAt) orb.receivedAt = orb.updatedAt;
        entry.orb = orb;
      }
    } catch (e) { /* sin backbone para ese simbolo todavia */ }

    await Promise.all(SOURCES.map(async (src) => {
      try {
        const rec = await store.get(`ind:${src}:${sym}`, { type: 'json' });
        if (rec) entry[src] = rec;
      } catch (e) { /* sin dato de esa fuente todavia */ }
    }));

    (CRYPTO.includes(sym) ? crypto : symbols)[sym] = entry;
  }));

  const scalp = { lastIngestAt: null, lastSnapshotAt: null };
  try {
    const ss = getStore('scalp');
    const [last, snap] = await Promise.all([
      ss.get('last', { type: 'json' }), ss.get('meta:lastSnapshot', { type: 'json' }),
    ]);
    scalp.lastIngestAt = last?.receivedAt || null;
    scalp.lastSnapshotAt = snap?.at || null;
  } catch (e) { /* scalp store unavailable */ }

  return new Response(JSON.stringify({ symbols, crypto, scalp, generatedAt: new Date().toISOString() }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
};
