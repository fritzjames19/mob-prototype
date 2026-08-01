import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { allTitleDefs, canBuyTitle } from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getOwnedTitleIds(playerId) {
  const { data } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', playerId);
  return (data || []).map(t => t.title_id);
}

// Public-ish catalog + your ownership, so the client can render the shop without a second round trip.
router.get('/players/me/titles', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const owned = await getOwnedTitleIds(player.id);
    res.json({ catalog: allTitleDefs(), owned });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/titles/:titleId/buy', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const owned = await getOwnedTitleIds(player.id);
    const t = canBuyTitle(player, owned, req.params.titleId);

    await supabaseAdmin.from('titles').insert({ player_id: player.id, title_id: t.id });
    const newMoney = player.money - t.cost;
    await supabaseAdmin.from('players').update({ money: newMoney }).eq('id', player.id);

    res.json({ money: newMoney, title: t });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
