// Snapshot programado: empuja el estado de mercado al bus GitHub para que las
// rutinas cloud del Session Analyst (que NO pueden salir a tradedadlog.com) lo
// lean desde el checkout del repo.
//
// Escribe un solo archivo, live/market.json, con la salida de session-feed +
// cc-news. busPut omite el commit si el contenido no cambio, asi que en fin de
// semana / mercado cerrado esto no genera ruido.
//
// Cron: cada 5 min. Tambien se puede invocar a mano: GET /api/sa-bus-snapshot
import feedHandler from './session-feed.mjs';
import newsHandler from './cc-news.mjs';
import { busPut } from './_sa-bus.mjs';

export const config = { schedule: '*/5 * * * *' };

const readJson = async (handler) => {
  try {
    const res = await handler(new Request('https://tradedadlog.com/internal'));
    return await res.json();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
};

export default async () => {
  const token = process.env.SA_BUS_TOKEN;
  const now = new Date().toISOString();

  const [feed, news] = await Promise.all([readJson(feedHandler), readJson(newsHandler)]);

  const payload = {
    builtAt: now,
    feed,
    news
  };
  const body = JSON.stringify(payload, null, 2) + '\n';

  if (!token) {
    return new Response(JSON.stringify({ ok: false, reason: 'SA_BUS_TOKEN no configurado', builtAt: now }), {
      status: 503, headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const r = await busPut('live/market.json', body, `sa-bus: market snapshot ${now}`, { token });
    return new Response(JSON.stringify({ ok: true, ...r, builtAt: now }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e), builtAt: now }), {
      status: 502, headers: { 'content-type': 'application/json' }
    });
  }
};
