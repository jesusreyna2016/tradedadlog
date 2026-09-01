// Feed para el dashboard del agente Scalp CC (public/scalp.html).
// Lee del repo publico jesusreyna2016/scalp-cc-bus via raw.githubusercontent
// (sin token): report.json + state.json + las ultimas señales/outcomes del dia.
const RAW = 'https://raw.githubusercontent.com/jesusreyna2016/scalp-cc-bus/main';

async function j(path) {
  try {
    const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tdl-scalp-dash' }, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function jsonl(path, limit = 40) {
  try {
    const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tdl-scalp-dash' }, cache: 'no-store' });
    if (!r.ok) return [];
    const t = await r.text();
    const rows = t.split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}

export default async () => {
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  const [report, state, sigT, outT, sigY, outY] = await Promise.all([
    j('report.json'), j('state.json'),
    jsonl(`signals/${today}.jsonl`), jsonl(`outcomes/${today}.jsonl`),
    jsonl(`signals/${y}.jsonl`), jsonl(`outcomes/${y}.jsonl`),
  ]);

  const recentSignals = [...sigY, ...sigT].slice(-30).reverse();
  const recentOutcomes = [...outY, ...outT].slice(-30).reverse();

  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    report: report || null,
    state: state || null,
    recentSignals,
    recentOutcomes,
  }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
};
