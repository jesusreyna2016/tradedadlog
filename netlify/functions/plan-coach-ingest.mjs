// Recibe los webhooks del feed STATE EXPORT de "TDL Trading Plan Agent"
// (trading_plan_agent.pine, copia independiente de "TDL Scalp CC" hecha para
// el proyecto del Plan Coach -- no tocar scalp-ingest.mjs/scalp_cc_FULL, ese
// sigue siendo el pipeline del otro agente).
// Mismo formato de linea que scalp-ingest (SCC1|k=v|k=v|...), guardado en un
// store de Blobs SEPARADO ('plan-coach', no 'scalp') para no mezclar los dos
// feeds. Guarda cada evento con clave unica e inmutable:
//   plan-coach store, key  ev/<YYYY-MM-DD>/<sigId>__<evt>
//   plan-coach store, key  last                          (puntero de depuracion)
import { getStore } from '@netlify/blobs';

function parsePipe(text) {
  if (!text) return null;
  const parts = String(text).trim().split('|');
  if (parts.length < 2) return null;
  const kv = {};
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx > 0) kv[parts[i].slice(0, idx).trim()] = parts[i].slice(idx + 1).trim();
  }
  return { prefix: parts[0].trim(), kv };
}

const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.PLAN_COACH_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if (!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const lines = String(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('SCC1|'));
  if (!lines.length) return new Response('bad payload (esperaba 1+ lineas SCC1|k=v|...)', { status: 400 });

  const store = getStore('plan-coach');
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stored = [];

  for (const line of lines) {
    const parsed = parsePipe(line);
    if (!parsed || parsed.prefix !== 'SCC1') continue;
    const kv = parsed.kv;
    const evt = (kv.evt || 'signal').toLowerCase();
    const sym = (kv.sym || 'NQ').toUpperCase();
    const tf = kv.tf || '?';
    const sigId = kv.sigId || `${sym}-${tf}-${Date.now()}-${stored.length}`;

    const record = {
      evt, sym, tf, sigId,
      ver: kv.ver || null,
      ts: kv.ts || null,
      raw: kv,
      receivedAt: now.toISOString(),
    };
    await store.setJSON(`ev/${day}/${safeKey(sigId)}__${evt}`, record);
    await store.setJSON('last', record);
    stored.push(`${evt}:${sym}${tf}:${sigId}`);
  }

  if (!stored.length) return new Response('no valid SCC1 lines', { status: 400 });
  return new Response(`ok · ${stored.length} · ${stored.join(' , ')}`, { status: 200 });
};
