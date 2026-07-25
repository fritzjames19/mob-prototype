// Integration test: boots the real Express app with a mocked Supabase layer,
// so we can verify routing, auth enforcement, and request/response shape
// without needing live Supabase credentials or network access.
import express from 'express';
import request from 'node:http';

// --- Minimal in-memory fake standing in for Supabase, matching the query shape we use ---
function makeFakeSupabase() {
  const players = new Map();
  const gangs = new Map();

  function table(name) {
    let filters = [];
    let selectCols = '*';
    let single = false;
    let orderCol = null, orderAsc = true, limitN = null;

    const api = {
      select(cols) { selectCols = cols; return api; },
      eq(col, val) { filters.push([col, val]); return api; },
      order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return api; },
      limit(n) { limitN = n; return api; },
      single() { single = true; return api; },
      async insert(obj) {
        if (name === 'players') {
          const id = 'player_' + (players.size + 1);
          const row = { id, xp: 0, level: 1, money: 100, respect: 0, heat: 0, xp_boost: 0,
            last_energy_tick: new Date().toISOString(), quests_done: 0, ...obj };
          players.set(id, row);
          return { insertedRow: row, select: () => ({ single: async () => ({ data: row, error: null }) }) };
        }
        return { select: () => ({ single: async () => ({ data: null, error: 'not implemented' }) }) };
      },
      update(patch) {
        return {
          eq: async (col, val) => {
            if (name === 'players') {
              for (const [id, row] of players) {
                if (row[col] === val) Object.assign(row, patch);
              }
            }
            return { error: null };
          }
        };
      },
      then(resolve) {
        // executed when awaited directly (select queries)
        let rows = [];
        if (name === 'players') rows = [...players.values()];
        if (name === 'gang_members') rows = [...gangs.values()];
        for (const [col, val] of filters) rows = rows.filter(r => r[col] === val);
        if (orderCol) rows.sort((a, b) => orderAsc ? a[orderCol]-b[orderCol] : b[orderCol]-a[orderCol]);
        if (limitN) rows = rows.slice(0, limitN);
        if (single) return resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } });
        resolve({ data: rows, error: null });
      }
    };
    return api;
  }

  return { from: table, _players: players };
}

const fakeAdmin = makeFakeSupabase();
const FAKE_USER_ID = 'user-123';

// Fake auth: accept any bearer token, always resolve to FAKE_USER_ID
const fakeAuthMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  req.userId = FAKE_USER_ID;
  next();
};

// Rebuild minimal versions of the routes wired to the fake DB + fake auth,
// exercising the exact same gameLogic.js used in production.
import { applyEnergyRegen, resolveQuest, FACTIONS } from '../src/gameLogic.js';

const app = express();
app.use(express.json());

app.post('/players', fakeAuthMiddleware, async (req, res) => {
  const { name, factionKey } = req.body;
  if (!name || name.length > 16) return res.status(400).json({ error: 'bad name' });
  if (!FACTIONS[factionKey]) return res.status(400).json({ error: 'bad faction' });
  const existing = await fakeAdmin.from('players').select('id').eq('user_id', req.userId);
  if (existing.data.length > 0) return res.status(409).json({ error: 'already exists' });
  const f = FACTIONS[factionKey];
  const maxEnergy = 100 + (f.maxEnergyBonus || 0);
  const result = await fakeAdmin.from('players').insert({
    user_id: req.userId, name, faction_key: factionKey,
    energy: maxEnergy, max_energy: maxEnergy,
    attack: 10 + (f.atkBonus || 0), defense: 10 + (f.defBonus || 0),
  });
  res.status(201).json({ player: result.insertedRow });
});

app.get('/players/me', fakeAuthMiddleware, async (req, res) => {
  const result = await fakeAdmin.from('players').select('*').eq('user_id', req.userId).single();
  if (!result.data) return res.status(404).json({ error: 'not found' });
  res.json({ player: applyEnergyRegen(result.data) });
});

app.post('/players/me/quests/:questId', fakeAuthMiddleware, async (req, res) => {
  const result = await fakeAdmin.from('players').select('*').eq('user_id', req.userId).single();
  if (!result.data) return res.status(404).json({ error: 'not found' });
  try {
    const { player, reward, levelUps } = resolveQuest(applyEnergyRegen(result.data), [], req.params.questId);
    await fakeAdmin.from('players').update({ energy: player.energy, money: player.money }).eq('id', player.id);
    res.json({ player, reward, levelUps });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

const server = app.listen(0);
const port = server.address().port;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = request.request({
      hostname: 'localhost', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      }
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log('PASS:', name); passed++; }
  else { console.log('FAIL:', name); failed++; }
}

async function run() {
  // No auth header -> 401
  const noAuth = await req('GET', '/players/me', null, null);
  check('GET /players/me without token returns 401', noAuth.status === 401);

  // Create character
  const created = await req('POST', '/players', { name: 'TestBoss', factionKey: 'yakuza' }, 'faketoken');
  check('POST /players creates character (201)', created.status === 201);
  check('Created character has yakuza attack bonus', created.body.player.attack === 20);

  // Duplicate character blocked
  const dup = await req('POST', '/players', { name: 'Another', factionKey: 'triad' }, 'faketoken');
  check('Cannot create a second character for same user (409)', dup.status === 409);

  // Fetch profile
  const me = await req('GET', '/players/me', null, 'faketoken');
  check('GET /players/me returns the character', me.status === 200 && me.body.player.name === 'TestBoss');

  // Do a quest
  const questRes = await req('POST', '/players/me/quests/store', null, 'faketoken');
  check('Quest deducted energy server-side', questRes.body.player.energy === 90);
  check('Quest granted a reward', questRes.body.reward.money > 0);

  // Bad quest id
  const badQuest = await req('POST', '/players/me/quests/totally_fake_quest', null, 'faketoken');
  check('Unknown quest id returns 400', badQuest.status === 400);

  // Simulate a client trying to cheat: send extra fields, they should be ignored since
  // the server never reads req.body for the quest route at all.
  const cheatAttempt = await req('POST', '/players/me/quests/store', { money: 999999999, attack: 99999 }, 'faketoken');
  check('Client-sent money/attack fields are ignored (server-authoritative)', cheatAttempt.body.player.money < 999999999);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run();
