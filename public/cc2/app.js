// Boot + wiring: polling, the symbol switch, the trade flow (enter -> exit -> pause) and the modals.
import { T, initLangToggle } from './i18n.js';
import { store, getSym, setSym, startPolling, symName, tickOf } from './api.js';
import { decide, fmt, levelList, NEAR_TICKS } from './decision.js';
import * as gate from './gate.js';
import * as ui from './ui.js';

const $ = id => document.getElementById(id);
let sym = getSym();
let last = null;   // last decision, for the modals

function render() {
  last = decide(sym);
  ui.renderSymBar(sym);
  ui.renderLive(sym);
  ui.renderPause();
  ui.renderDecision(last);
  ui.renderLevels(last);
  ui.renderCoach(sym);
  ui.renderNews();
  ui.renderDetails(sym, last);
  levelAlert(last);
}

/* ---------- sound ---------- */
let soundOn = true;
try { soundOn = localStorage.getItem('cc2_sound') !== 'off'; } catch (e) {}
let actx = null;
function beep(freqs) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.14;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.15);
    });
  } catch (e) {}
}
function paintSound() { $('soundBtn').setAttribute('aria-pressed', String(soundOn)); }

/* ---------- level proximity alert (once per level per hour) ---------- */
const alerted = {};
function levelAlert(d) {
  if (d.price == null) return;
  const near = NEAR_TICKS * tickOf(sym);
  levelList(sym, d.plan, d.trend).forEach(l => {
    if (Math.abs(l.px - d.price) > near) return;
    const key = sym + l.k + Math.round(l.px / near);
    if (alerted[key] && Date.now() - alerted[key] < 3600000) return;
    alerted[key] = Date.now();
    ui.toast(`<b>${d.name}</b> ${T('está cerca de', 'is near')} <b>${ui.esc(l.name)}</b> (${fmt(l.px, sym)}). ${T('Mira la reacción antes de hacer nada.', 'Watch the reaction before you do anything.')}`);
    beep([660, 880]);
  });
}

/* ---------- modals ---------- */
const modal = $('modal'), modalBody = $('modalBody');
let lastFocus = null;
function openModal(html, onReady) {
  lastFocus = document.activeElement;
  modalBody.innerHTML = html;
  modal.hidden = false;
  onReady && onReady();
  const f = modalBody.querySelector('input,button,textarea'); f && f.focus();
}
function closeModal() { modal.hidden = true; modalBody.innerHTML = ''; lastFocus && lastFocus.focus && lastFocus.focus(); }
modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

const QUESTIONS = () => [
  T('El precio está en uno de mis precios clave, no en el aire', 'Price is at one of my key prices, not in the air'),
  T('Vi mi señal de entrada (rechazo, recuperación, FVG o cambio de estructura)', 'I saw my entry signal (rejection, reclaim, FVG or structure shift)'),
  T('Va a favor de la respuesta de arriba', 'It goes with the answer above'),
  T('Mi stop ya está puesto antes de entrar', 'My stop is set before I enter'),
];
const phrase = () => T('SI QUIERO', 'I WANT IT');

function enterModal() {
  const d = last;
  let dir = d.dir > 0 ? 'LONG' : d.dir < 0 ? 'SHORT' : null;
  openModal(`
    <h3 id="modalTitle">${T('Chequeo rápido', 'Quick check')}</h3>
    <p>${T('Cuatro preguntas honestas antes de apretar el botón.', 'Four honest questions before you click.')}</p>
    <div class="box-k">${T('¿Hacia dónde vas?', 'Which way are you going?')}</div>
    <div class="dirpick" role="group">
      <button type="button" class="btn long" data-dir="LONG">${T('Arriba (largo)', 'Up (long)')}</button>
      <button type="button" class="btn short" data-dir="SHORT">${T('Abajo (corto)', 'Down (short)')}</button>
    </div>
    <ul class="checks">${QUESTIONS().map((q, i) => `<li><label><input type="checkbox" data-q="${i}">${q}</label></li>`).join('')}</ul>
    <div id="enterWarn"></div>
    <div class="modal-foot"><button type="button" class="btn" data-close>${T('Cancelar', 'Cancel')}</button><button type="button" class="btn primary" id="enterOk">${T('Entro', "I'm in")}</button></div>`, () => {
    const paint = () => {
      modalBody.querySelectorAll('[data-dir]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
      const all = [...modalBody.querySelectorAll('[data-q]')].every(c => c.checked);
      const reasons = [];
      if (!dir) reasons.push(T('Elige hacia dónde vas.', 'Pick which way you are going.'));
      else if (!d.dir) reasons.push(T('La respuesta de arriba dice que no hay trade claro.', 'The answer above says there is no clear trade.'));
      else if ((dir === 'LONG' ? 1 : -1) !== d.dir) reasons.push(T('Vas contra la dirección de hoy. Esta es tu fuga más cara.', "You're going against today's direction. This is your most expensive leak."));
      if (dir && d.tone !== 'pos' && d.dir) reasons.push(T('La respuesta todavía es esperar.', 'The answer is still to wait.'));
      if (!all) reasons.push(T('No marcaste las 4 preguntas.', "You didn't check all 4 questions."));
      const needPhrase = dir && reasons.length > 0;
      $('enterWarn').innerHTML = reasons.length ? `<div class="warnbox">${reasons.map(r => '· ' + r).join('<br>')}${needPhrase ? `<br><br>${T('Si de verdad quieres entrar, escribe', 'If you really want in, type')} <code>${phrase()}</code>
        <input class="input" id="phraseIn" autocomplete="off" spellcheck="false" style="margin-top:8px" aria-label="${T('Frase de confirmación', 'Confirmation phrase')}">` : ''}</div>` : '';
      $('enterOk').disabled = !dir;
      $('enterOk').textContent = needPhrase ? T('Entrar de todos modos', 'Enter anyway') : T('Entro', "I'm in");
    };
    modalBody.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => { dir = b.dataset.dir; paint(); }));
    modalBody.querySelectorAll('[data-q]').forEach(c => c.addEventListener('change', paint));
    $('enterOk').addEventListener('click', () => {
      const pin = $('phraseIn');
      if (pin && pin.value.trim().toUpperCase() !== phrase()) { pin.style.borderColor = 'var(--neg)'; pin.focus(); return; }
      gate.startTrade(dir, !!pin);
      closeModal(); render();
    });
    paint();
  });
}

function exitModal(result) {
  const win = result === 'win';
  openModal(`
    <h3 id="modalTitle">${win ? T('Cerraste ganando', 'You closed a winner') : T('Cerraste perdiendo', 'You closed a loser')}</h3>
    <p>${T('¿Cuánto fue? Es opcional, sirve para tu resumen del día.', 'How much was it? Optional, it goes into your day summary.')}</p>
    <label class="box-k" for="pnlIn">${T('Resultado en dólares', 'Result in dollars')}</label>
    <input class="input mono" id="pnlIn" type="number" inputmode="decimal" step="1" min="0" placeholder="${win ? '1494' : '275'}" style="margin-top:6px">
    <div class="modal-foot"><button type="button" class="btn" data-close>${T('Cancelar', 'Cancel')}</button><button type="button" class="btn primary" id="exitOk">${T('Guardar y tomar mi pausa', 'Save and take my pause')}</button></div>`, () => {
    const go = () => {
      const v = parseFloat($('pnlIn').value);
      const pnl = isFinite(v) ? (win ? Math.abs(v) : -Math.abs(v)) : NaN;
      gate.closeTrade(result, pnl, sym);
      closeModal(); beep(win ? [660, 880] : [300, 220]); render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    $('exitOk').addEventListener('click', go);
    $('pnlIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

function ritualModal() {
  const items = [
    T('Tengo mi plan del día escrito: dirección y niveles', "I have today's plan written: direction and levels"),
    T('Mi límite de pérdida diaria está puesto en la cuenta', 'My daily loss limit is set on the account'),
    T('Máximo ' + gate.MAX_TRADES + ' trades. El siguiente no existe', 'Max ' + gate.MAX_TRADES + ' trades. The next one does not exist'),
    T('Estoy tranquilo, no vengo a recuperar nada', "I'm calm, I'm not here to win anything back"),
  ];
  openModal(`
    <h3 id="modalTitle">${T('Rutina antes de la sesión', 'Pre-session routine')}</h3>
    <p>${T('En frío, antes de abrir el gráfico. Aquí decides lo que en caliente no vas a poder decidir.', "Cold, before you open the chart. Here you decide what you won't be able to decide in the heat of the moment.")}</p>
    <ul class="checks">${items.map((q, i) => `<li><label><input type="checkbox" data-r="${i}">${q}</label></li>`).join('')}</ul>
    <div class="modal-foot"><button type="button" class="btn" data-close>${T('Ahora no', 'Not now')}</button><button type="button" class="btn primary" id="ritualOk" disabled>${T('Listo, a ejecutar', "Ready, let's execute")}</button></div>`, () => {
    const boxes = [...modalBody.querySelectorAll('[data-r]')];
    boxes.forEach(b => b.addEventListener('change', () => { $('ritualOk').disabled = !boxes.every(x => x.checked); }));
    $('ritualOk').addEventListener('click', () => { gate.setRitualDone(); closeModal(); render(); });
  });
}

/* ---------- events ---------- */
function switchSym(s) {
  if (!s || s === sym) return;
  sym = s; setSym(s);
  render(); poll.refreshSym();
}
$('symBar').addEventListener('click', e => { const b = e.target.closest('[data-sym]'); if (b) switchSym(b.dataset.sym); });
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn; try { localStorage.setItem('cc2_sound', soundOn ? 'on' : 'off'); } catch (e) {}
  paintSound(); if (soundOn) beep([880]);
});
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a) {
    const act = a.dataset.act;
    if (act === 'enter') enterModal();
    else if (act === 'exit-win') exitModal('win');
    else if (act === 'exit-loss') exitModal('loss');
    else if (act === 'cancel-trade') { const s = gate.day(); delete s.open; localStorage.setItem('cc_portero_dia', JSON.stringify(s)); render(); }
    else if (act === 'ritual') ritualModal();
    else if (act === 'end-pause' && !a.disabled) { gate.endPause(); render(); }
  }
  const sp = e.target.closest('[data-sym-pick]');
  if (sp) { switchSym(sp.dataset.symPick); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'pauseNote') { gate.setPauseNote(e.target.value); ui.tickPause(); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.routine;
  if (!k) return;
  const r = gate.routine(); const today = gate.day().date;
  const rt = r && r.date === today ? r : { date: today };
  rt[k] = e.target.checked; gate.saveRoutine(rt);
});
// another tab (or the classic view) changed the day state
window.addEventListener('storage', e => { if (e.key && /^cc_(portero_dia|sym|ritual_dia)|^cc2_pause/.test(e.key)) { sym = getSym(); render(); } });

/* ---------- boot ---------- */
initLangToggle(render);
paintSound();
const poll = startPolling(() => { if (!document.hidden) render(); });
render();
ui.renderClock();
setInterval(() => {
  ui.renderClock();
  if (gate.pause()) ui.tickPause();
}, 1000);
// minute tick: live age, news window, pause expiry
setInterval(() => { if (!document.hidden) render(); }, 30000);
document.querySelector('.wrap').classList.add('enter');
window.__cc2 = { store, decide: () => decide(sym), sym: () => symName(sym) };
