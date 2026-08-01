import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import {
  canAttemptBlackMarket, resolveBlackMarket, randomEliteTarget, attackerPower,
  freshDealsPool, canBuyDeal, SECRET_DEAL_TEMPLATES,
} from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getGang(playerId) { const { data } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', playerId); return data || []; }
async function getTitleIds(playerId) { const { data } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', playerId); return (data || []).map(t => t.title_id); }
async function getEphemeralPool(playerId, poolType) {
  const { data } = await supabaseAdmin.from('ephemeral_pools').select('*').eq('player_id', playerId).eq('pool_type', poolType).maybeSingle();
  return data;
}
async function saveEphemeralPool(playerId, poolType, candidates) {
  await supabaseAdmin.from('ephemeral_pools').upsert({ player_id: playerId, pool_type: poolType, candidates, updated_at: new Date().toISOString() });
}

// -- Black Market --
router.get('/players/me/underground/blackmarket', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const titleIds = await getTitleIds(player.id);
    canAttemptBlackMarket(player, titleIds, player.sniper_last_used_at);

    let pool = await getEphemeralPool(player.id, 'blackmarket');
    if (!pool || !pool.candidates || pool.candidates.length === 0) {
      const gang = await getGang(player.id);
      const target = randomEliteTarget(attackerPower(player, gang));
      await saveEphemeralPool(player.id, 'blackmarket', [target]);
      return res.json({ target });
    }
    res.json({ target: pool.candidates[0] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, retryAfterMs: e.retryAfterMs }); }
});

router.post('/players/me/underground/blackmarket/attempt', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const titleIds = await getTitleIds(player.id);
    canAttemptBlackMarket(player, titleIds, player.sniper_last_used_at);

    const pool = await getEphemeralPool(player.id, 'blackmarket');
    const target = pool && pool.candidates && pool.candidates[0];
    if (!target) return res.status(404).json({ error: 'No target lined up — check the Black Market first' });

    const gang = await getGang(player.id);
    const { player: updated, won } = resolveBlackMarket(player, gang, target);

    await supabaseAdmin.from('players').update({
      energy: updated.energy, money: updated.money, respect: updated.respect, heat: updated.heat,
      hits_completed: updated.hits_completed, hits_failed: updated.hits_failed,
      sniper_last_used_at: new Date().toISOString(),
    }).eq('id', player.id);
    await saveEphemeralPool(player.id, 'blackmarket', []); // clear — next view generates a fresh target + starts cooldown

    res.json({ won, player: updated, target });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, retryAfterMs: e.retryAfterMs }); }
});

// -- Secret Deals --
router.get('/players/me/underground/deals', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    let pool = player.secret_deals_pool;
    if (!pool || pool.length === 0) {
      pool = freshDealsPool();
      await supabaseAdmin.from('players').update({ secret_deals_pool: pool }).eq('id', player.id);
    }
    res.json({ deals: pool.map(id => SECRET_DEAL_TEMPLATES[id]) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/underground/deals/refresh', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const pool = freshDealsPool();
    await supabaseAdmin.from('players').update({ secret_deals_pool: pool }).eq('id', player.id);
    res.json({ deals: pool.map(id => SECRET_DEAL_TEMPLATES[id]) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/underground/deals/:dealId/buy', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const pool = player.secret_deals_pool || [];
    const deal = canBuyDeal(player, pool, req.params.dealId);

    deal.apply(player);
    player.money -= deal.cost;
    const remaining = pool.filter(id => id !== deal.id);

    await supabaseAdmin.from('players').update({
      money: player.money, attack: player.attack, defense: player.defense, luck: player.luck,
      max_energy: player.max_energy, energy: player.energy, respect: player.respect,
      secret_deals_pool: remaining,
    }).eq('id', player.id);

    res.json({ player, deal });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
