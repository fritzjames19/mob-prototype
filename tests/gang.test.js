import { randomRecruit, freshRecruitPool, canRecruit } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

test('randomRecruit produces stats within documented ranges', () => {
  for (let i = 0; i < 200; i++) {
    const r = randomRecruit();
    assert.ok(r.attack >= 5 && r.attack <= 24, `attack out of range: ${r.attack}`);
    assert.ok(r.defense >= 5 && r.defense <= 24, `defense out of range: ${r.defense}`);
    assert.ok(r.loyalty >= 40 && r.loyalty <= 89, `loyalty out of range: ${r.loyalty}`);
    assert.ok(r.cost > 0, 'cost should always be positive');
    assert.ok(r.name.length > 0);
    assert.ok(r.id.startsWith('r'));
  }
});

test('randomRecruit cost formula matches (attack+defense)*3 + loyalty*1.2', () => {
  // Can't control randomness directly, so just verify the relationship holds across many samples
  for (let i = 0; i < 50; i++) {
    const r = randomRecruit();
    const expected = Math.round((r.attack + r.defense) * 3 + r.loyalty * 1.2);
    assert.strictEqual(r.cost, expected);
  }
});

test('randomRecruit ids are unique across many generations (no collisions)', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(randomRecruit().id);
  assert.strictEqual(ids.size, 500);
});

test('freshRecruitPool returns exactly 3 candidates', () => {
  const pool = freshRecruitPool();
  assert.strictEqual(pool.length, 3);
});

test('canRecruit throws if candidate is missing (already hired by someone else, or stale pool)', () => {
  assert.throws(() => canRecruit({ money: 1000 }, null), /no longer available/);
  assert.throws(() => canRecruit({ money: 1000 }, undefined), /no longer available/);
});

test('canRecruit throws if not enough money', () => {
  const candidate = { cost: 500 };
  assert.throws(() => canRecruit({ money: 100 }, candidate), /Not enough money/);
});

test('canRecruit passes when affordable', () => {
  const candidate = { cost: 500 };
  assert.doesNotThrow(() => canRecruit({ money: 500 }, candidate));
  assert.doesNotThrow(() => canRecruit({ money: 501 }, candidate));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
