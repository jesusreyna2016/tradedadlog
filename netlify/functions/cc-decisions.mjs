// Grades the Command Center v2 decision card.
//   GET /api/cc-decisions?days=14            -> per symbol: answers graded by the move 60 min later
//   GET /api/cc-decisions?sym=NQ&log=YYYY-MM-DD -> that day's raw log
import { getStore } from '@netlify/blobs';
import { SYMS, grade, HORIZON_MIN } from './_cc-decision.mjs';

const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore('cc');
  const day = url.searchParams.get('log');
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response('bad date', { status: 400 });
    const sym = (url.searchParams.get('sym') || 'NQ').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let log = [];
    try { log = (await store.get(`dlog:${sym}:${day}`, { type: 'json' })) || []; } catch (e) { log = []; }
    return new Response(JSON.stringify({ sym, day, log }), { headers: HEADERS });
  }

  const days = Math.min(60, Math.max(1, parseInt(url.searchParams.get('days') || '14', 10) || 14));
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const symbols = {};
  await Promise.all(SYMS.map(async (sym) => {
    const parts = await Promise.all(dates.map(d => store.get(`dlog:${sym}:${d}`, { type: 'json' }).catch(() => null)));
    const entries = parts.flatMap(p => p || []);
    symbols[sym] = { ...grade(entries), since: entries.length ? new Date(Math.min(...entries.map(e => e.t))).toISOString() : null };
  }));
  return new Response(JSON.stringify({ days, horizonMin: HORIZON_MIN, symbols, generatedAt: new Date().toISOString() }), { headers: HEADERS });
};
