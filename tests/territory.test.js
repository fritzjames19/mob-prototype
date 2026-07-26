import {
  pendingIncome, rivalEffectivePower, playerDefensePower, attackerPower, resolveCombatRoll,
  canClaimNeutral, canAttack, canUpgrade, NEUTRAL_CLAIM_COST, TERRITORY_ATTACK_ENERGY_COST,
  INCOME_CAP_HOURS, UPGRADE_COSTS, TIER_MULT,
} from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function district(overrides = {}) {
  return { id: 'd_docks', owner_type: 'npc_rival', owner_ref: 'nr_sal', tier: 0, base_income: 7,
    last_collected: new Date().toISOString(), ...overrides };
}
function player(overrides = {}) {
  return { id: 'p1', money: 1000, energy: 100, heat: 0, attack: 20, defense: 10, territories_captured: 0, ...overrides };
}

test('pendingIncome is 0 immediately after collection', () => {
  assert.strictEqual(pendingIncome(district({ last_collected: new Date().toISOString() })), 0);
});

test('pendingIncome accrues proportionally to elapsed time', () => {
  const d = district({ last_collected: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), base_income: 10, tier: 0 });
  assert.strictEqual(pendingIncome(d), 20); // 10/hr * 2hr
});

test('pendingIncome caps at INCOME_CAP_HOURS', () => {
  const d = district({ last_collected: new Date(Date.now() - 100 * 3600 * 1000).toISOString(), base_income: 10, tier: 0 });
  assert.strictEqual(pendingIncome(d), 10 * INCOME_CAP_HOURS);
});

test('pendingIncome respects tier multiplier', () => {
  const d = district({ last_collected: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), base_income: 10, tier: 2 });
  assert.strictEqual(pendingIncome(d), Math.floor(10 * TIER_MULT[2]));
});

test('rivalEffectivePower scales with held districts and grudge, throws on unknown rival', () => {
  const base = rivalEffectivePower('nr_sal', 0, 0);
  const withHeld = rivalEffectivePower('nr_sal', 3, 0);
  const withGrudge = rivalEffectivePower('nr_sal', 0, 5);
  assert.ok(withHeld > base, 'more held districts should increase power');
  assert.ok(withGrudge > base, 'grudge should increase power');
  assert.throws(() => rivalEffectivePower('nr_totally_fake', 0, 0), /Unknown rival/);
});

test('rivalEffectivePower grudge caps at +40%', () => {
  const at5 = rivalEffectivePower('nr_sal', 0, 5);
  const at50 = rivalEffectivePower('nr_sal', 0, 50);
  assert.strictEqual(at5, at50, 'grudge beyond the cap should not keep increasing power');
});

test('playerDefensePower and attackerPower include gang contributions', () => {
  const p = player({ attack: 20, defense: 15 });
  const gang = [{ attack: 10, defense: 5 }, { attack: 8, defense: 4 }];
  assert.strictEqual(attackerPower(p, gang), 20 + 15 + 18 + 9);
  assert.strictEqual(playerDefensePower(p, gang), 20 + 15 + 18 + 9); // same formula, different role
  assert.strictEqual(attackerPower(p, []), 35, 'no gang should just be base stats');
});

test('resolveCombatRoll is deterministic given a fixed rand function, and favors the stronger side statistically', () => {
  const alwaysZero = () => 0;
  const r = resolveCombatRoll(100, 10, alwaysZero);
  assert.strictEqual(r.myRoll, 100);
  assert.strictEqual(r.theirRoll, 10);
  assert.strictEqual(r.won, true);

  // statistical check with real randomness: overwhelming power advantage should win almost always
  let wins = 0;
  for (let i = 0; i < 1000; i++) if (resolveCombatRoll(500, 10).won) wins++;
  assert.ok(wins > 990, `expected near-certain win with huge power gap, got ${wins}/1000`);
});

test('canClaimNeutral throws if district is not neutral', () => {
  assert.throws(() => canClaimNeutral(player(), district({ owner_type: 'npc_rival' })), /not unclaimed/);
});
test('canClaimNeutral throws if not enough money', () => {
  assert.throws(() => canClaimNeutral(player({ money: 10 }), district({ owner_type: 'neutral' })), /Not enough money/);
});
test('canClaimNeutral passes for an affordable neutral district', () => {
  assert.doesNotThrow(() => canClaimNeutral(player({ money: NEUTRAL_CLAIM_COST }), district({ owner_type: 'neutral' })));
});

test('canAttack throws when attacking a neutral district (should claim instead)', () => {
  assert.throws(() => canAttack(player(), district({ owner_type: 'neutral' })), /unclaimed/);
});
test('canAttack throws when attacking your own district', () => {
  const p = player({ id: 'p1' });
  assert.throws(() => canAttack(p, district({ owner_type: 'player', owner_ref: 'p1' })), /already own/);
});
test('canAttack throws when heat is Wanted or higher', () => {
  assert.throws(() => canAttack(player({ heat: 75 }), district()), /Too hot/);
});
test('canAttack throws when not enough energy', () => {
  assert.throws(() => canAttack(player({ energy: 5 }), district()), /Not enough energy/);
});
test('canAttack allows a valid attack on a rival district', () => {
  assert.doesNotThrow(() => canAttack(player(), district({ owner_type: 'npc_rival', owner_ref: 'nr_sal' })));
});
test('canAttack allows attacking another real player\'s district', () => {
  assert.doesNotThrow(() => canAttack(player({ id: 'p1' }), district({ owner_type: 'player', owner_ref: 'p2' })));
});

test('canUpgrade throws if you do not own the district', () => {
  assert.throws(() => canUpgrade(player(), district({ owner_type: 'npc_rival' })), /do not own/);
});
test('canUpgrade throws at max tier', () => {
  assert.throws(() => canUpgrade(player(), district({ owner_type: 'player', tier: 2 })), /max tier/);
});
test('canUpgrade throws if not enough money and returns cost otherwise', () => {
  assert.throws(() => canUpgrade(player({ money: 0 }), district({ owner_type: 'player', tier: 0 })), /Not enough money/);
  const cost = canUpgrade(player({ money: 99999 }), district({ owner_type: 'player', tier: 0 }));
  assert.strictEqual(cost, UPGRADE_COSTS[1]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
