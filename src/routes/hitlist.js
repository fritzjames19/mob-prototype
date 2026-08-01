import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { freshHitlistPool, canAttemptHit, resolveHit, resolveIncomingHit, attackerPower } from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getGang(playerId) { const { data } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', playerId); return data || []; }
async function getTitleIds(playerId) { const { data } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', playerId); return (data || []).map(t => t.title_id); }
async function getPool(playerId) {
  const { data } = await supabaseAdmin.from('ephemeral_pools').select('*').eq('player_id', playerId).eq('pool_type', 'hitlist').maybeSingle();
  return data;
}
async function savePool(playerId, candidates) {
  await supabaseAdmin.from('ephemeral_pools').upsert({ player_id: playerId, pool_type: 'hitlist', candidates, updated_at: new Date().toISOString() });
}

router.get('/players/me/hitlist/contracts', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    let pool = await getPool(player.id);
    if (!pool || !pool.candidates || pool.candidates.length === 0) {
      const gang = await getGang(player.id);
      const candidates = freshHitlistPool(attackerPower(player, gang));
      await savePool(player.id, candidates);
      return res.json({ contracts: candidates });
    }
    res.json({ contracts: pool.candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/hitlist/contracts/refresh', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const gang = await getGang(player.id);
    const candidates = freshHitlistPool(attackerPower(player, gang));
    await savePool(player.id, candidates);
    res.json({ contracts: candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/hitlist/attempt/:contractId', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    canAttemptHit(player);
    const pool = await getPool(player.id);
    const contract = (pool && pool.candidates || []).find(c => c.id === req.params.contractId);
    if (!contract) return res.status(404).json({ error: 'That contract is gone — check the Hitlist again' });

    const gang = await getGang(player.id);
    const titleIds = await getTitleIds(player.id);
    const { player: updated, success } = resolveHit(player, gang, contract, titleIds);

    await supabaseAdmin.from('players').update({
      energy: updated.energy, money: updated.money, respect: updated.respect, heat: updated.heat,
      hits_completed: updated.hits_completed, hits_failed: updated.hits_failed,
    }).eq('id', player.id);

    let remaining = (pool.candidates || []).filter(c => c.id !== contract.id);
    if (remaining.length === 0) remaining = freshHitlistPool(attackerPower(updated, gang));
    await savePool(player.id, remaining);

    res.json({ success, player: updated, contract, contracts: remaining });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Rolled client-triggered (e.g. when opening the Hitlist tab) but fully server-resolved —
// chance scales with respect, matches the single-player prototype's design.
router.post('/players/me/hitlist/check-incoming', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const chance = Math.min(0.35, player.respect / 500);
    if (Math.random() >= chance) return res.json({ triggered: false });

    const gang = await getGang(player.id);
    const { player: updated, survived, lost } = resolveIncomingHit(player, gang);
    await supabaseAdmin.from('players').update({ money: updated.money, respect: updated.respect, hits_survived: updated.hits_survived }).eq('id', player.id);
    res.json({ triggered: true, survived, lost, player: updated });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
