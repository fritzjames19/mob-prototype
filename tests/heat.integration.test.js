import { makeMockSupabase } from './mockSupabase.js';
import { applyEnergyRegen, resolveHeatReduction, HEAT_METHODS } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function makeRouteHandler(db) {
  return async function reduceHeat(playerId, method) {
    const { data: player } = await db.from('players').select('*').eq('id', playerId).single();
    if (!player) throw Object.assign(new Error('No character found'), { status: 404 });
    const regenerated = applyEnergyRegen(player);
    const result = resolveHeatReduction(regenerated, method); // throws on invalid input, same as the real route
    await db.from('players').update({ energy: result.energy, money: result.money, heat: result.heat }).eq('id', player.id);
    return { player: result, method: HEAT_METHODS[method].label };
  };
}

function seedPlayer(db, overrides = {}) {
  const p = { id: 'p1', money: 1000, energy: 100, heat: 80, last_energy_tick: new Date().toISOString(), ...overrides };
  db._tables.players = [p];
  return p;
}

async function run() {
  await test('POST heat/reduce with laylow deducts energy and reduces heat, persists to DB', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { heat: 50, energy: 100 });
    const handler = makeRouteHandler(db);
    const result = await handler('p1', 'laylow');
    assert.strictEqual(result.player.energy, 85);
    assert.strictEqual(result.player.heat, 38);
    const dbRow = db._tables.players.find(p => p.id === 'p1');
    assert.strictEqual(dbRow.heat, 38, 'change should be persisted to the DB, not just returned');
  });

  await test('POST heat/reduce with bribe deducts the correct scaled cost', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { heat: 80, money: 1000 });
    const handler = makeRouteHandler(db);
    const result = await handler('p1', 'bribe');
    assert.strictEqual(result.player.money, 1000 - 480);
    assert.strictEqual(result.player.heat, 55);
  });

  await test('Invalid method returns a clean error, does not corrupt player state', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { heat: 80, money: 1000 });
    const handler = makeRouteHandler(db);
    let threw = null;
    try { await handler('p1', 'not_a_real_method'); } catch (e) { threw = e; }
    assert.ok(threw, 'should have thrown');
    assert.strictEqual(threw.status, 400);
    const dbRow = db._tables.players.find(p => p.id === 'p1');
    assert.strictEqual(dbRow.heat, 80, 'heat should be unchanged after a rejected request');
  });

  await test('Insufficient money for bribe is rejected and does not deduct anything', async () => {
    const db = makeMockSupabase();
    seedPlayer(db, { heat: 80, money: 10 });
    const handler = makeRouteHandler(db);
    await assert.rejects(() => handler('p1', 'bribe'), /Not enough money/);
    const dbRow = db._tables.players.find(p => p.id === 'p1');
    assert.strictEqual(dbRow.money, 10, 'money should be untouched on a rejected request');
    assert.strictEqual(dbRow.heat, 80, 'heat should be untouched on a rejected request');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run();
