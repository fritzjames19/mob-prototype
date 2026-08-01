import {
  openPack, canBuyPack, deckPower, canPlayTournament, makeTournamentOpponent, resolvetournamentMatch,
  CARD_RARITIES, CARD_PACK_COST, TOURNAMENT_ENERGY_COST, NUMBER_CARDS,
} from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function player(overrides = {}) {
  return { money: 1000, energy: 100, tournament_wins: 0, tournament_losses: 0, tournament_points: 0, ...overrides };
}

test('openPack rarity distribution roughly matches weights over many pulls', () => {
  const counts = {};
  for (let i = 0; i < 3000; i++) {
    const c = openPack();
    counts[c.rarityId] = (counts[c.rarityId] || 0) + 1;
    const r = CARD_RARITIES.find(x => x.id === c.rarityId);
    assert.ok(c.power >= r.powerMin && c.power <= r.powerMax);
  }
  const commonPct = counts.common / 3000;
  assert.ok(commonPct > 0.53 && commonPct < 0.67, `common% was ${commonPct}, expected ~60%`);
  assert.ok(counts.legendary > 0, 'legendary should appear at least once in 3000 pulls (~3% expected)');
});

test('canBuyPack throws if not enough money', () => {
  assert.throws(() => canBuyPack(player({ money: 10 })), /Not enough money/);
  assert.doesNotThrow(() => canBuyPack(player({ money: CARD_PACK_COST })));
});

test('deckPower uses only the top 5 cards by power, not all cards', () => {
  const cards = [{power:10},{power:20},{power:30},{power:40},{power:50},{power:5}];
  assert.strictEqual(deckPower(cards), 10+20+30+40+50);
});

test('deckPower handles fewer than 5 cards gracefully', () => {
  assert.strictEqual(deckPower([{power:10},{power:20}]), 30);
  assert.strictEqual(deckPower([]), 0);
});

test('canPlayTournament throws with no cards or not enough energy', () => {
  assert.throws(() => canPlayTournament(player(), []), /at least one card/);
  assert.throws(() => canPlayTournament(player({ energy: 5 }), [{power:10}]), /Not enough energy/);
  assert.doesNotThrow(() => canPlayTournament(player(), [{power:10}]));
});

test('makeTournamentOpponent scales roughly with myDeck, never below 10', () => {
  for (let i = 0; i < 50; i++) {
    const opp = makeTournamentOpponent(100);
    assert.ok(opp >= 65 && opp <= 125, `opponent power ${opp} out of expected range`);
  }
  assert.ok(makeTournamentOpponent(1) >= 10);
});

test('resolvetournamentMatch: strong deck vs weak opponent wins, gains money and a point', () => {
  const p = player({ energy: 100 });
  const result = resolvetournamentMatch(p, 500, 10, []);
  assert.strictEqual(result.won, true);
  assert.strictEqual(result.player.energy, 100 - TOURNAMENT_ENERGY_COST);
  assert.strictEqual(result.player.tournament_wins, 1);
  assert.strictEqual(result.player.tournament_points, 10);
  assert.ok(result.moneyGain > 0);
});

test('resolvetournamentMatch: weak deck vs strong opponent loses, no reward, energy still spent', () => {
  const p = player({ energy: 100 });
  const result = resolvetournamentMatch(p, 10, 500, []);
  assert.strictEqual(result.won, false);
  assert.strictEqual(result.player.energy, 100 - TOURNAMENT_ENERGY_COST);
  assert.strictEqual(result.player.tournament_losses, 1);
  assert.strictEqual(result.moneyGain, 0);
});

test('resolvetournamentMatch: title reward only possible on a win, and only awards an UNOWNED number card', () => {
  let sawAward = false, sawCash = false;
  for (let i = 0; i < 200 && (!sawAward || !sawCash); i++) {
    const p = player({ energy: 10000 });
    const owned = NUMBER_CARDS.slice(0, -1).map(c => c.id); // own all but one
    const result = resolvetournamentMatch(p, 999999, 1, owned);
    if (result.awardTitleId) { sawAward = true; assert.ok(!owned.includes(result.awardTitleId)); }
  }
  // separately verify: if ALL are owned, falls back to cash
  const allOwned = NUMBER_CARDS.map(c => c.id);
  for (let i = 0; i < 100; i++) {
    const p = player({ energy: 10000 });
    const result = resolvetournamentMatch(p, 999999, 1, allOwned);
    if (result.cashRewardInstead > 0) { sawCash = true; assert.strictEqual(result.awardTitleId, null); }
  }
  assert.ok(sawAward, 'should see at least one title award in 200 wins with an available card');
  assert.ok(sawCash, 'should see cash fallback when all number cards are owned');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
