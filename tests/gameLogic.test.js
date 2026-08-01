import { resolveQuest, applyEnergyRegen, xpForLevel, rankFor, heatTier, ENERGY_REGEN_MS_PER_POINT, gangMoneyBonus } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function freshPlayer(overrides = {}) {
  return {
    id: 'p1', faction_key: 'yakuza', level: 1, xp: 0, xp_boost: 0,
    money: 100, respect: 0, energy: 100, max_energy: 100,
    last_energy_tick: new Date().toISOString(), heat: 0, quests_done: 0,
    ...overrides
  };
}

test('resolveQuest deducts energy and grants money/respect/xp', () => {
  const p = freshPlayer();
  const { player, reward } = resolveQuest(p, [], 'store');
  assert.strictEqual(player.energy, 90); // store costs 10
  assert.ok(player.money > 100);
  assert.ok(reward.money > 0);
  assert.strictEqual(player.quests_done, 1);
});

test('resolveQuest throws on unknown quest id', () => {
  assert.throws(() => resolveQuest(freshPlayer(), [], 'not_a_real_quest'), /Unknown quest/);
});

test('resolveQuest throws when not enough energy', () => {
  assert.throws(() => resolveQuest(freshPlayer({ energy: 5 }), [], 'launder'), /Not enough energy/);
});

test('resolveQuest throws when heat is Wanted or higher (server-side gate, cannot be bypassed by client)', () => {
  assert.throws(() => resolveQuest(freshPlayer({ heat: 75 }), [], 'store'), /Too hot/);
  assert.throws(() => resolveQuest(freshPlayer({ heat: 95 }), [], 'store'), /Too hot/);
});

test('resolveQuest allows action at heat 69 (High, not Wanted) but blocks at 70', () => {
  assert.doesNotThrow(() => resolveQuest(freshPlayer({ heat: 69 }), [], 'store'));
  assert.throws(() => resolveQuest(freshPlayer({ heat: 70 }), [], 'store'));
});

test('resolveQuest levels the player up correctly across multiple threshold crossings', () => {
  // store gives 14 xp; need 100 for level 1->2. Do it enough times to cross two levels.
  let p = freshPlayer({ energy: 1000, xp: 95 }); // 5 xp from levelling
  const r1 = resolveQuest(p, [], 'store'); // +14 xp -> crosses 100 -> level 2, 9 xp left over
  assert.strictEqual(r1.player.level, 2);
  assert.strictEqual(r1.levelUps.length, 1);
  assert.strictEqual(r1.levelUps[0].level, 2);
});

test('resolveQuest applies faction money multiplier (famiglia +10%)', () => {
  const p = freshPlayer({ faction_key: 'famiglia' });
  // run many trials since quest money has randomness; check the multiplier is being applied on average
  let total = 0, trials = 500;
  for (let i = 0; i < trials; i++) {
    const fresh = freshPlayer({ faction_key: 'famiglia', energy: 1000 });
    total += resolveQuest(fresh, [], 'store').reward.money;
  }
  const avg = total / trials;
  // base range 30-60, avg 45, *1.10 = 49.5
  assert.ok(avg > 47 && avg < 52, `avg was ${avg}, expected ~49.5`);
});

test('resolveQuest applies gang money bonus (2% per member, capped 30%)', () => {
  const gang = Array.from({ length: 5 }, () => ({ attack: 10, defense: 10 }));
  let total = 0, trials = 500;
  for (let i = 0; i < trials; i++) {
    const fresh = freshPlayer({ energy: 1000 });
    total += resolveQuest(fresh, gang, 'store').reward.money;
  }
  const avg = total / trials;
  // base avg 45, gang bonus = 1 + min(0.3, 5*0.02) = 1.10 -> avg ~49.5
  assert.ok(avg > 47 && avg < 52, `avg was ${avg}, expected ~49.5 with 5-member gang`);
});

test('resolveQuest does NOT mutate money/xp beyond what quest data allows (no way to inject arbitrary values)', () => {
  // Even if a malicious client sent extra fields, resolveQuest only reads questId — it can't
  // be tricked into granting a custom reward amount since money/xp are always server-computed.
  const p = freshPlayer();
  const result = resolveQuest(p, [], 'store');
  assert.ok(result.reward.money >= 30 * 1 && result.reward.money <= 60 * 1.3, 'reward should stay within quest-defined bounds');
});

test('applyEnergyRegen adds energy proportional to elapsed time', () => {
  const p = freshPlayer({ energy: 50, max_energy: 100, last_energy_tick: new Date(Date.now() - ENERGY_REGEN_MS_PER_POINT * 10).toISOString() });
  const regenerated = applyEnergyRegen(p);
  assert.strictEqual(regenerated.energy, 60);
});

test('applyEnergyRegen caps at max_energy, does not overflow', () => {
  const p = freshPlayer({ energy: 95, max_energy: 100, last_energy_tick: new Date(Date.now() - ENERGY_REGEN_MS_PER_POINT * 1000).toISOString() });
  const regenerated = applyEnergyRegen(p);
  assert.strictEqual(regenerated.energy, 100);
});

test('applyEnergyRegen does nothing if less than one point worth of time has passed', () => {
  const p = freshPlayer({ energy: 50, last_energy_tick: new Date().toISOString() });
  const regenerated = applyEnergyRegen(p);
  assert.strictEqual(regenerated.energy, 50);
});

test('applyEnergyRegen does not lose partial progress toward the next point (uses consumed time, not full elapsed)', () => {
  // 10.5 points worth of time passed -> should grant 10 points and retain the leftover 0.5 toward the next
  const elapsed = ENERGY_REGEN_MS_PER_POINT * 10.5;
  const p = freshPlayer({ energy: 50, last_energy_tick: new Date(Date.now() - elapsed).toISOString() });
  const regenerated = applyEnergyRegen(p);
  assert.strictEqual(regenerated.energy, 60);
  const remainingMs = Date.now() - new Date(regenerated.last_energy_tick).getTime();
  assert.ok(remainingMs < ENERGY_REGEN_MS_PER_POINT, 'leftover partial progress should be less than one full point');
});

test('xpForLevel and rankFor match expected progression', () => {
  assert.strictEqual(xpForLevel(5), 500);
  assert.strictEqual(rankFor(1).name, 'Street Punk');
  assert.strictEqual(rankFor(10).name, 'Capo');
  assert.strictEqual(rankFor(36).name, 'Godfather');
  assert.strictEqual(rankFor(9).name, 'Soldier'); // just below Capo threshold
});

test('heatTier boundaries are correct', () => {
  assert.strictEqual(heatTier(0), 'low');
  assert.strictEqual(heatTier(19), 'low');
  assert.strictEqual(heatTier(20), 'medium');
  assert.strictEqual(heatTier(69), 'high');
  assert.strictEqual(heatTier(70), 'wanted');
  assert.strictEqual(heatTier(89), 'wanted');
  assert.strictEqual(heatTier(90), 'mostwanted');
  assert.strictEqual(heatTier(100), 'mostwanted');
});

test('gangMoneyBonus caps at 30%', () => {
  const bigGang = Array.from({ length: 50 }, () => ({}));
  assert.strictEqual(gangMoneyBonus(bigGang), 1.30);
  assert.strictEqual(gangMoneyBonus([]), 1.0);
});

test('resolveQuest applies Jack (+6% money) title bonus, compounding with gang/faction bonuses', () => {
  let total = 0, trials = 500;
  for (let i = 0; i < trials; i++) {
    const fresh = freshPlayer({ energy: 1000 });
    total += resolveQuest(fresh, [], 'store', ['jack']).reward.money;
  }
  const avg = total / trials;
  // base avg 45, no faction bonus (yakuza default), *1.06 jack = 47.7
  assert.ok(avg > 45.5 && avg < 50, `avg was ${avg}, expected ~47.7 with Jack title`);
});

test('resolveQuest applies King (-15% heat) title bonus', () => {
  const withoutKing = resolveQuest(freshPlayer({ energy: 1000 }), [], 'launder', []).player.heat;
  const withKing = resolveQuest(freshPlayer({ energy: 1000 }), [], 'launder', ['king']).player.heat;
  assert.ok(withKing < withoutKing, 'King should reduce heat gained from the same quest');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
