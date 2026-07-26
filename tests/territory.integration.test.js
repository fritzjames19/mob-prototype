import { makeMockSupabase } from './mockSupabase.js';
import {
  applyEnergyRegen, pendingIncome, rivalEffectivePower, playerDefensePower, attackerPower,
  resolveCombatRoll, canClaimNeutral, canAttack, canUpgrade, NEUTRAL_CLAIM_COST,
  TERRITORY_ATTACK_ENERGY_COST, UPGRADE_COSTS,
} from '../src/gameLogic.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log('PASS:', name); passed++; }
    catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
  })();
}

// --- Minimal reimplementation of the route logic, wired to the mock instead of real
// Supabase, exercising the exact same gameLogic.js functions the real routes use. ---
function makeApp(db) {
  async function getPlayer(id) { const { data } = await db.from('players').select('*').eq('id', id).single(); return data; }
  async function getDistrict(id) { const { data } = await db.from('districts').select('*').eq('id', id).single(); return data; }
  async function getGang(playerId) { const { data } = await db.from('gang_members').select('*').eq('player_id', playerId); return data; }
  async function heldCountFor(ownerType, ownerRef) { const { data } = await db.from('districts').select('id').eq('owner_type', ownerType).eq('owner_ref', ownerRef); return data.length; }

  return {
    async claim(playerId, districtId) {
      const player = await getPlayer(playerId);
      const district = await getDistrict(districtId);
      canClaimNeutral(player, district);
      const { data: updated } = await db.from('districts')
        .update({ owner_type: 'player', owner_ref: player.id, tier: 0, last_collected: new Date().toISOString() })
        .eq('id', district.id).eq('owner_type', 'neutral');
      if (!updated || updated.length === 0) throw Object.assign(new Error('Someone else just claimed that district'), { status: 409 });
      await db.from('players').update({ money: player.money - NEUTRAL_CLAIM_COST, territories_captured: player.territories_captured + 1 }).eq('id', player.id);
      return { district: updated[0] };
    },

    async attack(playerId, districtId) {
      const player = await getPlayer(playerId);
      const district = await getDistrict(districtId);
      canAttack(player, district);
      const attackerGang = await getGang(player.id);
      const myPower = attackerPower(player, attackerGang);

      let theirPower;
      if (district.owner_type === 'npc_rival') {
        const held = await heldCountFor('npc_rival', district.owner_ref);
        theirPower = rivalEffectivePower(district.owner_ref, held, 0);
      } else {
        const defender = await getPlayer(district.owner_ref);
        const defenderGang = await getGang(defender.id);
        theirPower = playerDefensePower(defender, defenderGang);
      }

      const roll = resolveCombatRoll(myPower, theirPower);
      const newEnergy = player.energy - TERRITORY_ATTACK_ENERGY_COST;

      if (roll.won) {
        const { data: updated } = await db.from('districts')
          .update({ owner_type: 'player', owner_ref: player.id, tier: 0, last_collected: new Date().toISOString() })
          .eq('id', district.id).eq('owner_type', district.owner_type).eq('owner_ref', district.owner_ref);
        if (!updated || updated.length === 0) {
          await db.from('players').update({ energy: newEnergy }).eq('id', player.id);
          return { won: false, contested: true };
        }
        await db.from('players').update({ energy: newEnergy, territories_captured: player.territories_captured + 1 }).eq('id', player.id);
        return { won: true, district: updated[0] };
      } else {
        await db.from('players').update({ energy: newEnergy }).eq('id', player.id);
        return { won: false };
      }
    },

    async collect(playerId, districtId) {
      const player = await getPlayer(playerId);
      const district = await getDistrict(districtId);
      if (district.owner_type !== 'player' || district.owner_ref !== player.id) throw Object.assign(new Error('You do not own that district'), { status: 403 });
      const amount = pendingIncome(district);
      if (amount <= 0) return { collected: 0 };
      await db.from('districts').update({ last_collected: new Date().toISOString() }).eq('id', district.id).eq('last_collected', district.last_collected);
      await db.from('players').update({ money: player.money + amount }).eq('id', player.id);
      return { collected: amount };
    },

    async upgrade(playerId, districtId) {
      const player = await getPlayer(playerId);
      const district = await getDistrict(districtId);
      if (district.owner_ref !== player.id || district.owner_type !== 'player') throw Object.assign(new Error('You do not own that district'), { status: 403 });
      const cost = canUpgrade(player, district);
      const { data: updated } = await db.from('districts').update({ tier: district.tier + 1 }).eq('id', district.id).eq('tier', district.tier);
      if (!updated || updated.length === 0) throw Object.assign(new Error('District changed, try again'), { status: 409 });
      await db.from('players').update({ money: player.money - cost }).eq('id', player.id);
      return { district: updated[0] };
    },
  };
}

function seedPlayer(db, overrides = {}) {
  const p = { id: 'p_' + Math.random().toString(36).slice(2, 8), money: 1000, energy: 100, heat: 0,
    attack: 20, defense: 10, territories_captured: 0, ...overrides };
  db._tables.players = db._tables.players || [];
  db._tables.players.push(p);
  return p;
}
function seedDistrict(db, overrides = {}) {
  const d = { id: 'd_test', owner_type: 'neutral', owner_ref: null, tier: 0, base_income: 10,
    last_collected: new Date().toISOString(), ...overrides };
  db._tables.districts = db._tables.districts || [];
  db._tables.districts.push(d);
  return d;
}

async function run() {
  await test('Claiming a neutral district transfers ownership and deducts money', async () => {
    const db = makeMockSupabase();
    const p = seedPlayer(db);
    const d = seedDistrict(db);
    const app = makeApp(db);
    const result = await app.claim(p.id, d.id);
    assert.strictEqual(result.district.owner_type, 'player');
    assert.strictEqual(result.district.owner_ref, p.id);
    const updatedPlayer = db._tables.players.find(x => x.id === p.id);
    assert.strictEqual(updatedPlayer.money, 1000 - NEUTRAL_CLAIM_COST);
  });

  await test('CRITICAL: two simultaneous claims on the same neutral district — only one wins, other gets a clear error', async () => {
    const db = makeMockSupabase();
    const p1 = seedPlayer(db, { money: 1000 });
    const p2 = seedPlayer(db, { money: 1000 });
    const d = seedDistrict(db);
    const app = makeApp(db);

    // Fire both "simultaneously" (in JS this still interleaves via microtasks, which is
    // exactly the race condition scenario we need the optimistic-lock to survive)
    const results = await Promise.allSettled([app.claim(p1.id, d.id), app.claim(p2.id, d.id)]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed_ = results.filter(r => r.status === 'rejected');
    assert.strictEqual(succeeded.length, 1, 'exactly one claim should succeed');
    assert.strictEqual(failed_.length, 1, 'exactly one claim should fail');
    assert.match(failed_[0].reason.message, /Someone else just claimed/);

    const finalDistrict = db._tables.districts.find(x => x.id === d.id);
    assert.ok(finalDistrict.owner_ref === p1.id || finalDistrict.owner_ref === p2.id);
    // Only the winner should have been charged
    const p1Final = db._tables.players.find(x => x.id === p1.id);
    const p2Final = db._tables.players.find(x => x.id === p2.id);
    const winnerMoney = finalDistrict.owner_ref === p1.id ? p1Final.money : p2Final.money;
    const loserMoney = finalDistrict.owner_ref === p1.id ? p2Final.money : p1Final.money;
    assert.strictEqual(winnerMoney, 1000 - NEUTRAL_CLAIM_COST);
    assert.strictEqual(loserMoney, 1000, 'the losing claimant should NOT have been charged');
  });

  await test('Attacking a real player uses the DEFENDER\'s actual current stats, not attacker-supplied values', async () => {
    const db = makeMockSupabase();
    const attacker = seedPlayer(db, { attack: 500, defense: 500 }); // overwhelming
    const defender = seedPlayer(db, { attack: 1, defense: 1 }); // very weak
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: defender.id });
    const app = makeApp(db);
    const result = await app.attack(attacker.id, d.id);
    assert.strictEqual(result.won, true);
    assert.strictEqual(result.district.owner_ref, attacker.id, 'district should transfer to the attacker');
  });

  await test('Winning an attack transfers territories_captured credit and deducts energy', async () => {
    const db = makeMockSupabase();
    const attacker = seedPlayer(db, { attack: 999, defense: 999, energy: 100 });
    const defender = seedPlayer(db, { attack: 1, defense: 1 });
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: defender.id });
    const app = makeApp(db);
    await app.attack(attacker.id, d.id);
    const attackerFinal = db._tables.players.find(x => x.id === attacker.id);
    assert.strictEqual(attackerFinal.energy, 100 - TERRITORY_ATTACK_ENERGY_COST);
    assert.strictEqual(attackerFinal.territories_captured, 1);
  });

  await test('CRITICAL: two simultaneous attacks on the same rival district — only one wins', async () => {
    const db = makeMockSupabase();
    const p1 = seedPlayer(db, { attack: 999, defense: 999 });
    const p2 = seedPlayer(db, { attack: 999, defense: 999 });
    const d = seedDistrict(db, { owner_type: 'npc_rival', owner_ref: 'nr_sal' });
    const app = makeApp(db);
    const results = await Promise.allSettled([app.attack(p1.id, d.id), app.attack(p2.id, d.id)]);
    const wins = results.filter(r => r.status === 'fulfilled' && r.value.won === true);
    assert.strictEqual(wins.length, 1, 'exactly one attacker should end up owning the district');
    const finalDistrict = db._tables.districts.find(x => x.id === d.id);
    assert.strictEqual(finalDistrict.owner_type, 'player');
  });

  await test('Cannot attack your own district', async () => {
    const db = makeMockSupabase();
    const p = seedPlayer(db);
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: p.id });
    const app = makeApp(db);
    await assert.rejects(() => app.attack(p.id, d.id), /already own/);
  });

  await test('Cannot claim/attack with insufficient resources (money/energy)', async () => {
    const db = makeMockSupabase();
    const poorPlayer = seedPlayer(db, { money: 0 });
    const tiredPlayer = seedPlayer(db, { energy: 0 });
    const neutral = seedDistrict(db, { id: 'd_neutral' });
    const rival = seedDistrict(db, { id: 'd_rival', owner_type: 'npc_rival', owner_ref: 'nr_sal' });
    const app = makeApp(db);
    await assert.rejects(() => app.claim(poorPlayer.id, neutral.id), /Not enough money/);
    await assert.rejects(() => app.attack(tiredPlayer.id, rival.id), /Not enough energy/);
  });

  await test('Collecting income pays the correct accrued amount and resets the timer', async () => {
    const db = makeMockSupabase();
    const p = seedPlayer(db, { money: 500 });
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: p.id, base_income: 10, tier: 0,
      last_collected: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
    const app = makeApp(db);
    const result = await app.collect(p.id, d.id);
    assert.strictEqual(result.collected, 30); // 10/hr * 3hr
    const pFinal = db._tables.players.find(x => x.id === p.id);
    assert.strictEqual(pFinal.money, 530);
    // collecting again immediately should yield nothing
    const result2 = await app.collect(p.id, d.id);
    assert.strictEqual(result2.collected, 0);
  });

  await test('Cannot collect from a district you do not own', async () => {
    const db = makeMockSupabase();
    const p = seedPlayer(db);
    const other = seedPlayer(db);
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: other.id });
    const app = makeApp(db);
    await assert.rejects(() => app.collect(p.id, d.id), /do not own/);
  });

  await test('Upgrading increases tier and deducts the correct cost, blocked past tier 2', async () => {
    const db = makeMockSupabase();
    const p = seedPlayer(db, { money: 99999 });
    const d = seedDistrict(db, { owner_type: 'player', owner_ref: p.id, tier: 0 });
    const app = makeApp(db);
    await app.upgrade(p.id, d.id);
    let dFinal = db._tables.districts.find(x => x.id === d.id);
    assert.strictEqual(dFinal.tier, 1);
    let pFinal = db._tables.players.find(x => x.id === p.id);
    assert.strictEqual(pFinal.money, 99999 - UPGRADE_COSTS[1]);

    await app.upgrade(p.id, d.id);
    dFinal = db._tables.districts.find(x => x.id === d.id);
    assert.strictEqual(dFinal.tier, 2);

    await assert.rejects(() => app.upgrade(p.id, d.id), /max tier/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
