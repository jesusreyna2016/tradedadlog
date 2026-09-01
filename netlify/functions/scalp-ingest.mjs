// Recibe los webhooks del parche STATE EXPORT de "TDL · Scalp CC".
// El body puede traer VARIAS lineas SCC1| (una por evento) porque TradingView
// entrega un solo webhook por vela: el parche acumula 1 signal + N outcomes en
// un mensaje con lineas separadas por \n. Aqui se parte y se guarda cada evento
// con clave UNICA e inmutable (sin read-modify-write, sin carrera):
//   scalp store, key  ev/<YYYY-MM-DD>/<sigId>__<evt>
//   scalp store, key  last                          (puntero de depuracion)
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

  const secret = process.env.SCALP_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if (!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const lines = String(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('SCC1|'));
  if (!lines.length) return new Response('bad payload (esperaba 1+ lineas SCC1|k=v|...)', { status: 400 });

  const store = getStore('scalp');
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
