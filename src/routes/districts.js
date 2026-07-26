import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import {
  applyEnergyRegen, pendingIncome, rivalEffectivePower, playerDefensePower, attackerPower,
  resolveCombatRoll, canClaimNeutral, canAttack, canUpgrade, TERRITORY_ATTACK_ENERGY_COST,
  NEUTRAL_CLAIM_COST, UPGRADE_COSTS, TIER_MULT, NAMED_RIVALS,
} from '../gameLogic.js';

const router = Router();

async function getPlayerByUserId(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getGang(playerId) {
  const { data } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', playerId);
  return data || [];
}
async function getDistrict(districtId) {
  const { data, error } = await supabaseAdmin.from('districts').select('*').eq('id', districtId).single();
  if (error || !data) throw Object.assign(new Error('District not found'), { status: 404 });
  return data;
}
async function heldCountFor(ownerType, ownerRef) {
  const { data } = await supabaseAdmin.from('districts').select('id').eq('owner_type', ownerType).eq('owner_ref', ownerRef);
  return (data || []).length;
}

// Claim a neutral district outright.
router.post('/districts/:id/claim', requireAuth, async (req, res) => {
  try {
    const player = applyEnergyRegen(await getPlayerByUserId(req.userId));
    const district = await getDistrict(req.params.id);
    canClaimNeutral(player, district);

    // Optimistic concurrency: the update only takes effect if the district is STILL
    // neutral at write time. If someone else claimed it a moment ago, this affects 0 rows.
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('districts')
      .update({ owner_type: 'player', owner_ref: player.id, tier: 0, last_collected: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', district.id).eq('owner_type', 'neutral')
      .select();
    if (updateErr) throw Object.assign(new Error('Could not claim district'), { status: 500 });
    if (!updated || updated.length === 0) throw Object.assign(new Error('Someone else just claimed that district'), { status: 409 });

    const newMoney = player.money - NEUTRAL_CLAIM_COST;
    await supabaseAdmin.from('players').update({
      money: newMoney, territories_captured: player.territories_captured + 1,
      energy: player.energy, last_energy_tick: player.last_energy_tick,
    }).eq('id', player.id);

    res.json({ district: updated[0], money: newMoney });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Attack a rival- or player-held district.
router.post('/districts/:id/attack', requireAuth, async (req, res) => {
  try {
    const player = applyEnergyRegen(await getPlayerByUserId(req.userId));
    const district = await getDistrict(req.params.id);
    canAttack(player, district);

    const attackerGang = await getGang(player.id);
    const myPower = attackerPower(player, attackerGang);

    let theirPower, grudgeKey = null;
    if (district.owner_type === 'npc_rival') {
      const held = await heldCountFor('npc_rival', district.owner_ref);
      const { data: grudgeRow } = await supabaseAdmin.from('district_grudges')
        .select('grudge').eq('attacker_player_id', player.id).eq('defender_ref', district.owner_ref).maybeSingle();
      const grudge = grudgeRow ? grudgeRow.grudge : 0;
      theirPower = rivalEffectivePower(district.owner_ref, held, grudge);
      grudgeKey = district.owner_ref;
    } else {
      const { data: defender, error: defErr } = await supabaseAdmin.from('players').select('*').eq('id', district.owner_ref).single();
      if (defErr || !defender) throw Object.assign(new Error('Defending player no longer exists'), { status: 409 });
      const defenderGang = await getGang(defender.id);
      theirPower = playerDefensePower(defender, defenderGang);
    }

    const roll = resolveCombatRoll(myPower, theirPower);

    // Spend energy and apply heat regardless of outcome — the attempt itself is the cost.
    const newEnergy = player.energy - TERRITORY_ATTACK_ENERGY_COST;
    const newHeat = Math.min(100, player.heat + 12);

    if (roll.won) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('districts')
        .update({ owner_type: 'player', owner_ref: player.id, tier: 0, last_collected: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', district.id).eq('owner_type', district.owner_type).eq('owner_ref', district.owner_ref)
        .select();
      if (!updated || updated.length === 0) {
        // Someone else took it a moment before us — treat as a loss, still spend the energy/heat.
        await supabaseAdmin.from('players').update({ energy: newEnergy, heat: newHeat, last_energy_tick: player.last_energy_tick }).eq('id', player.id);
        return res.status(409).json({ error: 'Someone else took that district first', energy: newEnergy, heat: newHeat });
      }
      if (grudgeKey) {
        await supabaseAdmin.from('district_grudges').upsert({ attacker_player_id: player.id, defender_ref: grudgeKey, grudge: 0 });
      }
      await supabaseAdmin.from('players').update({
        energy: newEnergy, heat: newHeat, last_energy_tick: player.last_energy_tick,
        territories_captured: player.territories_captured + 1,
      }).eq('id', player.id);

      res.json({ won: true, district: updated[0], energy: newEnergy, heat: newHeat });
    } else {
      if (grudgeKey) {
        const { data: grudgeRow } = await supabaseAdmin.from('district_grudges')
          .select('grudge').eq('attacker_player_id', player.id).eq('defender_ref', grudgeKey).maybeSingle();
        const newGrudge = Math.min(5, (grudgeRow ? grudgeRow.grudge : 0) + 1);
        await supabaseAdmin.from('district_grudges').upsert({ attacker_player_id: player.id, defender_ref: grudgeKey, grudge: newGrudge });
      }
      await supabaseAdmin.from('players').update({ energy: newEnergy, heat: newHeat, last_energy_tick: player.last_energy_tick }).eq('id', player.id);
      res.json({ won: false, energy: newEnergy, heat: newHeat });
    }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Collect accrued income from a district you own.
router.post('/districts/:id/collect', requireAuth, async (req, res) => {
  try {
    const player = await getPlayerByUserId(req.userId);
    const district = await getDistrict(req.params.id);
    if (district.owner_type !== 'player' || district.owner_ref !== player.id) {
      throw Object.assign(new Error('You do not own that district'), { status: 403 });
    }
    const amount = pendingIncome(district);
    if (amount <= 0) return res.json({ collected: 0, money: player.money });

    const now = new Date().toISOString();
    const { data: updated } = await supabaseAdmin.from('districts')
      .update({ last_collected: now, updated_at: now })
      .eq('id', district.id).eq('last_collected', district.last_collected)
      .select();
    if (!updated || updated.length === 0) return res.json({ collected: 0, money: player.money }); // someone/something already collected this moment

    const newMoney = player.money + amount;
    await supabaseAdmin.from('players').update({ money: newMoney }).eq('id', player.id);
    res.json({ collected: amount, money: newMoney });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Upgrade a business you own.
router.post('/districts/:id/upgrade', requireAuth, async (req, res) => {
  try {
    const player = await getPlayerByUserId(req.userId);
    const district = await getDistrict(req.params.id);
    if (district.owner_ref !== player.id || district.owner_type !== 'player') {
      throw Object.assign(new Error('You do not own that district'), { status: 403 });
    }
    const cost = canUpgrade(player, district);

    const { data: updated } = await supabaseAdmin.from('districts')
      .update({ tier: district.tier + 1, updated_at: new Date().toISOString() })
      .eq('id', district.id).eq('tier', district.tier)
      .select();
    if (!updated || updated.length === 0) throw Object.assign(new Error('District changed, try again'), { status: 409 });

    const newMoney = player.money - cost;
    await supabaseAdmin.from('players').update({ money: newMoney }).eq('id', player.id);
    res.json({ district: updated[0], money: newMoney });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
