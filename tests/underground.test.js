import {
  randomEliteTarget, canAttemptBlackMarket, resolveBlackMarket, BLACK_MARKET_COOLDOWN_MS, BLACK_MARKET_ENERGY_COST,
  freshDealsPool, canBuyDeal, SECRET_DEAL_TEMPLATES,
} from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}

function player(overrides = {}) {
  return { money: 1000, energy: 100, heat: 0, attack: 20, luck: 10, respect: 0, hits_completed: 0, hits_failed: 0, ...overrides };
}

test('randomEliteTarget scales with player power and has sane stat ranges', () => {
  for (let i = 0; i < 100; i++) {
    const t = randomEliteTarget(100);
    assert.ok(t.defense > 0);
    assert.ok(t.luck >= 8 && t.luck <= 19);
    assert.ok(t.money >= 300);
    assert.ok(t.name.length > 0);
  }
});

test('canAttemptBlackMarket requires owning a title', () => {
  assert.throws(() => canAttemptBlackMarket(player(), [], null), /members-only/);
  assert.doesNotThrow(() => canAttemptBlackMarket(player(), ['card2'], null));
});

test('canAttemptBlackMarket blocks at Wanted heat', () => {
  assert.throws(() => canAttemptBlackMarket(player({ heat: 75 }), ['card2'], null), /Too hot/);
});

test('canAttemptBlackMarket blocks without enough energy', () => {
  assert.throws(() => canAttemptBlackMarket(player({ energy: 10 }), ['card2'], null), /Not enough energy/);
});

test('canAttemptBlackMarket enforces cooldown, blocks if used recently', () => {
  const recentUse = new Date(Date.now() - 1000).toISOString(); // 1 second ago
  assert.throws(() => canAttemptBlackMarket(player(), ['card2'], recentUse), /cooling off/);
});

test('canAttemptBlackMarket allows once cooldown has expired', () => {
  const oldUse = new Date(Date.now() - BLACK_MARKET_COOLDOWN_MS - 1000).toISOString();
  assert.doesNotThrow(() => canAttemptBlackMarket(player(), ['card2'], oldUse));
});

test('resolveBlackMarket: overwhelming attacker always wins, weak target loses money on failure otherwise', () => {
  const strongPlayer = player({ attack: 999, luck: 999 });
  const weakTarget = { defense: 1, luck: 1, money: 500, respect: 30 };
  const { player: after, won } = resolveBlackMarket(strongPlayer, [], weakTarget);
  assert.strictEqual(won, true);
  assert.strictEqual(after.energy, 100 - BLACK_MARKET_ENERGY_COST);
  assert.ok(after.money > 1000);
  assert.strictEqual(after.hits_completed, 1);
});

test('resolveBlackMarket: overwhelming defender means attacker loses and pays a penalty', () => {
  const weakPlayer = player({ attack: 1, luck: 1, money: 1000 });
  const strongTarget = { defense: 999, luck: 999, money: 500, respect: 30 };
  const { player: after, won } = resolveBlackMarket(weakPlayer, [], strongTarget);
  assert.strictEqual(won, false);
  assert.ok(after.money < 1000);
  assert.strictEqual(after.hits_failed, 1);
});

test('freshDealsPool returns exactly 3 unique deal ids from the catalog', () => {
  const pool = freshDealsPool();
  assert.strictEqual(pool.length, 3);
  assert.strictEqual(new Set(pool).size, 3);
  pool.forEach(id => assert.ok(SECRET_DEAL_TEMPLATES[id]));
});

test('canBuyDeal throws if deal not in pool or unaffordable, returns the deal otherwise', () => {
  const pool = ['atk', 'def'];
  assert.throws(() => canBuyDeal(player(), pool, 'luck'), /no longer on the table/);
  assert.throws(() => canBuyDeal(player({ money: 1 }), pool, 'atk'), /Not enough money/);
  const deal = canBuyDeal(player(), pool, 'atk');
  assert.strictEqual(deal.id, 'atk');
});

test('Secret deal apply() functions actually modify the player correctly', () => {
  const p = player({ attack: 10, defense: 10, luck: 10, max_energy: 100, energy: 50, respect: 0 });
  SECRET_DEAL_TEMPLATES.atk.apply(p);
  assert.strictEqual(p.attack, 13);
  SECRET_DEAL_TEMPLATES.def.apply(p);
  assert.strictEqual(p.defense, 13);
  SECRET_DEAL_TEMPLATES.luck.apply(p);
  assert.strictEqual(p.luck, 13);
  SECRET_DEAL_TEMPLATES.energy.apply(p);
  assert.strictEqual(p.max_energy, 110);
  assert.strictEqual(p.energy, 60);
  SECRET_DEAL_TEMPLATES.respect.apply(p);
  assert.strictEqual(p.respect, 15);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
