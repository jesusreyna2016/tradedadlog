// Feed unificado para el agente Session Analyst. Devuelve, por simbolo
// (NQ / ES / GC), el ultimo estado de cada fuente:
//   orb      -> backbone orb_sesgo (sym:<SYM>, lo guarda cc-ingest)
//   3reads   -> Rutina 3 Reads          (ind:3reads:<SYM>)
//   drbias   -> Daily Range & Bias Pro  (ind:drbias:<SYM>)
//   srzones  -> Support & Resistance MTF (ind:srzones:<SYM>)
//   htfzones -> HTF Context & Zones     (ind:htfzones:<SYM>)
//   command  -> NQ Command All-in-One   (ind:command:<SYM>) · sesgo fusionado + veredicto Portero
// El calendario economico se pide aparte a /api/cc-news.
import { getStore } from '@netlify/blobs';

const SYMBOLS = ['NQ', 'ES', 'GC'];
const SOURCES = ['3reads', 'drbias', 'srzones', 'htfzones', 'command'];

export default async () => {
  const store = getStore('cc');
  const symbols = {};

  await Promise.all(SYMBOLS.map(async (sym) => {
    const entry = {};
    try {
      const orb = await store.get('sym:' + sym, { type: 'json' });
      if (orb) entry.orb = orb;
    } catch (e) { /* sin backbone para ese simbolo todavia */ }

    await Promise.all(SOURCES.map(async (src) => {
      try {
        const rec = await store.get(`ind:${src}:${sym}`, { type: 'json' });
        if (rec) entry[src] = rec;
      } catch (e) { /* sin dato de esa fuente todavia */ }
    }));

    symbols[sym] = entry;
  }));

  return new Response(JSON.stringify({ symbols, generatedAt: new Date().toISOString() }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
};
