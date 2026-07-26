import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { NAMED_RIVALS, pendingIncome } from '../gameLogic.js';

const router = Router();

// Public — no auth required. Anyone can see who's winning.
router.get('/leaderboard', async (req, res) => {
  const metric = ['respect', 'money', 'level'].includes(req.query.by) ? req.query.by : 'respect';

  const { data, error } = await supabaseAdmin
    .from('players')
    .select('name, faction_key, level, respect, money, territories_captured, rivals_eliminated')
    .order(metric, { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Could not load leaderboard', detail: error.message });
  res.json({ leaderboard: data, sortedBy: metric });
});

// Public — the shared city map everyone is contesting. Read-only for clients;
// only the server writes to this table (via the service role key), so nobody can
// fake owning a district from the browser.
router.get('/districts', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('districts').select('*').order('id');
  if (error) return res.status(500).json({ error: 'Could not load districts', detail: error.message });

  const playerOwnedRefs = [...new Set(data.filter(d => d.owner_type === 'player').map(d => d.owner_ref))];
  let namesById = {};
  if (playerOwnedRefs.length > 0) {
    const { data: owners } = await supabaseAdmin.from('players').select('id, name').in('id', playerOwnedRefs);
    namesById = Object.fromEntries((owners || []).map(o => [o.id, o.name]));
  }

  const enriched = data.map(d => ({
    ...d,
    ownerName: d.owner_type === 'npc_rival' ? (NAMED_RIVALS[d.owner_ref] || {}).name
      : d.owner_type === 'player' ? (namesById[d.owner_ref] || 'Unknown Boss')
      : null,
    pendingIncome: d.owner_type === 'player' ? pendingIncome(d) : 0,
  }));

  res.json({ districts: enriched });
});

export default router;
