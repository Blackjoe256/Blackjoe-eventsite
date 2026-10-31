# Predicta Markets (predictamarkets.com) — Teardown

Study notes from the public client side of https://predictamarkets.com: response
headers, the public Next.js JS chunks, public unauthenticated API reads (market
list, categories, order book), and a Playwright performance capture. No login, no
private endpoints, no writes.

## Tech stack

| Layer | Technology | Evidence |
|---|---|---|
| Frontend framework | **Next.js 16.2 (App Router, RSC streaming)** on **React 19** canary | `x-powered-by: Next.js`, `self.__next_f.push`, version strings in chunks |
| UI | Tailwind (`data-theme="predicta"` → DaisyUI-style themes), Radix UI, lucide icons, sonner toasts | class names, chunk strings |
| Hosting | **Railway** (both web app and API) | `server: railway-hikari`, `x-railway-edge: iad1` (US East) |
| Trading API | **Python, almost certainly FastAPI**, at `api.predictamarkets.com/v1` | FastAPI default errors `{"detail":"Not Found"}` / `"Could not validate credentials"`; Faker lorem-ipsum left in category descriptions |
| Auth + DB extras | **Supabase** (`@supabase/ssr`): Auth (email, Google OAuth, OTP, passkeys), Storage (market images via custom domain `comms.predictamarkets.com`), Realtime on `accounts` (balance updates) | gotrue/storage code, `channel("account-balance-updates")` |
| Price ticks | A second Supabase project for tickers (`NEXT_PUBLIC_TICKERS_SUPABASE_URL`, `channel("ticker-…")`) | public env config |
| WebSockets | **Soketi** (self-hosted, Pusher-protocol) via `pusher-js` | `NEXT_PUBLIC_SOKETI_*` |
| Search | **Algolia** (index `markets`) | public env config |
| Blog | **Ghost** headless CMS (`blog.predictamarkets.com`) | `NEXT_PUBLIC_GHOST_CONTENT_API_KEY` |
| Uploads | Uploadcare | `ucarecdn.com` |
| Payments | M-Pesa (Paybill), Paystack, PalmPay mobile money, NOWPayments (crypto), SWIFT bank wire, UPI | payment UI strings, `/payment/*` routes |
| Analytics / ads | PostHog, GA4, GTM, Sentry, AdRoll, TikTok + Facebook + LinkedIn pixels | requests captured on load |
| White-label hint | Brand comes from env (`NEXT_PUBLIC_CONFIG_SITE_NAME`, `…_THEME`, logos); assets under `supabase.co/saas/predicta-markets/` | public env config |

## How it operates

```
Browser ──► Next.js on Railway (SSR, server components)
   │              └──► FastAPI /v1  (markets, orders, matching, wallets, payments)
   │                         └──► Postgres (likely Supabase-hosted)
   ├──► Supabase Auth (JWT)  ── JWT is sent as Bearer to FastAPI
   ├──► Supabase Realtime / Soketi  (balances, price tickers)
   └──► Algolia (search), payment providers (M-Pesa, Paystack, PalmPay, crypto)
```

### Market model
- Each **market** (e.g. "Will Gachagua vie for President in 2027?") has one or more
  **market assets** ("mini markets"), each with outcomes **YES / NO**.
- Prices are **0–100**, so they read as implied probability in % (YES 85 / NO 15).
  A winning share pays 100 and a losing share pays 0.
- `market_type`: `DEFAULT` (one-off event) or `SERIES`, a market that **regenerates
  on a schedule**, e.g. "EUR/GBP Hourly Close", regenerated 4,000+ times, with a template
  `ABOVE_AT_OR_BELOW_PERCENTAGE`, timezone and trading windows. That's high-frequency
  binary options on FX/crypto/indices (category "CFD Hedges").
- Domains: SPORTS, GENERAL (politics, celebrities, Kenya news), FINANCE.
- Currency on markets is `PT` (internal points/unit), with fiat rates from `/currency/rates`.

### Trading = a central limit order book (CLOB)
- `GET /v1/markets/{id}/order_book/{assetId}` returns `[[price, qty], …]`, e.g. `[[85.0, 2.0]]`.
- Place order: `POST /v1/markets/{qid}/orders` with
  `{account_id, mini_market_id, order_type: BUY|SELL, opinion_side: YES|NO, price, quantity, prediction_key}`.
- Cancel: `PUT …/orders/{id}/cancel`. Sell a position: `PUT …/orders/{id}/sell`.
- The wallet shows **Available** vs **Suspense** ("held for open orders"), so cash is
  escrowed when an order rests on the book and released on fill or cancel.
- History: `/accounts/{id}/ledgers`, `/trades`, `/payouts`, implying a double-entry style ledger.
- Resolution: `/markets/{id}/resolution`, and options carry a `determination_formula`
  for auto-resolving data-driven markets. `/external-inferences` suggests outside
  odds/AI signals are shown next to markets.
- Engagement: per-market chat, user market suggestions with voting, referrals.

## Why it feels static and slow (measured)

| Metric | Value |
|---|---|
| Time to first byte | ~0.4 s |
| First paint (pulsing logo loader) | ~0.9 s |
| **HTML finishes streaming** | **~30.6 s** (every run) |
| DOM interactive / hydration | ~30.6 s |
| `GET /v1/markets` (API) | **~8 s** for 59 KB |
| JS downloaded | ~1.5 MB across 51 scripts |
| Requests on load | 131, ~60 of them ad/retargeting pixels |
| `Cache-Control` on `/_next/static/*` | `no-cache, no-store` |

Root causes:
1. **The homepage server component blocks on data.** The page is a `<Suspense>`
   boundary whose fallback is the pulsing logo. The server streams the shell at
   0.35 s, then sends nothing until ~30.6 s, when the `initialMarkets` payload and
   the rest of the page arrive. The constant ~30 s points to a server-side fetch
   **hitting a 30 s timeout** on top of the already slow 8 s markets API.
2. **No interactivity until the stream ends.** React only hydrates once the HTML and
   scripts have finished, so for ~30 s buttons and links do nothing. That's the "static" feel.
3. **Slow API**: 8 s to list markets points to N+1 queries (each market loads its
   assets, schedules and categories separately), no pagination limits by default, no caching.
4. **No browser caching of static assets.** Hashed `/_next/static` files should be
   `public, max-age=31536000, immutable`. Here they're `no-store`, so every visit
   re-downloads ~1.5 MB of JS.
5. **Third-party weight**: AdRoll's cookie-sync chain fires ~40 requests to ad exchanges,
   plus TikTok, Facebook and LinkedIn pixels, all competing with the app on mobile data.
6. **Single US-East region** (`iad1`) serving users in Kenya, Nigeria and India adds
   ~200–300 ms on every API round trip.

How you would fix it: render the page shell immediately and stream markets into
smaller Suspense boundaries (or fetch on the client); add `revalidate`/ISR caching
for the market list; fix the timed-out fetch; add DB indexes and eager loading on
`/v1/markets` plus a Redis cache; restore immutable caching for static assets; load
ad pixels after interaction (`next/script strategy="lazyOnload"`); deploy closer to
African users or put a CDN in front.

## Tracking (measured on a fresh, logged-out visit)

**No cookie consent banner.** Trackers load on the first page view; there are only
links to `/privacy` and `/cookie-policy` in the footer.

After ~14 s on the homepage the browser held **50 cookies** across ~25 companies and
had sent **75 requests** to third parties. Most cookies last a year (`_ga` 400 days,
`_ttp` 390 days, `__adroll` 395 days).

| Tool | What it does here |
|---|---|
| **PostHog** (product analytics) | Autocapture of every click, heatmaps, network timing, web vitals, JS errors, and **session recording** (`posthog-recorder.js`, `consoleLogRecordingEnabled: true`, no masking config set) |
| **Google Analytics 4 + Tag Manager** | Page views; GTM `dataLayer` gets `USER_SIGNED_UP` with the user's **email**, account type and referral code; Google Ads conversion on token purchase |
| **AdRoll** (retargeting) | Drops a cookie, then fires a **cookie-sync chain**: ~40 requests that pass your AdRoll ID to ad exchanges and data brokers (The Trade Desk, PubMatic, Rubicon/Magnite, OpenX, Index Exchange, TripleLift, Tapad, LiveRamp/rlcdn, Eyeota, Experian, Bombora, Outbrain, Taboola…) |
| **TikTok pixel** | `Pageview`, `LandingPageView`, `EngagedSession` events; loads TikTok's `identify` module and an IPv6 enrichment call |
| **Meta (Facebook) pixel** | `fbevents.js` loaded (pixel ID left empty in config) |
| **LinkedIn Insight** | `db_sync` cookie syncing |
| **X (Twitter) Ads pixel** (code present) | On every **trade** it would send amount, market title, `trade_<id>` and the user's **email**; same for market creation and registration. It didn't load during the logged-out capture |
| **Sentry** | Error monitoring |
| **Chatwoot** | Support chat; on login gets email, name, avatar and **phone number** |

### What happens when you log in
`posthog.identify(account_id, {...})` attaches your **email, full name, first/last
name, phone number, country, currency, account type and referral code** to your
PostHog profile. It also `alias`es your earlier anonymous ID, so the pre-signup
browsing and recordings are joined to your real identity.

Bug: their `signup_date` property is filled from `date_of_birth`, so your **date of
birth** goes to PostHog under the wrong label.

### Why it matters
- Kenya's Data Protection Act 2019 and Nigeria's NDPA 2023 expect a lawful basis
  (typically consent) before non-essential tracking and before sharing personal data
  with third parties. Ad-exchange cookie sync on the first visit, with no prompt, is
  the pattern regulators target.
- Financial-style apps normally mask session recordings, because recorders capture
  what's on screen (balances, trades, and inputs unless masked).
- It's also part of why the site is slow (see above).
