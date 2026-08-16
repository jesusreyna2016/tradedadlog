import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

/* ---------------- i18n (English default, no browser autodetect) ---------------- */
const T = {
  en: {
    tagline: "Futures trader and a dad. I build free, no-BS tools to trade with discipline, and I share everything I make.",
    sTools: "TOOLS",
    sConnect: "CONNECT",
    sStory: "MY STORY",
    story: [
      "I'm a futures trader and a dad. A few years in, I realized my real problem was never analysis, it was my own discipline, and the debt that made every loss feel heavier.",
      "I couldn't afford the fancy tools, so I started building the ones I actually needed. Now I give them away. If they help you keep more of your account and trade calmer, that's the whole point.",
    ],
    footNote: "Made by a dad who trades",
    live: "LIVE",
    soon: "SOON",
  },
  es: {
    tagline: "Trader de futuros y papá. Construyo herramientas gratis y sin humo para operar con disciplina, y comparto todo lo que hago.",
    sTools: "HERRAMIENTAS",
    sConnect: "CONECTA",
    sStory: "MI HISTORIA",
    story: [
      "Soy trader de futuros y papá. Con el tiempo entendí que mi problema real nunca fue el análisis, era mi propia disciplina, y las deudas que hacían cada pérdida más pesada.",
      "No podía pagar las herramientas caras, así que empecé a construir las que de verdad necesitaba. Ahora las regalo. Si te ayudan a conservar más de tu cuenta y operar con más calma, esa es toda la idea.",
    ],
    footNote: "Hecho por un papá que opera",
    live: "EN VIVO",
    soon: "PRONTO",
  },
}

/* ---------------- icons (SVG, no emoji) ---------------- */
const Icon = {
  journal: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 20h16" /><rect x="5" y="12" width="3.4" height="6" rx="1" /><rect x="10.3" y="7" width="3.4" height="11" rx="1" /><rect x="15.6" y="4" width="3.4" height="14" rx="1" />
    </svg>
  ),
  calc: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8" /><path d="M8 11h0M12 11h0M16 11h0M8 15h0M12 15h0M16 15h0" />
    </svg>
  ),
  chart: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 17l5-5 3 3 4-6 3 4" /><path d="M3 21h18" /><path d="M3 3v18" />
    </svg>
  ),
  x: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  ),
}

/* ---------------- data (add tools here as you ship them) ---------------- */
const TOOLS = [
  {
    icon: 'journal', tone: 'pos', url: 'https://trading-jo.netlify.app/', badge: 'live',
    title: 'Trading Journal',
    sub: { en: 'Free discipline-first journal: leaks, tilt score, routine and calendar.', es: 'Journal gratis centrado en disciplina: fugas, score de tilt, rutina y calendario.' },
  },
  {
    icon: 'calc', tone: 'gold', url: 'https://propfirm-calc.netlify.app/', badge: 'live',
    title: 'Propfirm System Calculator',
    sub: { en: 'Accounts to hit your goal, Monte Carlo blow-up risk, real net after tax and pipeline.', es: 'Cuentas para tu meta, riesgo de blow-up Monte Carlo, neto real tras impuestos y pipeline.' },
  },
  {
    icon: 'chart', tone: 'a2', url: null, badge: 'soon',
    title: 'TradingView Indicators',
    sub: { en: 'Pine scripts for bias, sessions, ORB and discipline. Dropping soon.', es: 'Scripts Pine de sesgo, sesiones, ORB y disciplina. Muy pronto.' },
  },
]
const CONNECT = [
  {
    icon: 'x', tone: 'plain', url: 'https://x.com/TradeDadLog', badge: null, ext: true,
    title: 'Follow on X',
    sub: { en: 'Trades, lessons and new tools as I ship them.', es: 'Trades, lecciones y herramientas nuevas apenas las publico.' },
  },
]

const toneRing = {
  pos: 'text-pos bg-pos/12 border-pos/25',
  gold: 'text-gold bg-gold/12 border-gold/25',
  a2: 'text-a2 bg-a2/12 border-a2/25',
  plain: 'text-ink bg-white/5 border-hair',
}

/* ---------------- animation ---------------- */
const container = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.06 } } }
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

function LinkCard({ data, lang, reduce, t }) {
  const IconEl = Icon[data.icon]
  const sub = data.sub[lang] || data.sub.en
  const badge = data.badge === 'live'
    ? <span className="shrink-0 rounded-full bg-pos/15 px-2.5 py-1 font-mono text-[9px] font-bold tracking-wider text-pos">{t.live}</span>
    : data.badge === 'soon'
      ? <span className="shrink-0 rounded-full bg-gold/15 px-2.5 py-1 font-mono text-[9px] font-bold tracking-wider text-gold">{t.soon}</span>
      : null

  const inner = (
    <>
      <span className={`grid size-12 shrink-0 place-items-center rounded-xl border ${toneRing[data.tone]}`}>
        <IconEl className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[16px] font-bold leading-tight text-ink">{data.title}</span>
        <span className="mt-1 block text-[13px] leading-snug text-muted">{sub}</span>
      </span>
      {badge}
      {data.url && (
        <svg className="size-4 shrink-0 text-faint transition-[transform,color] duration-200 group-hover:translate-x-0.5 group-hover:text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 5l7 7-7 7" /></svg>
      )}
    </>
  )

  const base = 'group flex items-center gap-4 rounded-2xl border border-hair bg-surface/80 p-4 backdrop-blur-sm'

  if (!data.url) {
    return (
      <motion.div variants={item(reduce)} className={`${base} opacity-70`}>{inner}</motion.div>
    )
  }
  return (
    <motion.a
      variants={item(reduce)}
      whileHover={reduce ? undefined : { y: -3 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      href={data.url}
      {...(data.ext ? { target: '_blank', rel: 'noopener' } : {})}
      className={`${base} cursor-pointer no-underline transition-colors duration-200 hover:border-gold/50`}
    >
      {inner}
    </motion.a>
  )
}

function SectionLabel({ children }) {
  return (
    <motion.div variants={item(false)} className="mt-8 mb-3 flex items-center gap-3 px-1">
      <span className="font-mono text-[10.5px] font-bold tracking-[0.16em] text-faint">{children}</span>
      <span className="h-px flex-1 bg-hair" />
    </motion.div>
  )
}

export default function App() {
  const [lang, setLang] = useLang()
  const reduce = useReducedMotion()
  const t = T[lang]

  return (
    <>
      <div className="bg-scene" />

      {/* language toggle */}
      <div className="fixed right-4 top-[calc(env(safe-area-inset-top)+14px)] z-20 flex gap-0.5 rounded-full border border-hair bg-surface/70 p-[3px] backdrop-blur">
        {['en', 'es'].map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            className={`cursor-pointer rounded-full px-3 py-1.5 font-sans text-xs font-semibold transition-colors ${lang === l ? 'bg-gold text-ground' : 'text-muted hover:text-ink'}`}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <motion.main
        variants={container}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-[540px] px-[18px] pb-16 pt-[calc(env(safe-area-inset-top)+48px)]"
      >
        {/* cover photo */}
        <motion.div variants={item(reduce)} className="relative overflow-hidden rounded-2xl border border-hair shadow-[0_18px_40px_-22px_rgba(0,0,0,0.7)]">
          <img src="/family.jpg" alt="Sunset at the lake with my two boys" loading="eager" className="block h-[200px] w-full object-cover" style={{ objectPosition: 'center 46%' }} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28" style={{ background: 'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-ground) 78%, transparent))' }} />
        </motion.div>
        {/* header */}
        <header className="text-center">
          <motion.div variants={item(reduce)} className="relative z-10 mx-auto -mt-12 mb-4 size-[96px] overflow-hidden rounded-full border-2 border-gold/45 ring-[6px] ring-ground shadow-[0_20px_44px_-18px_rgba(0,0,0,0.7)]">
            <img src="/avatar.jpg" alt="Jesus with his family at the lake" className="size-full object-cover" style={{ objectPosition: 'center 30%' }} />
          </motion.div>
          <motion.h1 variants={item(reduce)} className="font-display text-[28px] font-bold tracking-tight text-ink">TradeDadLog</motion.h1>
          <motion.div variants={item(reduce)} className="mt-1.5">
            <a href="https://x.com/TradeDadLog" target="_blank" rel="noopener" className="cursor-pointer font-mono text-sm font-semibold text-gold no-underline hover:text-goldlite">@TradeDadLog</a>
          </motion.div>
          <motion.p variants={item(reduce)} className="mx-auto mt-4 max-w-[400px] text-[15px] leading-relaxed text-muted">{t.tagline}</motion.p>
        </header>

        {/* tools */}
        <SectionLabel>{t.sTools}</SectionLabel>
        <div className="flex flex-col gap-3">
          {TOOLS.map((d) => <LinkCard key={d.title} data={d} lang={lang} reduce={reduce} t={t} />)}
        </div>

        {/* connect */}
        <SectionLabel>{t.sConnect}</SectionLabel>
        <div className="flex flex-col gap-3">
          {CONNECT.map((d) => <LinkCard key={d.title} data={d} lang={lang} reduce={reduce} t={t} />)}
        </div>

        {/* footer */}
        <motion.footer variants={item(reduce)} className="mt-9 text-center text-xs leading-7 text-faint">
          <div>{t.footNote} · {new Date().getFullYear()}</div>
          <a href="https://x.com/TradeDadLog" target="_blank" rel="noopener" className="cursor-pointer text-muted no-underline hover:text-ink">x.com/TradeDadLog</a>
        </motion.footer>
      </motion.main>
    </>
  )
}
