import { Router } from 'express';
import { supabaseAdmin } from '../db.js';

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
// only the server writes to this table (via the service role key) once territory
// actions are implemented, so nobody can fake owning a district from the browser.
router.get('/districts', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('districts').select('*').order('id');
  if (error) return res.status(500).json({ error: 'Could not load districts', detail: error.message });
  res.json({ districts: data });
});

export default router;
