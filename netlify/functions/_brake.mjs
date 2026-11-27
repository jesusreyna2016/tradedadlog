// Trader OS · freno anti-tilt (Coach en vivo), etapa SOMBRA.
// Spec: trader-os-bus/method/coach-brake.md. El vigilante de Mi Mesa (_live.mjs, cada minuto) detecta las
// reglas y llama aqui; esto SOLO registra lo que el freno HABRIA hecho (cerrar, reducir, poner stop). No toca
// ninguna cuenta: la key de MFP es de solo lectura y en esta etapa no hay ninguna llamada de escritura.
//
// Cada accion sombra va al log de eventos de Trader OS (store 'tos', events:<dia UTC>, src 'brake',
// kind 'BRAKE_SHADOW'), que tos-bus-snapshot publica en trader-os-bus/events/<dia>.jsonl; el Coach y su
// review la leen de ahi. Un registro por posicion y regla.
//
// Modo: env BRAKE_MODE (por defecto 'shadow'). 'off' apaga el registro. Las etapas 'soft' y 'hard' NO
// estan construidas: cualquier otro valor se trata como 'shadow' y se anota asi.
import { getStore } from '@netlify/blobs';
import { ghGet } from './_gh-bus.mjs';

export const brakeMode = () => {
  const m = String(process.env.BRAKE_MODE || 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
};

// Acciones que tomaria el freno por regla (coach-brake.md, "Reglas de actuacion")
export const BRAKE_ACTION = {
  R1: 'close',            // entrada dentro de la pausa tras una perdida
  DAY_STOP: 'close_all',  // ya se toco el stop del dia de la cuenta
  SIZE: 'reduce',         // tamaño por encima del tope
  NO_STOP: 'set_stop'     // abierta 30 s sin stop: poner el stop del plan, no cerrar
};

// Umbrales vivos del Coach (trader-os-bus/state/coach-config.json), cacheados 15 min en el estado del vigilante
export async function brakeConfig(st, nowMs) {
  const def = { dayStopUsd: 500, pauseMin: 10, noStopSec: 30 };
  const c = st.brakeCfg;
  if (c && nowMs - c.at < 15 * 60e3) return c.v;
  let v = { ...def };
  const token = process.env.TOS_BUS_TOKEN;
  if (token) {
    try {
      const cur = await ghGet('jesusreyna2016', 'trader-os-bus', 'main', 'state/coach-config.json', { token });
      const j = cur?.content ? JSON.parse(cur.content) : {};
      const fin = (x, d) => (Number.isFinite(+x) && +x > 0 ? +x : d);
      v = { dayStopUsd: fin(j.dayStopUsd, def.dayStopUsd), pauseMin: fin(j.pauseMin, def.pauseMin), noStopSec: fin(j.brakeNoStopSec, def.noStopSec) };
    } catch { /* defaults */ }
  }
  st.brakeCfg = { at: nowMs, v };
  return v;
}

// Registra una accion sombra. ev = { rule, acct, name, posId, fam, side, size, detail }
export async function brakeShadow(ev, nowMs = Date.now()) {
  if (brakeMode() === 'off') return false;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const key = `events:${day}`;
  const store = getStore('tos');
  let logArr = [];
  try { logArr = (await store.get(key, { type: 'json' })) || []; } catch { logArr = []; }
  const tag = `brake-${ev.rule}-${ev.posId || ev.acct}`;
  if (logArr.some((e) => e.tag === tag)) return false;   // uno por posicion y regla
  const action = BRAKE_ACTION[ev.rule] || 'none';
  logArr.push({
    t: nowMs, src: 'brake', sym: ev.fam || null, event: ev.rule, kind: 'BRAKE_SHADOW', tag,
    mode: brakeMode(), action, acct: ev.acct || null, account: ev.name || null, posId: ev.posId || null,
    side: ev.side || null, size: ev.size != null ? +ev.size : null, detail: ev.detail || null,
    text: `[sombra] el freno habria hecho ${action} (${ev.rule})${ev.detail ? ': ' + ev.detail : ''}`,
    receivedAt: new Date(nowMs).toISOString()
  });
  if (logArr.length > 2000) logArr = logArr.slice(-2000);
  await store.setJSON(key, logArr);
  return true;
}
