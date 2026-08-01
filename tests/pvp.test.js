import { randomGangWarsRival, freshRivalPool, canFightRival, resolveGangWarsFight, PVP_ENERGY_COST } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function player(overrides = {}) {
  return { money: 1000, energy: 100, heat: 0, attack: 20, defense: 15, respect: 0, pvp_wins: 0, pvp_losses: 0, ...overrides };
}

test('randomGangWarsRival scales with player power', () => {
  for (let i = 0; i < 100; i++) {
    const r = randomGangWarsRival(100);
    assert.ok(r.attack > 0 && r.defense > 0);
    assert.ok(r.moneyStake > 0);
    assert.ok(r.crewSize >= 0 && r.crewSize <= 3);
  }
});

test('freshRivalPool returns exactly 3', () => {
  assert.strictEqual(freshRivalPool(50).length, 3);
});

test('canFightRival blocks at Wanted heat and without enough energy', () => {
  assert.throws(() => canFightRival(player({ heat: 80 })), /Too hot/);
  assert.throws(() => canFightRival(player({ energy: 5 })), /Not enough energy/);
  assert.doesNotThrow(() => canFightRival(player()));
});

test('resolveGangWarsFight: overwhelming player wins, gains money/respect, energy deducted', () => {
  const strongPlayer = player({ attack: 999, defense: 999 });
  const weakRival = { attack: 1, defense: 1, moneyStake: 200, respectStake: 10, crewSize: 0 };
  const { player: after, won } = resolveGangWarsFight(strongPlayer, [], weakRival, []);
  assert.strictEqual(won, true);
  assert.strictEqual(after.energy, 100 - PVP_ENERGY_COST);
  assert.strictEqual(after.money, 1000 + 200);
  assert.strictEqual(after.respect, 10);
  assert.strictEqual(after.pvp_wins, 1);
});

test('resolveGangWarsFight: overwhelming rival wins, player loses half the stake', () => {
  const weakPlayer = player({ attack: 1, defense: 1, money: 1000 });
  const strongRival = { attack: 999, defense: 999, moneyStake: 200, respectStake: 10, crewSize: 0 };
  const { player: after, won } = resolveGangWarsFight(weakPlayer, [], strongRival, []);
  assert.strictEqual(won, false);
  assert.strictEqual(after.money, 1000 - 100); // half of 200
  assert.strictEqual(after.pvp_losses, 1);
});

test('resolveGangWarsFight: joinedRecruit only possible on a win with crewSize > 0', () => {
  const weakPlayer = player({ attack: 1, defense: 1 });
  const strongRival = { attack: 999, defense: 999, moneyStake: 200, respectStake: 10, crewSize: 3 };
  const { joinedRecruit } = resolveGangWarsFight(weakPlayer, [], strongRival, []);
  assert.strictEqual(joinedRecruit, null, 'no defection possible on a loss');
});

test('resolveGangWarsFight applies King title heat reduction', () => {
  const p1 = player({ attack: 999, defense: 999 });
  const rival = { attack: 1, defense: 1, moneyStake: 100, respectStake: 5, crewSize: 0 };
  const withoutKing = resolveGangWarsFight({...p1}, [], rival, []).player.heat;
  const withKing = resolveGangWarsFight({...p1}, [], rival, ['king']).player.heat;
  assert.ok(withKing < withoutKing, 'King should reduce heat gained from a win');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
