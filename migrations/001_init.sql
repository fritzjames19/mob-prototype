-- MOB multiplayer schema
-- Run this in the Supabase SQL editor (or via `supabase db push` if using the CLI).
-- Supabase Auth already provides `auth.users` (id uuid, email, etc.) — we reference it,
-- we don't reimplement login/password storage ourselves.

create extension if not exists "uuid-ossp";

-- One row per character. A Supabase Auth user could eventually own multiple characters,
-- but for now we keep it 1:1 (matches the account-per-boss model from the prototype).
create table players (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  faction_key text not null,

  level int not null default 1,
  xp int not null default 0,
  xp_boost int not null default 0,

  money bigint not null default 100,
  respect int not null default 0,

  energy int not null default 100,
  max_energy int not null default 100,
  last_energy_tick timestamptz not null default now(),

  heat int not null default 0,
  ever_wanted boolean not null default false,

  attack int not null default 10,
  defense int not null default 10,
  luck int not null default 10,

  quests_done int not null default 0,
  special_done text[] not null default '{}',

  pvp_wins int not null default 0,
  pvp_losses int not null default 0,

  hits_completed int not null default 0,
  hits_failed int not null default 0,
  hits_survived int not null default 0,

  tournament_wins int not null default 0,
  tournament_losses int not null default 0,
  tournament_points int not null default 0,

  territories_captured int not null default 0,
  rivals_eliminated int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index players_user_id_idx on players(user_id);
create index players_respect_idx on players(respect desc);
create index players_money_idx on players(money desc);

-- Gang members belonging to a player
create table gang_members (
  id uuid primary key default uuid_generate_v4(),
  player_id uuid not null references players(id) on delete cascade,
  name text not null,
  attack int not null,
  defense int not null,
  loyalty int not null,
  created_at timestamptz not null default now()
);
create index gang_members_player_idx on gang_members(player_id);

-- Cards owned (Card Battle system)
create table cards (
  id uuid primary key default uuid_generate_v4(),
  player_id uuid not null references players(id) on delete cascade,
  name text not null,
  rarity_id text not null,
  power int not null,
  created_at timestamptz not null default now()
);
create index cards_player_idx on cards(player_id);

-- Titles owned (NFT Title system — still simulated with in-game money for now)
create table titles (
  id uuid primary key default uuid_generate_v4(),
  player_id uuid not null references players(id) on delete cascade,
  title_id text not null, -- e.g. 'card2', 'jack', 'king'
  acquired_at timestamptz not null default now(),
  unique(player_id, title_id)
);
create index titles_player_idx on titles(player_id);

-- Districts: THIS is shared world state, not per-player — everyone contests the same map.
-- owner_type is 'npc_rival' | 'player' | 'neutral'. owner_ref is the rival id or the player's id.
create table districts (
  id text primary key, -- e.g. 'd_docks'
  name text not null,
  business text not null,
  base_income int not null,
  owner_type text not null default 'npc_rival',
  owner_ref text, -- npc rival id, or players.id as text, or null if neutral
  tier int not null default 0,
  last_collected timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- grudge/reinforcement tracking is now against a real rival identity, whether NPC or player
create table district_grudges (
  attacker_player_id uuid not null references players(id) on delete cascade,
  defender_ref text not null, -- npc rival id or defending player's id
  grudge int not null default 0,
  primary key (attacker_player_id, defender_ref)
);

-- seed the 8 districts (5 NPC-held, 2 neutral, matching the single-player prototype's starting layout)
insert into districts (id, name, business, base_income, owner_type, owner_ref) values
  ('d_docks',     'The Docks',         'Smuggling Pier',     7,  'npc_rival', 'nr_sal'),
  ('d_littleit',  'Little Italy',      'Restaurant Front',   6,  'npc_rival', 'nr_sal'),
  ('d_chinatown', 'Chinatown',         'Underground Casino', 12, 'npc_rival', 'nr_yuki'),
  ('d_warehouse', 'Warehouse District','Chop Shop',          9,  'npc_rival', 'nr_dmitri'),
  ('d_redlight',  'Red Light District','Nightclub',          11, 'npc_rival', 'nr_carlos'),
  ('d_financial', 'Financial District','Loan Shark Office',  14, 'npc_rival', 'nr_broker'),
  ('d_uptown',    'Uptown',            'Backroom Poker',     8,  'neutral',   null),
  ('d_eastside',  'Eastside',          'Fencing Operation',  6,  'neutral',   null)
on conflict (id) do nothing;

-- Row Level Security: players can only read/write their own character data.
-- Districts are globally readable by anyone (it's the shared map) but only writable by the server
-- (using the service-role key, which bypasses RLS) so a client can never fake a takeover.
alter table players enable row level security;
alter table gang_members enable row level security;
alter table cards enable row level security;
alter table titles enable row level security;
alter table districts enable row level security;
alter table district_grudges enable row level security;

create policy "players can read own character" on players for select using (auth.uid() = user_id);
create policy "players can read own gang" on gang_members for select using (
  player_id in (select id from players where user_id = auth.uid())
);
create policy "players can read own cards" on cards for select using (
  player_id in (select id from players where user_id = auth.uid())
);
create policy "players can read own titles" on titles for select using (
  player_id in (select id from players where user_id = auth.uid())
);
create policy "anyone can read the shared map" on districts for select using (true);

-- No insert/update/delete policies for any table: all writes go through the backend API
-- using the service-role key, which bypasses RLS entirely. This is the "server-authoritative"
-- guarantee — a player editing their browser's JS cannot write to the database directly,
-- only the trusted server can, and only after validating the action.
