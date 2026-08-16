# TradeDadLog

Personal hub / link-in-bio for [@TradeDadLog](https://x.com/TradeDadLog): free, no-BS tools for disciplined traders.

- **Trading Journal** https://trading-jo.netlify.app/
- **Propfirm System Calculator** https://propfirm-calc.netlify.app/
- **TradingView Indicators** (coming soon)

## Stack
Vite + React + Tailwind CSS v4 + framer-motion. Bilingual (EN/ES, English default). Deployed on Netlify.

## Develop
```
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
```

## Add a tool
Edit the `TOOLS` (or `CONNECT`) array near the top of `src/App.jsx`: copy one object, set `title`, `sub` (en/es), `url`, `badge` and `icon`.

Static assets (og.png, apple-touch-icon.png) live in `public/`.
