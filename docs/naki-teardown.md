# Naki (nakiai.site99ug.com) — Teardown

Study notes from the public client side of https://nakiai.site99ug.com: response
headers, DNS, and the public JS bundle served from `/assets/`. No login, no API
calls beyond loading the page, no database reads.

Naki is marketed by **Site 99 AI & Automations** (Uganda) as an AI business manager:
accounting, customer service, HR, sales and reports.

## How it was built

**Lovable** (AI app builder), generated as a Vite + React single-page app, backed by
**Lovable Cloud** (a Supabase project Lovable creates for you).

| Evidence | What it shows |
|---|---|
| `data-context-token` contains `"project_id":"lovp_3nb7…"` | Lovable project ID |
| `og:image` on `pub-bb2e103a…r2.dev/lovp_…` | Lovable's screenshot bucket (same bucket as other Lovable sites) |
| `/~flock.js` analytics proxy, `/__l5e/events…js`, `x-deployment-id: psr2.…` | Lovable hosting runtime |
| Bundle checks for `lovable.app`, `lovableproject.com`, `gpt-eng.com`, `oauth.lovable.app` | Lovable preview/auth helpers |
| A record `185.158.133.1` for both `nakiai.site99ug.com` and `site99ug.com` | Lovable's documented custom-domain IP |

## Tech stack

| Layer | Technology |
|---|---|
| UI | **React 18.3.1**, single-page app (`<div id="root">`, client-side rendering only) |
| Build | **Vite** (hashed `/assets/index-*.js`, `__vite__mapDeps`) |
| Routing | React Router |
| Styling / components | Tailwind + **shadcn/ui** (Radix UI, lucide icons, sonner toasts, cmdk) |
| Data fetching | TanStack Query (`QueryClient`) |
| AI chat UI | AI Elements-style components (`PromptInput`, `MessageResponse`) rendering with **Streamdown** (streaming Markdown) + **Shiki** (code highlighting, ~200 language chunks) + **KaTeX** (math) + **Mermaid** (diagrams) |
| Backend | **Supabase** (Lovable Cloud): Postgres, Auth, Edge Functions |
| AI | Supabase Edge Function `functions/v1/chat`, streamed back to the browser. The model is called server-side, so it can't be seen from the client. Lovable Cloud projects normally use the **Lovable AI Gateway** (Gemini / GPT models) |
| Hosting | **Lovable hosting** behind **Cloudflare** (`server: cloudflare`, `__cf_bm` bot-management cookie, `cf-ray`, IAD edge) |
| Analytics | Lovable's built-in analytics (`/~flock.js` → `/~api/analytics`); no Google, Meta or TikTok pixels |

## Database (tables the frontend uses)

| Table | Purpose |
|---|---|
| `projects` | Portfolio / case studies (public pages + admin editor) |
| `blog_posts` | Blog and "updates" (public pages + admin editor) |
| `contact_submissions` | Contact form / demo bookings (admin inbox at `/admin/messages`) |
| `chat_threads`, `chat_messages` | Saved AI conversations for logged-in users |
| `user_roles` | Admin role check for `/admin` |

No storage buckets, no RPCs, and no realtime subscriptions are used by the app code.

## Routes

Public: `/`, `/about`, `/capabilities`, `/workflow`, `/projects`, `/blog`, `/updates`,
`/contact`, `/ai-demo`, `/login`, `/signup`.
Logged-in: `/chat`, `/chat/:threadId`.
Admin: `/admin`, `/admin/messages`, `/admin/posts(/:id)`, `/admin/projects(/:id)`.

## How the AI chat works

1. **Guest demo** (`/ai-demo`): the browser POSTs `{guest: true, message, history}` to
   the `chat` Edge Function, sending only the public anon key. It sends the last 10
   messages as context and stops after **10 user messages**. That limit is enforced
   in the browser; whether the function also enforces it can't be seen from outside.
2. **Signed-in chat** (`/chat/:threadId`): same function, with the user's Supabase JWT
   and a `threadId`. The function loads and saves the thread in `chat_threads` /
   `chat_messages`.
3. The reply streams back as chunks read with `response.body.getReader()`, and
   Streamdown renders Markdown, code, math and Mermaid diagrams while it arrives.

So "Naki" as visible on this site is a **marketing site plus an LLM chat demo** with
a business-manager system prompt. The accounting, HR and sales modules aren't in
this frontend: there are no tables for invoices, employees, payroll or sales.

## Observations

- **Heavy bundle**: the main JS file is **2.6 MB** (Mermaid + parsers are bundled
  eagerly), plus 40 lazy chunks. With client-only rendering, a phone on a slow
  connection sees a blank page until that loads.
- **No server rendering**: the HTML is an empty `<div id="root">`, so search engines
  and link previews see only the `<meta>` tags.
- **Guest chat cost**: the guest endpoint only needs the public anon key. If the
  10-message limit is only enforced in the browser, anyone can call the function
  directly and spend the owner's AI credits. That needs a server-side rate limit.

## AI features: claims vs what the public site does

### What the site claims
- **Workflow page ("company tree")**: 15 departments, 64 jobs (Accounting, Sales,
  Marketing, Customer service, HR & Payroll, Operations, Procurement, Inventory,
  Logistics, IT, Legal, Admin, Reports, Facilities, **Training**), each tagged
  *fully autonomous*, *semi-autonomous* (a person approves) or *assisted*, with
  before/after times such as "Refunds: 1 week → 5 min".
- **About page**: Naki started as the internal business manager of **Kweeza Cleaning
  Services** (Kampala). There it looks up live records (jobs, payments, tickets, staff)
  before answering, passes messages to staff ("Tell Sarah the job starts at 9"),
  answers in team groups when tagged @Naki, opens urgent tickets for customers, saves
  the team's answers for next time, and guides new staff.
- **Beads**: a usage allowance; every answer spends beads (a credit system per task).

### What the code shows
- The company tree, autonomy labels and before/after timings are **hard-coded
  marketing data** in the JS bundle (`yt("Reordering","semi","1 day","1 min",…)`).
  They aren't loaded from any database or measured from real usage.
- The site's database only has `projects`, `blog_posts`, `contact_submissions`,
  `chat_threads`, `chat_messages` and `user_roles`. Nothing for invoices, staff,
  payroll, stock, tickets or training, and no tool or integration calls from the
  frontend.
- So the department features **are not in this product**. They would live in the
  custom system Site 99 builds per client (like the Kweeza deployment), which isn't
  public. This site is a marketing page plus a general chat assistant.
- `/capabilities` describes a general assistant: drafting, summarising,
  translating, quizzes, captions and speeches.

### Testing the public demo (4 guest messages)
| Question | Result |
|---|---|
| "How would you run payroll for 20 staff?" | Strong: a 5-step Uganda-specific process (TIN, NSSF, PAYE, URA, approvals), with a sensible caveat to check current rates |
| "List my overdue invoices…" | Honest: says it has no access to records and asks for an ageing report or CSV. The "live records" feature isn't connected in the demo |
| "Which model are you, were you trained on our data?" | Deflects: "I'm Naki, built by Site 99", and points to info@site99ug.com |
| Cleaning-company pitch | Good, concise, local (UGX) |

Timing: first text after ~4 s, full short reply ~7 s.

### Own model or an API key?
**An API key to a hosted model**, not a model they trained. Evidence:
- The model runs behind a single Supabase Edge Function (`x-deno-execution-id`,
  `x-sb-edge-region` headers). A Deno edge function can't host an LLM; it can only
  call one over HTTP.
- The function rewrites the provider's stream into its own `data: {"delta": "…"}`
  events, which hides the provider. Lovable Cloud projects typically call the
  **Lovable AI Gateway** (Google Gemini / OpenAI GPT) using a key held server-side.
- The "Naki" personality, Uganda context and refusal style come from the
  **system prompt** (and for the Kweeza deployment, retrieval of business records
  plus saved team answers, i.e. RAG-style memory), not from training.
- "Learns from the team" as described (the team's reply is saved and reused) is
  retrieval from a database, not model training.
