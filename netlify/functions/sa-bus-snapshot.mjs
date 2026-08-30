// Snapshot del estado de mercado al bus GitHub para que las rutinas cloud del
// Session Analyst (sin egress a tradedadlog.com) lo lean del checkout del repo.
//
// Escribe live/market.json con la salida de session-feed + cc-news. busPut omite
// el commit si el contenido no cambio, asi que con el mercado cerrado no hay ruido.
//
// Esta es la funcion HTTP (invocable a mano para probar: GET /api/sa-bus-snapshot).
// El cron cada 5 min vive en sa-bus-cron.mjs y llama a runSnapshot() de aqui.
import feedHandler from './session-feed.mjs';
import newsHandler from './cc-news.mjs';
import { busPut } from './_sa-bus.mjs';

const readJson = async (handler) => {
  try {
    const res = await handler(new Request('https://tradedadlog.com/internal'));
    return await res.json();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
};

export async function runSnapshot() {
  const token = process.env.SA_BUS_TOKEN;
  const now = new Date().toISOString();
  if (!token) return { ok: false, reason: 'SA_BUS_TOKEN no configurado', builtAt: now };

  const [feed, news] = await Promise.all([readJson(feedHandler), readJson(newsHandler)]);
  const body = JSON.stringify({ builtAt: now, feed, news }, null, 2) + '\n';

  try {
    const r = await busPut('live/market.json', body, `sa-bus: market snapshot ${now}`, { token });
    return { ok: true, ...r, builtAt: now };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), builtAt: now };
  }
}

export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok ? 200 : (r.reason ? 503 : 502),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
