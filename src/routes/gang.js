import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import { freshRecruitPool, canRecruit } from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getPool(playerId) {
  const { data } = await supabaseAdmin.from('recruit_pools').select('*').eq('player_id', playerId).maybeSingle();
  return data;
}
async function savePool(playerId, candidates) {
  await supabaseAdmin.from('recruit_pools').upsert({ player_id: playerId, candidates, updated_at: new Date().toISOString() });
}

// View your current recruit pool, generating one if you don't have one yet.
router.get('/players/me/recruits', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    let pool = await getPool(player.id);
    if (!pool || !pool.candidates || pool.candidates.length === 0) {
      const candidates = freshRecruitPool();
      await savePool(player.id, candidates);
      return res.json({ candidates });
    }
    res.json({ candidates: pool.candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Scout new candidates (replaces the whole pool).
router.post('/players/me/recruits/refresh', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const candidates = freshRecruitPool();
    await savePool(player.id, candidates);
    res.json({ candidates });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Hire a specific candidate from your current pool (validated server-side against
// what's actually stored — a client can't invent a cheaper/stronger recruit).
router.post('/players/me/gang/recruit/:candidateId', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const pool = await getPool(player.id);
    const candidate = (pool && pool.candidates || []).find(c => c.id === req.params.candidateId);
    canRecruit(player, candidate);

    await supabaseAdmin.from('gang_members').insert({
      player_id: player.id, name: candidate.name, attack: candidate.attack, defense: candidate.defense, loyalty: candidate.loyalty,
    });
    const newMoney = player.money - candidate.cost;
    await supabaseAdmin.from('players').update({ money: newMoney }).eq('id', player.id);

    let remaining = (pool.candidates || []).filter(c => c.id !== candidate.id);
    if (remaining.length === 0) remaining = freshRecruitPool();
    await savePool(player.id, remaining);

    res.json({ money: newMoney, hired: candidate.name, candidates: remaining });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// View your current gang.
router.get('/players/me/gang', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const { data: gang } = await supabaseAdmin.from('gang_members').select('*').eq('player_id', player.id);
    res.json({ gang: gang || [] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Dismiss a gang member — no refund.
router.post('/players/me/gang/:memberId/dismiss', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const { data: member } = await supabaseAdmin.from('gang_members').select('*').eq('id', req.params.memberId).eq('player_id', player.id).maybeSingle();
    if (!member) return res.status(404).json({ error: 'That gang member is not yours' });
    await supabaseAdmin.from('gang_members').delete().eq('id', member.id);
    res.json({ dismissed: member.name });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
