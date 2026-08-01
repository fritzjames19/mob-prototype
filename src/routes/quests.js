import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { applyEnergyRegen, resolveQuest } from '../gameLogic.js';

const router = Router();

router.post('/players/me/quests/:questId', requireAuth, async (req, res) => {
  const { questId } = req.params;

  const { data: player, error: playerErr } = await supabaseAdmin
    .from('players').select('*').eq('user_id', req.userId).single();
  if (playerErr || !player) return res.status(404).json({ error: 'No character found' });

  const { data: gang } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', player.id);
  const { data: titleRows } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', player.id);
  const titleIds = (titleRows || []).map(t => t.title_id);

  const regenerated = applyEnergyRegen(player);

  let result;
  try {
    result = resolveQuest(regenerated, gang || [], questId, titleIds);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Could not resolve quest' });
  }

  const p = result.player;
  const { error: updateErr } = await supabaseAdmin.from('players').update({
    energy: p.energy, last_energy_tick: p.last_energy_tick,
    money: p.money, respect: p.respect, heat: p.heat,
    quests_done: p.quests_done, xp: p.xp, level: p.level,
    updated_at: new Date().toISOString(),
  }).eq('id', player.id);

  if (updateErr) return res.status(500).json({ error: 'Failed to save quest result', detail: updateErr.message });

  res.json({ player: p, reward: result.reward, levelUps: result.levelUps });
});

export default router;
