// Devuelve el ultimo plan guardado de cada simbolo (NQ, ES, GC, CL, YM) para
// el scanner de Fuerza Relativa del Command Center. Cada uno se alimenta con
// su propio grafico + alerta de orb_sesgo.pine en TradingView (misma cadena
// TDL1, misma clave secreta, pero corriendo en el simbolo correspondiente).
import { getStore } from '@netlify/blobs';

const SYMBOLS = ['NQ', 'ES', 'GC', 'CL', 'YM', 'SI'];

export default async () => {
  const store = getStore('cc');
  const out = {};
  await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const plan = await store.get('sym:' + sym, { type: 'json' });
      if (plan) out[sym] = plan;
    } catch (e) {
      // sin dato para ese simbolo todavia
    }
  }));
  return new Response(JSON.stringify({ symbols: out, updatedAt: new Date().toISOString() }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
};
