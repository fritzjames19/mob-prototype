import { titleBonusMult, applyHeatGain, canBuyTitle, allTitleDefs, titleDef, ownsAnyTitle, NUMBER_CARDS, PREMIUM_TITLES } from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

test('allTitleDefs includes all 9 number cards and 4 premium titles', () => {
  const all = allTitleDefs();
  assert.strictEqual(all.length, 13);
});

test('titleDef finds both number cards and premium titles by id', () => {
  assert.strictEqual(titleDef('card5').cost, NUMBER_CARDS.find(c=>c.id==='card5').cost);
  assert.strictEqual(titleDef('king').name, 'King');
  assert.strictEqual(titleDef('not_real'), undefined);
});

test('ownsAnyTitle correctly reflects empty vs non-empty', () => {
  assert.strictEqual(ownsAnyTitle([]), false);
  assert.strictEqual(ownsAnyTitle(null), false);
  assert.strictEqual(ownsAnyTitle(['card2']), true);
});

test('titleBonusMult returns 1 (no bonus) when title not owned', () => {
  assert.strictEqual(titleBonusMult([], 'money'), 1);
  assert.strictEqual(titleBonusMult(['card2'], 'money'), 1); // number card, no bonus
});

test('titleBonusMult applies Jack (+6% money), Queen (+6% respect), Ace (+8% xp) correctly', () => {
  assert.strictEqual(titleBonusMult(['jack'], 'money'), 1.06);
  assert.strictEqual(titleBonusMult(['queen'], 'respect'), 1.06);
  assert.strictEqual(titleBonusMult(['ace'], 'xp'), 1.08);
});

test('titleBonusMult applies King heat REDUCTION as a sub-1 multiplier', () => {
  assert.strictEqual(titleBonusMult(['king'], 'heat'), 0.85);
});

test('applyHeatGain reduces heat gain by 15% with King, unaffected without', () => {
  assert.strictEqual(applyHeatGain(20, []), 20);
  assert.strictEqual(applyHeatGain(20, ['king']), 17); // round(20*0.85)=17
});

test('canBuyTitle throws on unknown title, already-owned, or unaffordable', () => {
  const player = { money: 1000 };
  assert.throws(() => canBuyTitle(player, [], 'not_real'), /Unknown title/);
  assert.throws(() => canBuyTitle(player, ['jack'], 'jack'), /already own/);
  assert.throws(() => canBuyTitle({ money: 1 }, [], 'king'), /Not enough money/);
  assert.doesNotThrow(() => canBuyTitle(player, [], 'card2'));
});

test('Number cards have no bonusType, only premium titles do', () => {
  NUMBER_CARDS.forEach(c => assert.strictEqual(c.bonusType, undefined));
  Object.values(PREMIUM_TITLES).forEach(t => assert.ok(t.bonusType));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
