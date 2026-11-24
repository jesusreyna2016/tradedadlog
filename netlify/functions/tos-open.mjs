// Trader OS · posiciones abiertas en vivo, feed ligero para la entrevista de La Mesa.
// _live.mjs (cron cada minuto) ya escribe el snapshot con `open` por cuenta en el store
// 'live'. Aqui lo servimos recortado a lo minimo (sin balances ni riesgo), para que La
// Mesa detecte una entrada nueva en ~1 min en vez de los ~15 min del trader.json.
// Los mismos datos ya estan en el bus publico (trader.json openPositions), solo mas frescos.
import { getStore } from '@netlify/blobs';
import { familyOf } from './_mfp.mjs';

export default async () => {
  try {
    const store = getStore('live');
    const snap = await store.get('snapshot', { type: 'json' }).catch(() => null);
    const open = (snap && snap.open) || {};
    const accById = {};
    for (const a of (snap && snap.accounts) || []) accById[a.id] = a;
    const positions = [];
    for (const acct of Object.keys(open)) {
      const a = accById[acct] || {};
      for (const p of (open[acct] || [])) {
        positions.push({
          acct, acctNo: a.number || null, stage: a.stage || null, name: a.name || null,
          sym: familyOf(p.symbol), side: p.side || null,
          size: p.size ?? null, entry: p.entry ?? null,
          openedAt: p.openedAt ?? null, hadStop: !!p.stop
        });
      }
    }
    return new Response(JSON.stringify({ ok: true, asOf: (snap && snap.updatedAt) || null, positions }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e), positions: [] }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
};
