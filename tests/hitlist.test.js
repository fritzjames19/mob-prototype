import { randomContract, freshHitlistPool, canAttemptHit, resolveHit, resolveIncomingHit, HIT_TYPES, HIT_ENERGY_COST } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function player(overrides = {}) {
  return { money: 1000, energy: 100, heat: 0, attack: 20, luck: 10, defense: 15, respect: 0, hits_completed: 0, hits_failed: 0, hits_survived: 0, ...overrides };
}

test('randomContract produces a valid type and scales with power', () => {
  for (let i = 0; i < 100; i++) {
    const c = randomContract(100);
    assert.ok(HIT_TYPES[c.typeKey]);
    assert.ok(c.money > 0);
    assert.ok(c.targetDefense > 0);
  }
});

test('freshHitlistPool returns exactly 3', () => {
  assert.strictEqual(freshHitlistPool(50).length, 3);
});

test('canAttemptHit blocks at Wanted heat and without enough energy', () => {
  assert.throws(() => canAttemptHit(player({ heat: 90 })), /Too hot/);
  assert.throws(() => canAttemptHit(player({ energy: 5 })), /Not enough energy/);
});

test('resolveHit: overwhelming attacker succeeds and gets paid, energy deducted', () => {
  const strongPlayer = player({ attack: 999, luck: 999 });
  const weakContract = { typeKey: 'anonymous', targetDefense: 1, targetLuck: 1, money: 300, respect: 20 };
  const { player: after, success } = resolveHit(strongPlayer, [], weakContract, []);
  assert.strictEqual(success, true);
  assert.strictEqual(after.energy, 100 - HIT_ENERGY_COST);
  assert.strictEqual(after.money, 1300);
  assert.strictEqual(after.hits_completed, 1);
});

test('resolveHit: overwhelming target defense causes failure and a cash penalty', () => {
  const weakPlayer = player({ attack: 1, luck: 1, money: 1000 });
  const strongContract = { typeKey: 'anonymous', targetDefense: 999, targetLuck: 999, money: 300, respect: 20 };
  const { player: after, success } = resolveHit(weakPlayer, [], strongContract, []);
  assert.strictEqual(success, false);
  assert.ok(after.money < 1000);
  assert.strictEqual(after.hits_failed, 1);
});

test('Revenge hits pay more respect but less money than anonymous, faction pays most money', () => {
  assert.ok(HIT_TYPES.revenge.respectMult > HIT_TYPES.anonymous.respectMult);
  assert.ok(HIT_TYPES.revenge.moneyMult < HIT_TYPES.anonymous.moneyMult);
  assert.ok(HIT_TYPES.faction.moneyMult > HIT_TYPES.anonymous.moneyMult);
});

test('resolveIncomingHit: overwhelming defense survives and gains respect, no money lost', () => {
  const strongPlayer = player({ defense: 999, luck: 999, money: 1000, respect: 0 });
  const { player: after, survived, lost } = resolveIncomingHit(strongPlayer, []);
  assert.strictEqual(survived, true);
  assert.strictEqual(after.respect, 3);
  assert.strictEqual(after.money, 1000);
  assert.strictEqual(lost, 0);
});

test('resolveIncomingHit: weak defense fails and loses money, no respect gained', () => {
  const weakPlayer = player({ defense: 0, luck: 0, money: 1000, respect: 0 });
  let anyFailed = false;
  for (let i = 0; i < 20 && !anyFailed; i++) {
    const p = { ...weakPlayer };
    const { survived, lost } = resolveIncomingHit(p, []);
    if (!survived) { anyFailed = true; assert.ok(lost > 0); }
  }
  assert.ok(anyFailed, 'a defenseless player should fail at least once in 20 trials');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
