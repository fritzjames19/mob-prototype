import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { freshRivalPool, canFightRival, resolveGangWarsFight, attackerPower, PVP_ENERGY_COST } from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getGang(playerId) { const { data } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', playerId); return data || []; }
async function getTitleIds(playerId) { const { data } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', playerId); return (data || []).map(t => t.title_id); }
async function getPool(playerId) {
  const { data } = await supabaseAdmin.from('ephemeral_pools').select('*').eq('player_id', playerId).eq('pool_type', 'rivals').maybeSingle();
  return data;
}
async function savePool(playerId, candidates) {
  await supabaseAdmin.from('ephemeral_pools').upsert({ player_id: playerId, pool_type: 'rivals', candidates, updated_at: new Date().toISOString() });
}

router.get('/players/me/gangwars/rivals', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    let pool = await getPool(player.id);
    if (!pool || !pool.candidates || pool.candidates.length === 0) {
      const gang = await getGang(player.id);
      const candidates = freshRivalPool(attackerPower(player, gang));
      await savePool(player.id, candidates);
      return res.json({ rivals: candidates });
    }
    res.json({ rivals: pool.candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/gangwars/rivals/refresh', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const gang = await getGang(player.id);
    const candidates = freshRivalPool(attackerPower(player, gang));
    await savePool(player.id, candidates);
    res.json({ rivals: candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/gangwars/attack/:rivalId', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    canFightRival(player);
    const pool = await getPool(player.id);
    const rival = (pool && pool.candidates || []).find(r => r.id === req.params.rivalId);
    if (!rival) return res.status(404).json({ error: 'That rival is no longer around — check Gang Wars again' });

    const gang = await getGang(player.id);
    const titleIds = await getTitleIds(player.id);
    const { player: updated, won, joinedRecruit } = resolveGangWarsFight(player, gang, rival, titleIds);

    if (joinedRecruit) {
      await supabaseAdmin.from('gang_members').insert({ player_id: player.id, name: joinedRecruit.name, attack: joinedRecruit.attack, defense: joinedRecruit.defense, loyalty: joinedRecruit.loyalty });
    }
    await supabaseAdmin.from('players').update({
      energy: updated.energy, money: updated.money, respect: updated.respect, heat: updated.heat,
      pvp_wins: updated.pvp_wins, pvp_losses: updated.pvp_losses,
    }).eq('id', player.id);

    let remaining = (pool.candidates || []).filter(r => r.id !== rival.id);
    if (remaining.length === 0) remaining = freshRivalPool(attackerPower(updated, gang));
    await savePool(player.id, remaining);

    res.json({ won, player: updated, rival, joinedRecruit, rivals: remaining });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
