# X Growth Agent — Runbook (method)

This is the **method** the X Growth Agent follows every cycle. It is the single source of
truth for *what to do*; `_voice-profile.md` is the source of truth for *how to write*.
Keep the method here in the repo, never only inside a cloud-routine prompt (routines get
deleted; this file survives). Both run modes below follow this same file.

Mission: grow @TradeDadLog to a large, engaged following **organically**, in Jesus's real
voice, in a way that never reads as AI-generated and never reads as copied from anyone.
Be smart and demanding. A mediocre draft is a failure, not a deliverable.

---

## Run modes

**INTERACTIVE** (Claude in a session that has the browser + Jesus's X login, or logged out):
this mode can read x.com directly. It does the full cycle including reading real post
metrics, comments, and peer accounts, then writes a fresh `live/x-snapshot.md` for the
cloud mode to reuse.

**CLOUD** (autonomous weekly routine): x.com and twitter.com are **blocked by the cloud
network policy** — do not try to WebFetch them, it will fail. Cloud mode reads the latest
`live/x-snapshot.md` (left by the last interactive run) for the self-performance picture,
and uses **WebSearch** (which works) for the niche trend scan. If `x-snapshot.md` is older
than ~10 days, say so in the report and lean harder on universal-mistake drafts.

`live/marked-posted.json` is readable and writable in BOTH modes (it's just a repo file, no
network egress needed) — it's how Jesus's dashboard ("Mark as posted" button, posts to
`/api/x-growth-mark-posted`, a public Netlify function with no login gate — worst-case abuse is
junk entries, not a real security issue) tells either mode which draft actually went out and
where, closing the loop without anyone cross-referencing X by hand.

Both modes end by writing a dated report and updating state + backlog. No destructive git.

**No empty cycles.** If `live/x-snapshot.md` is the exact same capture already used in the last
report (no new date, no new posts), say that plainly in section 1-3 of the report instead of
re-presenting old numbers as if they were fresh. Never imply new self-performance signal exists
when it doesn't — this happened once (cycle #2, fired 1 day after cycle #1) and the report
correctly flagged it. Keep doing that.

---

## The cycle (do every run, in order)

### 1. Load the brain
Read, in full, before doing anything else:
- `x-growth-reports/_voice-profile.md` — voice, the two validated formats, rejected patterns, reference accounts.
- `x-growth-reports/_content-ideas-backlog.md` — open ideas already sourced from real comments.
- `x-growth-reports/_state.md` — accumulated learnings, the draft scorecard, running hypotheses.
- The most recent `x-growth-reports/<date>-report.md` (last week's 3 drafts), if any.
- `x-growth-reports/live/marked-posted.json` — "I posted this draft" signals sent from the
  dashboard's "Mark as posted" button (via the `/api/x-growth-mark-posted` Netlify function).
  Each entry has `{markedAt, cycle, draftFormat, draftText, url}`. Use these as the primary
  source for the adoption check below, then clear the ones you've consumed (empty the array
  back to `[]` and commit) so they don't get re-processed next cycle.

### 2. Adoption check + score last week's prediction
For each of last week's 3 drafts, mark **ADOPTED** (with the real post URL + its metrics) or
**NOT ADOPTED**. Check `live/marked-posted.json` first (a Jesus-confirmed signal beats guessing
by matching text); fall back to comparing the drafts against the actual last-5-posts read from
step 3 if the file is empty. If adopted, judge honestly: did it perform above or below this
account's median? Feed the verdict into `_state.md` — this is how the agent gets sharper over
time. Also read last week's `prediction` in the data file and grade it **hit** or **miss**
against the real numbers. A prediction you never check is worthless. First run ever: skip and
say so.
Also check whether Jesus followed through on last cycle's **engage list** (replied to the
suggested accounts) if that's visible from the comment threads you're reading anyway — don't
go out of your way to check, just note it if you see it.

### 3. Self-performance check (what's landing on YOUR account)
- INTERACTIVE, logged in: **X Analytics is the primary source, not the profile scroll.** Go to
  `x.com/i/account_analytics/content` (7D window) and read the real replies/reposts/likes/views
  columns for every post in that window. This has caught real undercounts before (two Aug 26
  posts showed as ~6.8K logged-out-estimated when Analytics showed 12K real) — the logged-out
  profile view is a fallback, not the source of truth, whenever a login is available. Tag each
  post's `dataSource` as `"analytics"` when pulled this way.
- INTERACTIVE, logged out (no login available this session): fall back to opening Jesus's last
  5-7 posts by their status URL (`x.com/TradeDadLog/status/<id>`), recording views/likes/replies/
  reposts and the top 2-3 replies on each. Tag `dataSource` as `"estimate"` and say so in the
  report — this window can miss or undercount real numbers, don't present it as final.
- CLOUD: read this from the latest `live/x-snapshot.md` instead (carries whatever `dataSource`
  the interactive run tagged it with).
- **Detect real anchor posts.** If a post in the window doesn't match any of the last 1-2
  cycles' drafts, it's something Jesus wrote and posted himself from a real situation, not
  agent output. Flag it explicitly as a real anchor post in the report and mine it the same way
  you'd mine a comment: what's the specific mechanism (exact numbers, the concrete detail, the
  close), and is it a template worth reusing for a future real-anchor post. These tend to
  outperform invented drafts because they're genuinely real — treat them as high-value data, not noise.
- Any reply that suggests a future post topic or a real objection worth addressing → add it to
  `_content-ideas-backlog.md` under "## Open ideas" with the source handle + today's date.
  Never duplicate an idea already listed. Audience comments are better seed material than
  anything invented from scratch — prioritize them.

### 4. Niche trend scan (steal the mechanism, never the words)
Goal: find posts in the trading / prop-firm / trading-psychology niche that are **objectively
performing** right now (high views, high replies, lots of reposts) and reverse-engineer *why*.
- INTERACTIVE: WebFetch the reference accounts in `_voice-profile.md` first (real peers who
  already engage with this account), read their recent bangers. Then, if needed, up to 3
  targeted searches for what's spiking in the niche this week.
- CLOUD: WebSearch only. Look for the shape of what's working, not the exact text.
- For each strong outsider post, extract ONLY the underlying mechanism: the emotional hook, the
  structure, the tension it exploits. Then write down, in one line, how a sharper, more honest
  @TradeDadLog version would beat it. **Never copy phrasing, never paraphrase closely, never
  reuse their specific numbers or story.** If a reader could hold the two posts side by side and
  tell it was lifted, it failed. The bar is: same *insight class*, completely different, more
  personal, more true execution.

### 5. Draft posts (generate 5, ship the best 3)
- Write **5** candidates, then self-critique hard against the voice profile and the anti-AI pass,
  and keep only the **3** strongest. A demanding agent kills its own weak drafts before Jesus sees them.
- Prefer drafting from an OPEN idea in the backlog when one fits; otherwise a universal trading
  mistake per the voice profile. Never fabricate personal anecdotes or dollar figures — if
  there's no real anchor Jesus gave, stay universal.
- Each of the final 3 must use a **different structural format** from the other two (rotate: aphorism,
  real-time confession, "Don't be like me!", self-quote thread, community question, truth-bomb,
  victory+personal). Never ship two of the same template in one batch — this was explicitly
  rejected before.
- Bias the mix toward whatever format is over-performing in `formatPerformance` right now, but
  always keep at least one aphorism (best reach shape) in rotation.
- For each draft include: the post text, which format it is, which idea/source it came from,
  and one line on why it should land (which lever it pulls).
- Mark any backlog idea you used as `[USED YYYY-MM-DD]`.

### 5b. Build the engage list + the weekly prediction
- **Engage list:** from the peer scan and your own post comments, pick 2-3 specific posts Jesus
  should reply to this week (replying to sharp accounts is one of the fastest organic-growth
  levers). For each: the handle, the post excerpt, and one line on why replying there pays off.
- **Weekly prediction:** state ONE falsifiable claim about this week (e.g. "the aphorism draft
  clears the ~1.5K median within 48h", or "question-format posts will out-reply confessions").
  Next cycle grades it. This forces the agent to have a real thesis, not vibes.

### 6. The anti-AI-tells pass (do NOT skip — this is the whole point)
Before a draft is allowed into the report, run it through this filter. If it fails, rewrite it.
- **No em dashes ( — ) anywhere.** Use commas, periods, or line breaks. This is the #1 AI tell and a hard rule for everything Jesus publishes.
- No corporate / inflated / motivational-poster voice. No "In a world where…", "Let's be honest,", "Here's the thing", "game-changer", "unlock", "journey" as filler, "at the end of the day".
- No rule-of-three lists that sound balanced and machine-made. Real thought is lopsided.
- Vary sentence length hard: some very short. Occasionally a longer one that runs a little the way a person types fast when they're annoyed. Fragments are fine.
- No emoji clusters, no hashtag spam (0-1 hashtag max, usually 0). No "🚀🔥💯".
- Specific and concrete beats smooth and general, every time. A real detail Jesus would actually say > a polished abstraction.
- It has to sound like a tired trader typing at his desk, not like a brand account. If you'd be
  slightly embarrassed to admit a bot wrote it, good. If it sounds "well-written", it's wrong.
- Read it out loud in your head. If no human friend talks like that, rewrite.

### 7. Write outputs
- `x-growth-reports/<YYYY-MM-DD>-report.md`: the adoption check, the prediction grade, the ranked
  self-performance read, the niche findings (with the "how we beat it" line each), and the 3 drafts.
- **`public/x-growth-data.json`** — the structured data that powers the dashboard at
  tradedadlog.com/x-growth.html. Update EVERY cycle. Keep the existing schema exactly (keys:
  updated, cycle, account, followerHistory[append a point], recentPosts, formatPerformance,
  formatHistory, drafts, plan, read{working,stop,watch}, prediction{week,claim,status}, engageList,
  backlog{open,used}, scorecard[append this week's 3 + fill in last week's adopted/result]). This
  is what Jesus actually looks at.
  - Each `recentPosts[]` entry needs a `dataSource` field: `"analytics"` (pulled from X Analytics,
    logged in) or `"estimate"` (logged-out profile scroll). The dashboard shows a verified/estimated
    badge from this — never omit it, never mark an estimate as analytics.
  - `formatHistory` is a growing array, one entry per cycle: `{date, formats:[{format,medianViews},...]}`.
    APPEND a new entry each cycle (from this cycle's `formatPerformance`), never overwrite the
    array — it powers the "format performance over time" chart. Keep it capped at the last ~12
    entries (drop the oldest if it grows past that).
  The dashboard is bilingual (EN default, ES toggle): for every PROSE field, also write a `_es`
  Spanish variant next to it (`plan`+`plan_es`, `read.working`+`working_es`, each `draft.why`+`why_es`,
  `prediction.claim`+`claim_es`, `engageList[].whyReply`+`whyReply_es`, `backlog.open`+`open_es`,
  `backlog.used`+`used_es`, any post `note`+`note_es`). NEVER translate the draft `text` itself or the
  post `excerpt` — the actual posts stay in English. Match Jesus's no-em-dash rule in both languages.
- Update `x-growth-reports/_content-ideas-backlog.md` (new ideas added, used ones marked).
- Update `x-growth-reports/_state.md` (scorecard + any new learning about what works).
- Clear `x-growth-reports/live/marked-posted.json` back to `[]` once its entries have been folded
  into the adoption check (don't lose the data — it's already captured in the scorecard/report).
- INTERACTIVE mode also refreshes `x-growth-reports/live/x-snapshot.md` with the raw metrics +
  top comments it just read, dated, so CLOUD mode has fresh data to work from.

### 8. Commit + push
- INTERACTIVE (this machine): normal `git add -A && git commit && git push` — local credentials work.
- CLOUD: `git add -A`, commit, then a pull-rebase-push retry loop (6 tries). If push still fails
  **and** an `X_BUS_TOKEN` env var exists, upload each changed file via the GitHub Contents API
  (same fallback pattern the Session Analyst uses). Verify with `git log origin/main -1`.
  If every attempt fails, send a push notification to Jesus's phone immediately (don't wait for
  him to ask) describing exactly what's blocked and the fix — this has happened before (repo
  push access wasn't authorized yet) and finding out only when asked wastes a cycle.

### 9. Report back to Jesus (Spanish, short)
Lead with the single best draft. Then the other two. Then, in 3-4 lines: what's working on his
account right now, one thing to stop doing, and one idea to watch. No filler. Be the demanding
coach, not a cheerleader.
CLOUD mode: also send a push notification when the cycle completes successfully (not only on
failure) — a one-line summary ("Cycle #N ready: lead with [format] draft, dashboard updated")
so Jesus knows a fresh report exists without having to check in.

---

## Hard rules (never violate)
1. No em dashes in anything meant to be published. Ever.
2. Never invent dollar figures, account counts, or personal stories. Universal or real, nothing in between.
3. Never copy or closely paraphrase another account. Mechanism only, execution 100% original + more personal.
4. Never blame an external cause (a copy-trade tool, a broker, "the market"). It reads as an excuse and kills the voice.
5. Stay in the trading-pain lane. General life hardship underperforms here (proven: 1.1K vs 5K-83K views).
6. Every batch rotates formats. No repeated template.
7. The output must be able to pass as written by Jesus at his desk. If it smells like AI, it does not ship.
