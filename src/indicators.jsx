import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { motion, useReducedMotion } from 'framer-motion'
import './index.css'

const T = {
  en: {
    back: 'TradeDadLog',
    eyebrow: 'TRADINGVIEW',
    title: 'Indicators',
    lead: 'Free indicators I use on my own charts. Open one to view it on TradingView and add it to your chart.',
    open: 'Open on TradingView',
    footNote: 'Made by a dad who trades',
  },
  es: {
    back: 'TradeDadLog',
    eyebrow: 'TRADINGVIEW',
    title: 'Indicadores',
    lead: 'Indicadores gratis que uso en mis propios gráficos. Abre uno para verlo en TradingView y agregarlo a tu chart.',
    open: 'Abrir en TradingView',
    footNote: 'Hecho por un papá que opera',
  },
}

const INDICATORS = [
  {
    url: 'https://www.tradingview.com/script/lgQ7YDfX-Multi-Session-Opening-Ranges/',
    title: 'Multi-Session Opening Ranges',
    sub: { en: 'Opening range highs and lows for multiple trading sessions, drawn on your chart.', es: 'Máximos y mínimos del rango de apertura de varias sesiones, dibujados en tu gráfico.' },
  },
  {
    url: 'https://www.tradingview.com/script/fnMlBX39-Initial-Balance-with-Dashboard/',
    title: 'Initial Balance with Dashboard',
    sub: { en: 'The Initial Balance range with a built-in stats dashboard.', es: 'El rango de Initial Balance con un dashboard de estadísticas integrado.' },
  },
]

function ChartIcon(p) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 17l5-5 3 3 4-6 3 4" /><path d="M3 21h18" /><path d="M3 3v18" />
    </svg>
  )
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } }
const item = (reduce) => ({
  hidden: { opacity: 0, y: reduce ? 0 : 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
})

function useLang() {
  const [lang, setLang] = useState(() => {
    try { const s = localStorage.getItem('tdl_lang'); if (s === 'en' || s === 'es') return s } catch (_) {}
    return 'en'
  })
  useEffect(() => {
    try { localStorage.setItem('tdl_lang', lang) } catch (_) {}
    document.documentElement.lang = lang
  }, [lang])
  return [lang, setLang]
}

function Page() {
  const [lang, setLang] = useLang()
  const reduce = useReducedMotion()
  const t = T[lang]

  return (
    <>
      <div className="bg-scene" />

      <div className="fixed right-4 top-[calc(env(safe-area-inset-top)+14px)] z-20 flex gap-0.5 rounded-full border border-hair bg-surface/70 p-[3px] backdrop-blur">
        {['en', 'es'].map((l) => (
          <button key={l} onClick={() => setLang(l)} className={`cursor-pointer rounded-full px-3 py-1.5 font-sans text-xs font-semibold transition-colors ${lang === l ? 'bg-gold text-ground' : 'text-muted hover:text-ink'}`}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <motion.main
        variants={container}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-[540px] px-[18px] pb-16 pt-[calc(env(safe-area-inset-top)+40px)]"
      >
        <motion.a variants={item(reduce)} href="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted no-underline transition-colors hover:text-ink">
          <span aria-hidden="true">&larr;</span> {t.back}
        </motion.a>

        <header className="mt-6">
          <motion.div variants={item(reduce)} className="inline-flex items-center rounded-full border border-a2/30 bg-a2/10 px-3 py-1.5 font-mono text-[10.5px] font-bold tracking-[0.14em] text-a2">
            {t.eyebrow}
          </motion.div>
          <motion.h1 variants={item(reduce)} className="mt-3 font-display text-[30px] font-bold tracking-tight text-ink">{t.title}</motion.h1>
          <motion.p variants={item(reduce)} className="mt-3 max-w-[440px] text-[15px] leading-relaxed text-muted">{t.lead}</motion.p>
        </header>

        <div className="mt-7 flex flex-col gap-3">
          {INDICATORS.map((d) => (
            <motion.a
              key={d.title}
              variants={item(reduce)}
              whileHover={reduce ? undefined : { y: -3 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26 }}
              href={d.url}
              target="_blank"
              rel="noopener"
              className="group flex items-center gap-4 rounded-2xl border border-hair bg-gradient-to-b from-surface/90 to-surface2/70 p-4 no-underline backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_12px_30px_-22px_rgba(0,0,0,0.7)] transition-[border-color,box-shadow] duration-200 hover:border-a2/50 hover:shadow-[0_18px_44px_-26px_var(--color-a2)]"
            >
              <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-a2/25 bg-a2/12 text-a2 shadow-[0_0_20px_-7px_currentColor]">
                <ChartIcon className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-[16px] font-bold leading-tight text-ink">{d.title}</span>
                <span className="mt-1 block text-[13px] leading-snug text-muted">{d.sub[lang] || d.sub.en}</span>
              </span>
              <span className="shrink-0 rounded-full bg-a2/15 px-2.5 py-1 font-mono text-[9px] font-bold tracking-wider text-a2">FREE</span>
              <svg className="size-4 shrink-0 text-faint transition-[transform,color] duration-200 group-hover:translate-x-0.5 group-hover:text-a2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 5l7 7-7 7" /></svg>
            </motion.a>
          ))}
        </div>

        <motion.footer variants={item(reduce)} className="mt-10 text-center text-xs leading-7 text-faint">
          <div>{t.footNote} · {new Date().getFullYear()}</div>
          <a href="https://x.com/TradeDadLog" target="_blank" rel="noopener" className="cursor-pointer text-muted no-underline hover:text-ink">x.com/TradeDadLog</a>
        </motion.footer>
      </motion.main>
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
