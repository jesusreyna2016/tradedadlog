// Trader OS · admin / limpieza puntual del cerebro. Protegido por secreto.
// Acciones de mantenimiento que no caben en el ingest ni en el cron.
//
//   POST /api/tos-admin?key=<secret>&action=purge&syms=ETHUSDT25Z2026,ETHUSDT
//     Borra un simbolo "fantasma" (contrato viejo, ticker sin normalizar) de:
//       1. el store Blobs 'tos'  -> todas las claves state:<src>:<SYM>
//       2. live/feeds.json del bus -> todas las entradas <src>:<SYM>
//     El snapshot re-siembra feeds.json desde el listado de Blobs, por eso hay
//     que borrar PRIMERO en Blobs; si no, vuelve a aparecer en el siguiente cron.
//     Los events/<dia>.jsonl NO se tocan: son log append-only y rotan solos; la
//     lente Contexto ya no los compone al no estar el simbolo en feeds.json.
//
// Mismo secreto que el ingest (TOS_INGEST_SECRET || CC_INGEST_SECRET).
import { getStore } from '@netlify/blobs';
import { ghGet, ghPut } from './_gh-bus.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';

// sym de una clave Blobs "state:<src>:<SYM>" (SYM no lleva ':')
const symOfState = (k) => k.slice(k.lastIndexOf(':') + 1);
// sym de una clave feeds.json "<src>:<SYM>"
const symOfFeed = (k) => k.slice(k.indexOf(':') + 1);

async function purge(syms) {
  const drop = new Set(syms);
  const store = getStore('tos');

  // 1. Blobs: borra toda state:<src>:<SYM> de los simbolos pedidos
  const deleted = [];
  let cursor;
  do {
    const page = await store.list({ prefix: 'state:', cursor });
    for (const b of page?.blobs || []) {
      if (drop.has(symOfState(b.key))) { await store.delete(b.key); deleted.push(b.key); }
    }
    cursor = page?.cursor;
  } while (cursor);

  // 2. feeds.json del bus: quita <src>:<SYM> (merge-only no las suelta solo)
  const token = process.env.TOS_BUS_TOKEN;
  let feedsRes = null;
  const removed = [];
  if (token) {
    const cur = await ghGet(OWNER, REPO, BRANCH, 'live/feeds.json', { token });
    let feeds = {};
    try { feeds = cur?.content ? JSON.parse(cur.content) : {}; } catch { feeds = {}; }
    for (const k of Object.keys(feeds)) {
      if (k === '_updatedAt') continue;
      if (drop.has(symOfFeed(k))) { delete feeds[k]; removed.push(k); }
    }
    if (removed.length) {
      feeds._updatedAt = new Date().toISOString();
      feedsRes = await ghPut(OWNER, REPO, BRANCH, 'live/feeds.json',
        JSON.stringify(feeds, null, 2) + '\n', `tos: purge ${syms.join(',')}`, { token, known: cur });
    }
  }

  return { ok: true, syms, deleted, removed, feeds: feedsRes };
}

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.TOS_INGEST_SECRET || process.env.CC_INGEST_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) return new Response('unauthorized', { status: 401 });

  const action = url.searchParams.get('action');
  if (action === 'purge') {
    const syms = (url.searchParams.get('syms') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!syms.length) return new Response('falta syms (ej. action=purge&syms=ETHUSDT,ETHUSDT25Z2026)', { status: 400 });
    const r = await purge(syms);
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('action desconocida (usa action=purge&syms=...)', { status: 400 });
};
