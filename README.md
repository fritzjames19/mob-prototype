# MOB Backend

A server-authoritative API for the MOB game. The browser client never computes rewards,
combat results, or stat changes itself — it sends an *intent* ("do quest X") and this
server validates it, computes the result, and is the only thing allowed to write to the
database. That's what makes this cheat-proof: editing the JavaScript in your browser's
dev tools can't give you free money, because your browser never decides how much money
you get.

## What's built so far (vertical slice)

- Account signup/login (via Supabase Auth — this backend doesn't touch passwords at all)
- Character creation (name + faction)
- Fetching your character, with energy regenerating based on real elapsed time
- Doing a Quest, fully server-validated and computed
- A public leaderboard
- The shared district/territory map (read-only for now — see Roadmap)

## What's not ported yet

Gang Wars, Hitlist, Underground/Black Market, Gang recruitment, Card Battle, Titles,
and Territory *actions* (attacking/claiming districts) all still only exist in the
single-player prototype. The database schema already has tables for gang members, cards,
and titles, and the districts table is already shared/global — porting each system means
writing one route + one `resolveX()` function in `gameLogic.js`, following the exact same
pattern as `resolveQuest`. Territory is the one to prioritize next: it's schema-ready for
real player-vs-player conquest (`districts.owner_type = 'player'`, `owner_ref` = another
player's id) instead of only NPC rivals — that's the most natural "real multiplayer" hook
in the whole game.

## 1. Set up Supabase

1. Go to [supabase.com](https://supabase.com), create a free account and a new project
2. In the SQL Editor, paste and run `migrations/001_init.sql` — this creates every table
   and seeds the 8 starting districts
3. Go to **Authentication → Providers** and make sure Email is enabled (it is by default).
   That's the whole auth setup — Supabase handles signup, login, password reset, email
   verification, and issuing tokens. This backend just verifies those tokens.
4. Go to **Project Settings → API** and copy three values: the Project URL, the `anon`
   public key, and the `service_role` secret key

## 2. Configure the backend

```bash
cp .env.example .env
# paste your three Supabase values into .env
npm install
npm run dev
```

Visit `http://localhost:3000/health` — you should see `{"ok":true}`.

## 3. Run the tests

```bash
node tests/gameLogic.test.js        # pure logic, no network needed
node tests/server.integration.test.js  # boots the real Express app against a mock DB
```

## 4. Deploy (Railway example)

1. Push this folder to a GitHub repo
2. On [railway.app](https://railway.app), New Project → Deploy from GitHub repo
3. Add the same three Supabase env vars (plus `ALLOWED_ORIGINS` set to your frontend's
   real URL once you know it — don't leave it as `*` in production)
4. Railway auto-detects Node and runs `npm start`. You'll get a public URL.

Render works almost identically (New → Web Service → connect repo → same env vars →
build command `npm install`, start command `npm start`).

## 5. Connect the frontend

The existing single-player HTML file computes everything locally. Turning it into a
multiplayer client means:

1. Add the Supabase JS client (`@supabase/supabase-js` via a `<script>` CDN tag, or a
   build step if you move off a single HTML file) and call `supabase.auth.signUp()` /
   `signInWithPassword()` directly from the browser — the backend is never involved in
   login itself
2. After login, Supabase gives you a session with an `access_token`. Attach it as
   `Authorization: Bearer <token>` on every call to this backend
3. Replace local functions like `doQuest()` with a `fetch()` call to
   `POST /players/me/quests/:questId`, then update the UI from the response instead of
   computing anything client-side

This is a genuinely large refactor (every action in the game needs this treatment, not
just quests) — the natural way to do it is one system at a time, same as how the
single-player prototype itself was built up incrementally.

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` must never be sent to the browser or committed to git.
  It's what lets this server bypass Row Level Security — anyone who gets it can write
  anything to the database, bypassing every rule in this backend.
- Row Level Security is enabled on every table. Players can only ever *read* their own
  data directly from Supabase; there are no RLS policies allowing writes at all, which
  means the *only* way to change game state is through this API, which validates first.
- Lock `ALLOWED_ORIGINS` down to your real frontend domain before going live.
