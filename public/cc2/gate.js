// Gatekeeper + discipline state. The day record keeps v1's shape and key (cc_portero_dia), so trades
// marked here also show in the classic view and the 30-day history (cc_portero_hist) stays one.
import { localDay } from './api.js';

export const MAX_TRADES = 5;          // MFP contract: max 5 trades a day
export const PAUSE_MIN = 5;           // post-exit pause, after wins AND losses (rule 7 sep / 18 sep)
const DAY = 'cc_portero_dia', HIST = 'cc_portero_hist', PAUSE = 'cc2_pause', RITUAL = 'cc_ritual_dia';

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

function freshDay() { return { date: localDay(), used: 0, stopped: false, reason: '', trades: [], seen: 0 }; }
export function day() {
  const r = read(DAY, null);
  if (r && r.date === localDay()) { r.trades = r.trades || []; return r; }
  return freshDay();
}
const saveDay = s => write(DAY, s);

export const ritualDone = () => { try { return localStorage.getItem(RITUAL) === localDay(); } catch (e) { return true; } };
export const setRitualDone = () => { try { localStorage.setItem(RITUAL, localDay()); } catch (e) {} };

export function pause() {
  const p = read(PAUSE, null);
  return p && p.date === localDay() ? p : null;
}
export function pauseLeftMs() { const p = pause(); return p ? Math.max(0, p.until - Date.now()) : 0; }
export function pauseActive() { return !!pause(); }   // stays until the note is written and he confirms
export function setPauseNote(note) { const p = pause(); if (p) { p.note = note; write(PAUSE, p); } }
export function endPause() {
  const p = pause(); if (!p) return;
  const s = day(); const last = s.trades[s.trades.length - 1];
  if (last && !last.next) { last.next = p.note || ''; saveDay(s); }
  try { localStorage.removeItem(PAUSE); } catch (e) {}
}

export function openTrade() { const s = day(); return s.open || null; }

export function startTrade(dir, against) {
  const s = day();
  s.open = { dir, at: Date.now(), t: hhmm(), against: !!against };
  saveDay(s);
}

export function closeTrade(result, pnl, sym) {
  const s = day();
  const o = s.open || {};
  s.used++;
  s.trades.push({ r: result, t: hhmm(), at: Date.now(), dir: o.dir || null, sym, pnl: isFinite(pnl) ? pnl : null, against: !!o.against });
  delete s.open;
  if (s.used >= MAX_TRADES) s.stopped = true;
  saveDay(s);
  if (result === 'loss') { try { localStorage.setItem('cc_post_sl_pause', localDay()); } catch (e) {} }
  // trading against the answer breaks the clean streak, like v1's "I broke a rule"
  const h = read(HIST, {}) || {};
  const t = localDay();
  if (o.against) h[t] = { clean: false };
  else if (!h[t] || h[t].clean !== false) h[t] = { clean: true };
  write(HIST, h);
  write(PAUSE, { date: localDay(), until: Date.now() + PAUSE_MIN * 60000, result, pnl: isFinite(pnl) ? pnl : null, dir: o.dir || null, sym, note: '' });
}

export function dayNet() {
  const tr = day().trades;
  if (!tr.some(x => x.pnl != null)) return null;
  return tr.reduce((a, x) => a + (x.pnl || 0), 0);
}

export function history() { return read(HIST, {}) || {}; }
export function streak() {
  const h = history(); const ds = Object.keys(h).sort(); let n = 0;
  for (let i = ds.length - 1; i >= 0; i--) { if (h[ds[i]] && h[ds[i]].clean === false) break; n++; }
  return n;
}

// gatekeeper status for the decision card
export function gateState() {
  const s = day();
  if (pauseActive()) return { ok: false, kind: 'pause' };
  if (s.stopped || s.used >= MAX_TRADES) return { ok: false, kind: 'cap', used: s.used };
  if (!ritualDone()) return { ok: false, kind: 'ritual', used: s.used };
  if (s.open) return { ok: true, kind: 'inTrade', used: s.used, open: s.open };
  return { ok: true, kind: 'open', used: s.used };
}

export const northStar = () => read('cc_northstar', null);
export const routine = () => read('cc_rutina_dia', null);
export const saveRoutine = v => write('cc_rutina_dia', v);
