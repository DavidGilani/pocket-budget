# CLAUDE.md — Pocket Ledger

Guidance for Claude when working in this repo. Read this first.

## What this is
**Pocket Ledger** (internal Dexie DB name `PocketLedger`; SW cache `pocket-ledger-vN`) is a
personal-finance **PWA** for a single household. It tracks a daily spending
allowance, recurring income/expenses, big one-off costs spread across a date
range, net wealth across accounts, and a set of "financial goals" trackers
(mortgage, Help to Buy, investments, charity, pension). It also holds a bespoke
**Bank of Gilulu** ledger for money held on behalf of friends/family, with
interest. Built by David Gilani for personal use. Hosted on **GitHub Pages from
`main`** and installed to the home screen on phone + desktop.

The core idea: instead of a monthly budget, the app computes a **daily
allowance** and a **rolling balance** — "am I ahead or behind today?" — after
accounting for recurring items, savings targets, and big expenses smeared evenly
across their date range so they don't distort any single day.

## Architecture (keep to this)
- **Vanilla JS, ES modules, no build step, no framework.** Do not introduce a
  bundler, TypeScript, or a UI framework. Match the surrounding style.
- **Files:**
  - `index.html` — shell + failsafe SW registration + CDN script tags.
  - `js/app.js` — **the whole UI** (~6k lines): every `render*` view, every
    `open*` bottom-sheet editor, navigation, gestures. This is where almost all
    feature work happens.
  - `js/db.js` — Dexie schema (versioned `db.version(N).stores(...)`), the
    `SEED_CATEGORIES` / `SEED_ACCOUNTS` seed data, and `initDB`.
  - `js/engine.js` — pure budget maths: daily allowance, rolling balance, cycle
    breakdown, and `generateDistributionChildren` (big-expense day slices).
  - `js/utils.js` — date/money helpers (`today`, `addDays`, `diffDays`,
    `fmt`, `fmtDate`, `cycleForDate`, `delegate`, …). Prefer these over inline
    re-implementations.
  - `js/firebase.js` — Firebase app/auth/Firestore init and re-exports.
  - `js/sync.js` — Firestore sync (see **Sync model** below).
  - `css/app.css` — all styles.
  - `sw.js` — service worker (cache-first app shell + CDN).
  - `migrate/extract.py` — one-off local importer for legacy data (not in CI).
- **Runtime deps via CDN** (cached by the SW): Dexie 3.2.4 and Chart.js 4.4.0.
  Charts use Chart.js; there is no hand-rolled SVG charting here.
- **Local-first storage:** everything lives in **IndexedDB via Dexie**. Firestore
  is an optional cloud mirror for multi-device sync, not the source of truth.

## Navigation & UI patterns
- `navigate(view, params, isBack)` drives all screen changes; `renderView` is a
  `switch` over view keys → `render<View>()`. A `navStack` records history so the
  top-left back button (`goBack()`) returns where the user actually came from
  (e.g. Daily Budget vs Settings). `scrollPositions` saves/restores scroll.
- **Swipe-right from the left edge** = back, on pages listed in the `BACKABLE`
  set inside `enableSwipeBack()`. Add new back-capable views there.
- **Bottom sheets** (`.sheet-overlay` / `.sheet`) are the standard editor UI.
  Reuse the shared pickers: `openDatePicker(currentDate, maxDate, onSelect)`
  (tap a day to select & close), `openAmountPad` / numpad, `openCategoryPicker`.
- **Transaction logging** (`openEntry`) is unified: the same sheet logs a normal
  expense/income and — via the compact **"Distribute over multiple days"**
  toggle beneath the note — a big expense / extra income. Editing a big expense
  or extra income opens this same sheet with the toggle pre-flicked. Keep these
  consistent: one layout for all four cases.
- **Priority: the whole logging interface must fit without scrolling.** When
  adding fields to `openEntry`, keep it compact.

## Domain model (key tables)
- `transactions` — variable income/expenses. Types: `expense`, `income`,
  and the auto-generated `distributed_expense` / `distributed_income`.
- `distributions` — a "big expense" or "extra income": a total spread over
  `[startDate, endDate]`. Its per-day slices are **child transactions** carrying
  a `distributionId`.
- `categories` — `isIncome` and `isArchived` flags decide which picker a category
  appears in. Seeded from `SEED_CATEGORIES`; **existing installs need a data
  migration** to change categories (see below).
- `recurringIncome` / `recurringExpenses` — with a `frequency`
  (monthly/quarterly/yearly), pro-rated across the cycle.
- `savingsTargets`, `accounts`, `accountSnapshots`, `accountRates`,
  `accountTransfers`, and the financial-goals logs (`mortgageOverpayments`,
  `helpToBuyPayments`, `investmentContributions`, `charityDonations`,
  `apcPurchases`).
- `friendHoldings` / `friendTransactions` — **Bank of Gilulu**. One holding per
  person; interest is simple interest split across global rate periods
  (`bgRatePeriods` setting). The summary view aggregates every holding and charts
  the combined total (with each account overlaid as its own line).

## Distribution children — critical constraint
Child transactions (`distributed_expense` / `distributed_income`) are
**regenerated locally on every device from their parent `distribution`** and are
**NEVER uploaded to Firestore**. Their local auto-increment ids collide with real
transaction ids on other devices, so writing a delete **tombstone** for a child
once wiped real transactions on another device. Rules:
- Never `queueWrite` / `queueDelete` a child transaction. `sync.js` guards
  `transactions` writes/deletes by skipping any record with a `distributionId`,
  and the uploader filters them out — keep those guards.
- On edit/delete of a distribution, delete its children **locally only**.
- `ensureDistributionChildren()` (non-destructive; runs every app open) and
  `regenerateAllDistributionChildren()` (post-sync) rebuild missing children.

## Sync model (`js/sync.js`)
- Local-first: writes go to Dexie immediately, then `queueWrite`/`queueDelete`
  fire-and-forget to Firestore; failures queue in `syncQueue` for retry.
- Deletes are **tombstones** (`{_deleted:true}`), pulled and applied on other
  devices. `pullFromFirestore` is incremental via a `lastSyncAt` watermark that
  only advances if every table pulls cleanly; `downloadAllFromCloud` is a full
  restore.
- Firestore has a free-tier daily write quota. Uploads resume from a saved cursor
  and upload smallest/most-precious tables first (`transactions` last). Don't
  restructure this without keeping the resume behaviour.
- Any new table must be added to **both** `TABLES` and `UPLOAD_ORDER`.

## Making changes / release checklist
Push directly to `main`; GitHub Pages auto-deploys. On **every** push, without
exception:
1. **Bump the SW cache version** in `sw.js` (`pocket-ledger-vN` → `vN+1`). The
   cache-first SW won't serve new code until the cache name changes.
2. **Update the settings footer** in `js/app.js` — the line
   `App updated: <D Mon YYYY> at <HH:MM> BST/GMT (vN)`. Use **UK time**
   (`TZ='Europe/London' date '+%-d %b %Y at %H:%M %Z'`) and match the new vN.
3. Syntax-check before pushing: `node --check js/app.js` (and any other edited
   JS). Prefer targeted find-and-replace over large rewrites.
4. For category/data changes that must reach existing installs, add a
   `runDataMigrations()` step gated on the `dataVersion` setting (seeds only run
   on a fresh install). New Dexie object stores need a new `db.version(N)`.

## PWA update propagation (mobile vs desktop)
The app is a cache-first PWA. A new SW installs, caches the new files, and
`skipWaiting()` + `clients.claim()` take over — but an already-open page keeps
running old code until a reload after the new worker is in control. Desktop
reloads naturally; an installed mobile PWA resumes frozen and rarely re-checks,
so it can lag. `index.html` handles this: it calls `reg.update()` on focus /
visibility change, and auto-reloads once on `controllerchange` (guarded against
loops and first-install). Keep this logic. Note: a phone stuck on an *older*
version can't benefit from a newer fix until it's manually force-relaunched once
(fully close from the app switcher and reopen, twice if needed).

## Security / privacy
- This app holds **real personal financial data**. Treat it as private.
- **Never commit or push** files containing personal financial data, e.g.
  `finance/migrate/migration-data.json`, `finance/migrate/extra-income-patch.json`,
  or any similar exported dataset / Firebase credential / service-account key.
- Firebase web config in `js/firebase.js` is a public client config (fine to
  ship); real access is gated by Firebase Auth + security rules.

## Conventions
- Money via `fmt()` / `bgFmt()`; dates via the `utils.js` helpers and ISO
  `YYYY-MM-DD` strings throughout. `today()` is the single source of "now".
- UK English in UI text. Currency is GBP (£).
- Keep commit messages descriptive and prefixed with the version, e.g.
  `v58: <summary>`.
