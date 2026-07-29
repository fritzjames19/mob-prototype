import { resolveHeatReduction, heatMethodCost, HEAT_METHODS } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function player(overrides = {}) {
  return { energy: 100, money: 1000, heat: 80, ...overrides };
}

test('laylow costs energy, not money, and reduces heat by 12', () => {
  const p = player({ energy: 100, heat: 50 });
  const result = resolveHeatReduction(p, 'laylow');
  assert.strictEqual(result.energy, 85);
  assert.strictEqual(result.heat, 38);
});

test('laylow throws if not enough energy', () => {
  assert.throws(() => resolveHeatReduction(player({ energy: 5 }), 'laylow'), /Not enough energy/);
});

test('bribe cost scales with current heat, minimum 20', () => {
  assert.strictEqual(heatMethodCost('bribe', player({ heat: 80 })), 480); // 80*6
  assert.strictEqual(heatMethodCost('bribe', player({ heat: 1 })), 20);  // floor at 20, not 6
});

test('bribe deducts correct cost and reduces heat by 25', () => {
  const p = player({ money: 1000, heat: 80 });
  const result = resolveHeatReduction(p, 'bribe');
  assert.strictEqual(result.money, 1000 - 480);
  assert.strictEqual(result.heat, 55);
});

test('bribe throws if not enough money', () => {
  assert.throws(() => resolveHeatReduction(player({ money: 10, heat: 80 }), 'bribe'), /Not enough money/);
});

test('lawyer cost scales with current heat, minimum 15, cheaper than bribe', () => {
  const p1 = player({ heat: 80 });
  assert.strictEqual(heatMethodCost('lawyer', p1), 320); // 80*4
  assert.ok(heatMethodCost('lawyer', p1) < heatMethodCost('bribe', p1), 'lawyer should be cheaper than bribe at same heat');
});

test('lawyer reduces heat by 15', () => {
  const p = player({ money: 1000, heat: 80 });
  const result = resolveHeatReduction(p, 'lawyer');
  assert.strictEqual(result.money, 1000 - 320);
  assert.strictEqual(result.heat, 65);
});

test('heat never goes below 0', () => {
  const p = player({ heat: 5, energy: 100 });
  const result = resolveHeatReduction(p, 'laylow');
  assert.strictEqual(result.heat, 0);
});

test('unknown method throws clearly', () => {
  assert.throws(() => resolveHeatReduction(player(), 'totally_fake_method'), /Unknown heat management method/);
});

test('all three methods produce a real, non-zero heat reduction', () => {
  Object.keys(HEAT_METHODS).forEach(key => {
    const p = player({ heat: 90, money: 99999, energy: 100 });
    const before = p.heat;
    resolveHeatReduction(p, key);
    assert.ok(p.heat < before, `${key} should reduce heat`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
