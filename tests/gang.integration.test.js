import { makeMockSupabase } from './mockSupabase.js';
import { freshRecruitPool, canRecruit } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log('PASS:', name); passed++; }
    catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
  })();
}

function makeApp(db) {
  async function getPlayer(id) { const { data } = await db.from('players').select('*').eq('id', id).single(); return data; }
  async function getPool(playerId) { const { data } = await db.from('recruit_pools').select('*').eq('player_id', playerId).maybeSingle(); return data; }
  async function savePool(playerId, candidates) { await db.from('recruit_pools').upsert({ player_id: playerId, candidates }); }

  return {
    async viewRecruits(playerId) {
      let pool = await getPool(playerId);
      if (!pool || !pool.candidates || pool.candidates.length === 0) {
        const candidates = freshRecruitPool();
        await savePool(playerId, candidates);
        return { candidates };
      }
      return { candidates: pool.candidates };
    },
    async refreshRecruits(playerId) {
      const candidates = freshRecruitPool();
      await savePool(playerId, candidates);
      return { candidates };
    },
    async hire(playerId, candidateId) {
      const player = await getPlayer(playerId);
      const pool = await getPool(playerId);
      const candidate = (pool && pool.candidates || []).find(c => c.id === candidateId);
      canRecruit(player, candidate); // throws if missing or unaffordable

      await db.from('gang_members').insert({ player_id: playerId, name: candidate.name, attack: candidate.attack, defense: candidate.defense, loyalty: candidate.loyalty });
      const newMoney = player.money - candidate.cost;
      await db.from('players').update({ money: newMoney }).eq('id', playerId);

      let remaining = pool.candidates.filter(c => c.id !== candidateId);
      if (remaining.length === 0) remaining = freshRecruitPool();
      await savePool(playerId, remaining);
      return { money: newMoney, hired: candidate.name, candidates: remaining };
    },
    async viewGang(playerId) {
      const { data } = await db.from('gang_members').select('*').eq('player_id', playerId);
      return { gang: data };
    },
    async dismiss(playerId, memberId) {
      const { data: member } = await db.from('gang_members').select('*').eq('id', memberId).eq('player_id', playerId).maybeSingle();
      if (!member) throw Object.assign(new Error('That gang member is not yours'), { status: 404 });
      await db.from('gang_members').delete().eq('id', memberId);
      return { dismissed: member.name };
    },
  };
}

function seedPlayer(db, overrides = {}) {
  const p = { id: 'p1', money: 1000, ...overrides };
  db._tables.players = db._tables.players || [];
  db._tables.players.push(p);
  return p;
}

async function run() {
  await test('First view of recruits generates and persists a pool of 3', async () => {
    const db = makeMockSupabase();
    seedPlayer(db);
    const app = makeApp(db);
    const result = await app.viewRecruits('p1');
    assert.strictEqual(result.candidates.length, 3);
    const stored = db._tables.recruit_pools.find(r => r.player_id === 'p1');
    assert.ok(stored, 'pool should be persisted');
    assert.strictEqual(stored.candidates.length, 3);
  });

  await test('Viewing recruits again returns the SAME pool, not a new random one', async () => {
    const db = makeMockSupabase();
    seedPlayer(db);
    const app = makeApp(db);
    const first = await app.viewRecruits('p1');
    const second = await app.viewRecruits('p1');
    assert.deepStrictEqual(first.candidates.map(c => c.id), second.candidates.map(c => c.id));
  });

  await test('Refreshing recruits replaces the pool with new candidates', async () => {
    const db = makeMockSupabase();
    seedPlayer(db);
    const app = makeApp(db);
    const first = await app.viewRecruits('p1');
    const refreshed = await app.refreshRecruits('p1');
    const idsOverlap = first.candidates.some(c => refreshed.candidates.some(r => r.id === c.id));
    assert.ok(!idsOverlap, 'refreshed pool should have entirely different candidate ids');
  });

  await test('Hiring a real candidate deducts the EXACT stored cost and adds them to the gang', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { money: 10000 });
    const app = makeApp(db);
    const { candidates } = await app.viewRecruits('p1');
    const target = candidates[0];
    const result = await app.hire('p1', target.id);
    assert.strictEqual(result.money, 10000 - target.cost);
    const gang = (db._tables.gang_members || []).filter(g => g.player_id === 'p1');
    assert.strictEqual(gang.length, 1);
    assert.strictEqual(gang[0].attack, target.attack);
    assert.strictEqual(gang[0].name, target.name);
  });

  await test('CRITICAL: cannot hire a candidate that does not exist in the stored pool (anti-cheat)', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { money: 10000 });
    const app = makeApp(db);
    await app.viewRecruits('p1'); // establishes a real pool
    // attacker tries to hire a made-up candidate id with invented cheap stats — this should fail
    // because the server looks up by id in the REAL stored pool, not anything the client sent
    await assert.rejects(() => app.hire('p1', 'fake_candidate_id_i_made_up'), /no longer available/);
    const gang = (db._tables.gang_members || []).filter(g => g.player_id === 'p1');
    assert.strictEqual((gang || []).length, 0, 'no gang member should have been created');
  });

  await test('Cannot hire if not enough money, gang and money remain unchanged', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { money: 1 });
    const app = makeApp(db);
    const { candidates } = await app.viewRecruits('p1');
    await assert.rejects(() => app.hire('p1', candidates[0].id), /Not enough money/);
    const player = db._tables.players.find(p => p.id === 'p1');
    assert.strictEqual(player.money, 1);
  });

  await test('Hired candidate is removed from the pool, and pool refills to 3 if it would hit 0', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { money: 999999 });
    const app = makeApp(db);
    const { candidates } = await app.viewRecruits('p1');
    let poolNow = candidates;
    for (const c of candidates) {
      const result = await app.hire('p1', c.id);
      poolNow = result.candidates;
    }
    // after hiring all 3, pool should have auto-refilled to 3 fresh ones instead of staying empty
    assert.strictEqual(poolNow.length, 3);
    const gang = (db._tables.gang_members || []).filter(g => g.player_id === 'p1');
    assert.strictEqual(gang.length, 3);
  });

  await test('Dismissing a gang member removes them with no refund', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { money: 500 });
    const app = makeApp(db);
    const { candidates } = await app.viewRecruits('p1');
    await app.hire('p1', candidates[0].id);
    const gangBefore = (await app.viewGang('p1')).gang;
    assert.strictEqual(gangBefore.length, 1);

    const moneyBeforeDismiss = db._tables.players.find(p => p.id === 'p1').money;
    await app.dismiss('p1', gangBefore[0].id);
    const gangAfter = (await app.viewGang('p1')).gang;
    assert.strictEqual(gangAfter.length, 0);
    const moneyAfterDismiss = db._tables.players.find(p => p.id === 'p1').money;
    assert.strictEqual(moneyAfterDismiss, moneyBeforeDismiss, 'dismissing should not refund any money');
  });

  await test('Cannot dismiss another player\'s gang member', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { id: 'p1', money: 999999 });
    seedPlayer(db, { id: 'p2', money: 999999 });
    const app = makeApp(db);
    const { candidates } = await app.viewRecruits('p1');
    await app.hire('p1', candidates[0].id);
    const p1Gang = (await app.viewGang('p1')).gang;
    await assert.rejects(() => app.dismiss('p2', p1Gang[0].id), /not yours/);
    const stillThere = (await app.viewGang('p1')).gang;
    assert.strictEqual(stillThere.length, 1, "p1's gang member should be untouched");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
