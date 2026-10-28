# OnCampus (oncampus.online) — Tech Stack Teardown

Study notes from looking at the public client side of https://www.oncampus.online.
Method: `rea-agents` (`rea analyze-web-bundle`) attached to headless Chromium over
CDP, plus reading the public JS chunks served from `/assets/`. Nothing behind
login was accessed.

## Tech stack

| Layer | Technology | Evidence |
|---|---|---|
| App builder | **Lovable** (AI app builder) | `og:image` is a `*.lovable.app` preview; `lovable.dev` / `lovable-preview-auth` strings in bundle |
| UI library | **React 19** (19.2.5) | version string in `index-*.js` |
| Framework / router | **TanStack Start + TanStack Router** (SSR + streaming hydration) | `$_TSR`, `tsr-scroll-restoration`, `createFileRoute`-style route ids like `/_app/discover` |
| Build tool | **Vite** | hashed `/assets/name-HASH.js` chunks, `virtual_pwa-register` module |
| Styling | **Tailwind CSS** + shadcn-style tokens | classes like `bg-primary text-primary-foreground`, `shadow-card` |
| Animation | **Framer Motion** (`motion`) | inline `opacity:0;transform:translateY(4px)` + motion strings |
| Icons | **lucide-react** | per-icon chunks: `heart`, `flame`, `send`, `map-pin`… |
| Toasts | **sonner** | `section aria-label="Notifications alt+T"` |
| Fonts | Google Fonts: Bebas Neue, Inter, Playfair Display | `<link>` in `<head>` |
| PWA | **vite-plugin-pwa + Workbox**, web manifest, iOS splash screens | `workbox-window`, `manifest.webmanifest`, `pushManager` |
| Backend (BaaS) | **Supabase**: Postgres, Auth, Realtime, Storage, RPC | `@supabase/supabase-js`, `*.supabase.co`, `/rest/v1`, `/auth/v1` |
| Hosting | **Vercel** | `server: Vercel`, `x-vercel-id` response headers |
| Image CDN | Cloudflare R2 (for the OG image) | `pub-*.r2.dev` |

## How it operates

```
Browser (React PWA)  ──HTML/JS──  Vercel (TanStack Start SSR)
        │
        └── supabase-js ──►  Supabase
                              ├─ Auth      (email+password, OTP / magic link, OAuth)
                              ├─ Postgres  (tables + Row Level Security + RPC functions)
                              ├─ Realtime  (postgres_changes, presence, broadcast)
                              └─ Storage   (bucket: profile-photos)
```

There is no custom API server. The browser talks to Supabase directly with the
public anon key, and security comes from Postgres **Row Level Security** policies
and `SECURITY DEFINER` RPC functions.

### Routes (pages)
`/` landing · `/auth` · `/reset-password` · `/onboarding` · inside `/_app` layout:
`/discover` (swipe), `/matches`, `/messages/$matchId`, `/explore`, `/campus`,
`/notifications`, `/profile`, `/settings` · `/admin`.

### Data model (tables seen in the client)
`profiles`, `profile_prompts`, `swipes`, `matches`, `messages`,
`conversation_prompts`, `pokes`, `streaks`, `notifications`, `push_subscriptions`,
`explore_posts`, `campus_posts`, `campus_post_comments`, `campus_pokes`,
`courses`, `study_rooms`, `study_room_participants`, `study_room_messages`,
`study_buddy_requests`, `reports`, `moderation_actions`.

### Server-side functions (Postgres RPC)
`save_my_profile`, `profile_distances`, `start_dm_with`, `mark_messages_read`,
`send_profile_poke`, `accept_study_buddy_request`, `delete_my_account`,
`has_role`, `admin_list_users`, `admin_moderation_for`, `admin_warn_user`.

### Key flows
1. **Sign up / onboarding**: Supabase Auth creates the user, then onboarding fills
   `profiles` (gender, connection types such as casual, long-term or study buddy,
   university and course) and optionally captures GPS via `navigator.geolocation`.
2. **Discover (swipe)**: the client loads profiles, filters out people it has already
   swiped on (`swipes` where `swiper_id = me`), and gets distances from the
   `profile_distances` RPC. A swipe is an `INSERT` into `swipes`. After a *like*,
   the client checks `matches` for a row with both user ids. The client never
   writes that row, so a **database trigger** creates the match when both users
   like each other. "Undo" deletes the last swipe row.
3. **Chat**: `messages` per match, live through a Realtime channel `messages:<matchId>`
   (INSERT/UPDATE events), read receipts via `mark_messages_read`, and voice notes via
   `MediaRecorder`.
4. **Social feeds**: `explore_posts` (24-hour disappearing posts with optional location)
   and `campus_posts` with comments and pokes, all live-updating through
   `postgres_changes`.
5. **Study rooms**: `study_rooms` + participants + messages, using Realtime
   **presence** to show who is online in a room.
6. **Notifications**: `notifications` table streamed over Realtime, plus Web Push
   (`push_subscriptions`, service worker `pushManager`).
7. **Safety / admin**: `reports` → `moderation_actions`; `/admin` is gated by the
   `has_role(_user_id, 'admin')` RPC (real enforcement must live in RLS).
