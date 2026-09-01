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

Both modes end by writing a dated report and updating state + backlog. No destructive git.

---

## The cycle (do every run, in order)

### 1. Load the brain
Read, in full, before doing anything else:
- `x-growth-reports/_voice-profile.md` — voice, the two validated formats, rejected patterns, reference accounts.
- `x-growth-reports/_content-ideas-backlog.md` — open ideas already sourced from real comments.
- `x-growth-reports/_state.md` — accumulated learnings, the draft scorecard, running hypotheses.
- The most recent `x-growth-reports/<date>-report.md` (last week's 3 drafts), if any.

### 2. Adoption check (did last week's drafts get used, and did they work?)
For each of last week's 3 drafts, mark **ADOPTED** (with the real post URL + its metrics) or
**NOT ADOPTED**. If adopted, judge honestly: did it perform above or below this account's
median? Feed the verdict into `_state.md` — this is how the agent gets sharper over time.
First run ever: skip and say so.

### 3. Self-performance check (what's landing on YOUR account)
- INTERACTIVE: open Jesus's last 5-7 posts by their status URL (`x.com/TradeDadLog/status/<id>`),
  record views / likes / replies / reposts, and read the top 2-3 replies on each. Even logged
  out this works via direct status URLs. Rank best to worst. For each, hypothesize *why* using
  the two formats in the voice profile, not vibes.
- CLOUD: read this from the latest `live/x-snapshot.md` instead.
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

### 5. Draft exactly 3 posts
- Prefer drafting from an OPEN idea in the backlog when one fits; otherwise a universal trading
  mistake per the voice profile. Never fabricate personal anecdotes or dollar figures — if
  there's no real anchor Jesus gave, stay universal.
- Each of the 3 must use a **different structural format** from the other two (rotate: aphorism,
  real-time confession, "Don't be like me!", self-quote thread, community question, truth-bomb,
  victory+personal). Never ship two of the same template in one batch — this was explicitly
  rejected before.
- For each draft include: the post text, which format it is, which idea/source it came from,
  and one line on why it should land (which lever it pulls).
- Mark any backlog idea you used as `[USED YYYY-MM-DD]`.

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
- `x-growth-reports/<YYYY-MM-DD>-report.md`: the adoption check, the ranked self-performance
  read, the niche findings (with the "how we beat it" line each), and the 3 drafts.
- Update `x-growth-reports/_content-ideas-backlog.md` (new ideas added, used ones marked).
- Update `x-growth-reports/_state.md` (scorecard + any new learning about what works).
- INTERACTIVE mode also refreshes `x-growth-reports/live/x-snapshot.md` with the raw metrics +
  top comments it just read, dated, so CLOUD mode has fresh data to work from.

### 8. Commit + push
- INTERACTIVE (this machine): normal `git add -A && git commit && git push` — local credentials work.
- CLOUD: `git add -A`, commit, then a pull-rebase-push retry loop (6 tries). If push still fails
  **and** an `X_BUS_TOKEN` env var exists, upload each changed file via the GitHub Contents API
  (same fallback pattern the Session Analyst uses). Verify with `git log origin/main -1`.

### 9. Report back to Jesus (Spanish, short)
Lead with the single best draft. Then the other two. Then, in 3-4 lines: what's working on his
account right now, one thing to stop doing, and one idea to watch. No filler. Be the demanding
coach, not a cheerleader.

---

## Hard rules (never violate)
1. No em dashes in anything meant to be published. Ever.
2. Never invent dollar figures, account counts, or personal stories. Universal or real, nothing in between.
3. Never copy or closely paraphrase another account. Mechanism only, execution 100% original + more personal.
4. Never blame an external cause (a copy-trade tool, a broker, "the market"). It reads as an excuse and kills the voice.
5. Stay in the trading-pain lane. General life hardship underperforms here (proven: 1.1K vs 5K-83K views).
6. Every batch rotates formats. No repeated template.
7. The output must be able to pass as written by Jesus at his desk. If it smells like AI, it does not ship.
