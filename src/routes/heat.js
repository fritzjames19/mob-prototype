import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { applyEnergyRegen, resolveHeatReduction, HEAT_METHODS } from '../gameLogic.js';

const router = Router();

router.post('/players/me/heat/reduce', requireAuth, async (req, res) => {
  const { method } = req.body;

  const { data: player, error: playerErr } = await supabaseAdmin
    .from('players').select('*').eq('user_id', req.userId).single();
  if (playerErr || !player) return res.status(404).json({ error: 'No character found' });

  const regenerated = applyEnergyRegen(player);

  let result;
  try {
    result = resolveHeatReduction(regenerated, method);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Could not reduce heat' });
  }

  const { error: updateErr } = await supabaseAdmin.from('players').update({
    energy: result.energy, money: result.money, heat: result.heat,
    last_energy_tick: result.last_energy_tick, updated_at: new Date().toISOString(),
  }).eq('id', player.id);

  if (updateErr) return res.status(500).json({ error: 'Failed to save', detail: updateErr.message });

  res.json({ player: result, method: HEAT_METHODS[method].label });
});

export default router;
