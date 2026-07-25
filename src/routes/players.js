import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { applyEnergyRegen, FACTIONS } from '../gameLogic.js';

const router = Router();

// Create a new character for the logged-in user.
// (For now: one character per account, matching "web app with its own accounts."
// Multiple characters per account is a natural later extension, not a blocker.)
router.post('/players', requireAuth, async (req, res) => {
  const { name, factionKey } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 16) {
    return res.status(400).json({ error: 'Name must be 1-16 characters' });
  }
  if (!FACTIONS[factionKey]) {
    return res.status(400).json({ error: 'Invalid faction' });
  }

  const { data: existing } = await supabaseAdmin
    .from('players').select('id').eq('user_id', req.userId).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'You already have a character. Delete it first to make a new one.' });
  }

  const faction = FACTIONS[factionKey];
  const maxEnergy = 100 + (faction.maxEnergyBonus || 0);

  const { data, error } = await supabaseAdmin.from('players').insert({
    user_id: req.userId,
    name: name.trim(),
    faction_key: factionKey,
    energy: maxEnergy,
    max_energy: maxEnergy,
    attack: 10 + (faction.atkBonus || 0),
    defense: 10 + (faction.defBonus || 0),
  }).select().single();

  if (error) return res.status(500).json({ error: 'Could not create character', detail: error.message });
  res.status(201).json({ player: data });
});

// Fetch your own character, with energy regen applied and persisted first.
router.get('/players/me', requireAuth, async (req, res) => {
  const { data: player, error } = await supabaseAdmin
    .from('players').select('*').eq('user_id', req.userId).single();
  if (error || !player) return res.status(404).json({ error: 'No character found for this account' });

  const regenerated = applyEnergyRegen(player);
  if (regenerated.energy !== player.energy) {
    await supabaseAdmin.from('players')
      .update({ energy: regenerated.energy, last_energy_tick: regenerated.last_energy_tick })
      .eq('id', player.id);
  }

  const [{ data: gang }, { data: cards }, { data: titles }] = await Promise.all([
    supabaseAdmin.from('gang_members').select('*').eq('player_id', player.id),
    supabaseAdmin.from('cards').select('*').eq('player_id', player.id),
    supabaseAdmin.from('titles').select('title_id').eq('player_id', player.id),
  ]);

  res.json({ player: regenerated, gang: gang || [], cards: cards || [], titles: (titles || []).map(t => t.title_id) });
});

export default router;
