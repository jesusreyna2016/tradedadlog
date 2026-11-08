// API del vigilante en vivo para Mi Mesa (solo el dueño, con su sesion de Supabase).
//   GET  /api/live?action=snapshot                 -> cuentas de MFP + riesgo en vivo + posiciones abiertas
//   GET  /api/live?action=closed&accounts=a,b&since=ms -> posiciones cerradas para importar como trades
//   POST /api/live?action=config   { windows, cooldownMin, matchWindowMin, riskPerTrade, lang }
//   POST /api/live?action=plans    { plans:[{id,fam,side,ts,status,acct}] }
import { getStore } from '@netlify/blobs';
import { ownerFromToken } from './_push.mjs';
import { closedForImport } from './_live.mjs';
import { hasKey } from './_mfp.mjs';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'content-type': 'application/json',
  'cache-control': 'no-store'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await ownerFromToken(token))) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const store = getStore('live');

  try {
    if (req.method === 'GET' && action === 'snapshot') {
      if (!hasKey()) return json({ error: 'no-key' });
      const snap = await store.get('snapshot', { type: 'json' }).catch(() => null);
      return json(snap || { error: 'pending' });
    }
    if (req.method === 'GET' && action === 'closed') {
      if (!hasKey()) return json({ error: 'no-key' });
      const ids = (url.searchParams.get('accounts') || '').split(',').filter(Boolean).slice(0, 25);
      const since = +url.searchParams.get('since') || 0;
      return json({ positions: await closedForImport(ids, since) });
    }
    if (req.method === 'POST' && (action === 'config' || action === 'plans')) {
      const body = await req.json();
      if (action === 'config') {
        const cfg = {
          windows: Array.isArray(body.windows) ? body.windows.slice(0, 6).map(String) : [],
          cooldownMin: +body.cooldownMin || 15, matchWindowMin: +body.matchWindowMin || 20,
          riskPerTrade: +body.riskPerTrade || 200, feeDayCap: Math.max(0, +body.feeDayCap || 0), maxSizeX: Math.max(0, +body.maxSizeX || 0),
          lang: body.lang === 'en' ? 'en' : 'es'
        };
        await store.setJSON('config', cfg);
        return json({ ok: true });
      }
      const plans = (Array.isArray(body.plans) ? body.plans : []).slice(-50).map((p) => ({
        id: String(p.id), fam: String(p.fam || ''), side: p.side === 'short' ? 'short' : 'long', ts: +p.ts || 0, status: String(p.status || ''), acct: p.acct || null
      }));
      await store.setJSON('plans', { plans, at: Date.now() });
      return json({ ok: true, n: plans.length });
    }
    return json({ error: 'action' }, 400);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
};
