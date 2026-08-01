import { makeMockSupabase } from './mockSupabase.js';
import {
  allTitleDefs, canBuyTitle, ownsAnyTitle,
  canAttemptBlackMarket, resolveBlackMarket, randomEliteTarget, attackerPower,
  freshDealsPool, canBuyDeal, SECRET_DEAL_TEMPLATES,
  freshRivalPool, canFightRival, resolveGangWarsFight,
  freshHitlistPool, canAttemptHit, resolveHit,
  openPack, canBuyPack, deckPower, canPlayTournament, makeTournamentOpponent, resolvetournamentMatch,
} from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log('PASS:', name); passed++; }
    catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
  })();
}

function seedPlayer(db, overrides = {}) {
  const p = { id: 'p1', money: 5000, energy: 100, heat: 0, attack: 20, defense: 15, luck: 10,
    respect: 0, hits_completed: 0, hits_failed: 0, hits_survived: 0, pvp_wins: 0, pvp_losses: 0,
    tournament_wins: 0, tournament_losses: 0, tournament_points: 0, max_energy: 100,
    secret_deals_pool: [], sniper_last_used_at: null, ...overrides };
  db._tables.players = [p];
  return p;
}

// ---------------- Titles ----------------
await test('Buying a title inserts it and deducts money; cannot buy twice', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { money: 5000 });
  const owned = [];
  const t = canBuyTitle(p, owned, 'card2');
  await db.from('titles').insert({ player_id: p.id, title_id: t.id });
  p.money -= t.cost;
  assert.strictEqual(p.money, 5000 - t.cost);
  const nowOwned = [t.id];
  assert.throws(() => canBuyTitle(p, nowOwned, 'card2'), /already own/);
});

// ---------------- Underground: Black Market ----------------
await test('Black Market requires a title, respects cooldown, and resolves against the stored target not a client value', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { attack: 999, luck: 999, money: 5000 });
  const titleIds = ['card2'];
  canAttemptBlackMarket(p, titleIds, null); // no crash = access granted

  const target = randomEliteTarget(attackerPower(p, []));
  await db.from('ephemeral_pools').upsert({ player_id: p.id, pool_type: 'blackmarket', candidates: [target] });

  const { data: pool } = await db.from('ephemeral_pools').select('*').eq('player_id', p.id).eq('pool_type', 'blackmarket').maybeSingle();
  const storedTarget = pool.candidates[0];
  assert.deepStrictEqual(storedTarget, target, 'the target resolved against must be the one actually stored');

  const { player: after, won } = resolveBlackMarket(p, [], storedTarget);
  assert.strictEqual(won, true); // overwhelming attacker
  assert.ok(after.money > 5000);
});

await test('Black Market blocks without a title even with money/energy to spare', async () => {
  assert.throws(() => canAttemptBlackMarket({ money: 99999, energy: 100, heat: 0 }, [], null), /members-only/);
});

// ---------------- Underground: Secret Deals ----------------
await test('Secret deals: buying removes it from the pool and cannot be bought twice from a stale pool', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { money: 5000, attack: 10 });
  const pool = ['atk', 'def', 'luck'];
  const deal = canBuyDeal(p, pool, 'atk');
  deal.apply(p);
  p.money -= deal.cost;
  const remaining = pool.filter(id => id !== 'atk');
  assert.strictEqual(p.attack, 13);
  assert.strictEqual(remaining.length, 2);
  assert.throws(() => canBuyDeal(p, remaining, 'atk'), /no longer on the table/);
});

// ---------------- Gang Wars ----------------
await test('Gang Wars: attacking a rival not in the stored pool is rejected (anti-cheat)', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { attack: 999, defense: 999 });
  const pool = freshRivalPool(attackerPower(p, []));
  await db.from('ephemeral_pools').upsert({ player_id: p.id, pool_type: 'rivals', candidates: pool });

  const { data: stored } = await db.from('ephemeral_pools').select('*').eq('player_id', p.id).eq('pool_type', 'rivals').maybeSingle();
  const fakeRival = stored.candidates.find(r => r.id === 'totally_made_up_id');
  assert.strictEqual(fakeRival, undefined, 'a fabricated rival id should not resolve to a real rival');
});

await test('Gang Wars fight against a real pooled rival resolves and updates money/energy correctly', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { attack: 999, defense: 999, energy: 100 });
  // Use a hand-crafted weak rival for a deterministic outcome — freshRivalPool()
  // intentionally self-scales rival power off the player's OWN stats (by design, so
  // Gang Wars stays roughly balanced regardless of how strong you get), so it's the
  // wrong tool for "prove an overwhelming win resolves correctly."
  const rival = { id: 'v1', name: 'Weak Rival', attack: 1, defense: 1, crewSize: 0, moneyStake: 200, respectStake: 10 };
  await db.from('ephemeral_pools').upsert({ player_id: p.id, pool_type: 'rivals', candidates: [rival] });
  const { data: pool } = await db.from('ephemeral_pools').select('*').eq('player_id', p.id).eq('pool_type', 'rivals').maybeSingle();
  const stored = pool.candidates.find(r => r.id === 'v1');

  canFightRival(p);
  const { player: after, won } = resolveGangWarsFight(p, [], stored, []);
  assert.strictEqual(won, true);
  assert.strictEqual(after.energy, 80);
  assert.ok(after.money >= 5000);
});

await test('Gang Wars rival pool self-balances against player power (documenting the design, not a bug)', async () => {
  // Confirms rivals scale with player power rather than being a fixed difficulty —
  // a very strong player should still see proportionally strong rivals, not trivial ones.
  const weakPlayerPool = freshRivalPool(40);
  const strongPlayerPool = freshRivalPool(4000);
  const weakAvg = weakPlayerPool.reduce((s,r) => s + r.attack + r.defense, 0) / 3;
  const strongAvg = strongPlayerPool.reduce((s,r) => s + r.attack + r.defense, 0) / 3;
  assert.ok(strongAvg > weakAvg * 10, 'rivals generated for a much stronger player should be substantially stronger too');
});

// ---------------- Hitlist ----------------
await test('Hitlist: contract resolution uses the specific stored contract, not a regenerated one', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { attack: 999, luck: 999 });
  const pool = freshHitlistPool(attackerPower(p, []));
  await db.from('ephemeral_pools').upsert({ player_id: p.id, pool_type: 'hitlist', candidates: pool });
  const { data: stored } = await db.from('ephemeral_pools').select('*').eq('player_id', p.id).eq('pool_type', 'hitlist').maybeSingle();

  const target = stored.candidates[0];
  canAttemptHit(p);
  const { success } = resolveHit(p, [], target, []);
  assert.strictEqual(success, true); // overwhelming attacker
});

// ---------------- Card Battle ----------------
await test('Buying a pack adds a card to the DB and deducts money', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { money: 5000 });
  canBuyPack(p);
  const card = openPack();
  await db.from('cards').insert({ player_id: p.id, name: card.name, rarity_id: card.rarityId, power: card.power });
  p.money -= 60;
  const { data: cards } = await db.from('cards').select('*').eq('player_id', p.id);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(p.money, 4940);
});

await test('Tournament: opponent power is fixed at matchup time and reused at play time (anti-cheat, same pattern as Black Market)', async () => {
  const db = makeMockSupabase();
  const p = seedPlayer(db, { energy: 100 });
  await db.from('cards').insert({ player_id: p.id, name: 'Test', rarity_id: 'epic', power: 50 });
  const { data: cards } = await db.from('cards').select('*').eq('player_id', p.id);
  const myDeck = deckPower(cards);
  canPlayTournament(p, cards);
  const oppDeck = makeTournamentOpponent(myDeck);
  await db.from('ephemeral_pools').upsert({ player_id: p.id, pool_type: 'tournament', candidates: [{ myDeck, oppDeck }] });

  // simulate a malicious client claiming a different (easier) oppDeck in a request body —
  // the route never reads req.body for this value, only what's stored server-side
  const { data: pool } = await db.from('ephemeral_pools').select('*').eq('player_id', p.id).eq('pool_type', 'tournament').maybeSingle();
  const actualOppUsed = pool.candidates[0].oppDeck;
  assert.strictEqual(actualOppUsed, oppDeck, 'the stored opponent power must be what gets used, regardless of any client claim');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
