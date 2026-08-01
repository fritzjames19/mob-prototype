import { Router } from 'express';
import { supabaseAdmin } from '../db.js';
import { requireAuth } from '../requireAuth.js';
import {
  openPack, canBuyPack, deckPower, canPlayTournament, makeTournamentOpponent,
  resolvetournamentMatch, CARD_PACK_COST, TOURNAMENT_ENERGY_COST,
} from '../gameLogic.js';

const router = Router();

async function getPlayer(userId) {
  const { data, error } = await supabaseAdmin.from('players').select('*').eq('user_id', userId).single();
  if (error || !data) throw Object.assign(new Error('No character found'), { status: 404 });
  return data;
}
async function getCards(playerId) { const { data } = await supabaseAdmin.from('cards').select('*').eq('player_id', playerId); return data || []; }
async function getTitleIds(playerId) { const { data } = await supabaseAdmin.from('titles').select('title_id').eq('player_id', playerId); return (data || []).map(t => t.title_id); }

router.get('/players/me/cards', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const cards = await getCards(player.id);
    res.json({ cards, deckPower: deckPower(cards) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/cards/buy-pack', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    canBuyPack(player);
    const card = openPack();
    await supabaseAdmin.from('cards').insert({ player_id: player.id, name: card.name, rarity_id: card.rarityId, power: card.power });
    const newMoney = player.money - CARD_PACK_COST;
    await supabaseAdmin.from('players').update({ money: newMoney }).eq('id', player.id);
    res.json({ money: newMoney, card });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/players/me/tournament/matchup', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const cards = await getCards(player.id);
    canPlayTournament(player, cards);
    const myDeck = deckPower(cards);
    const oppDeck = makeTournamentOpponent(myDeck);
    await supabaseAdmin.from('ephemeral_pools').upsert({
      player_id: player.id, pool_type: 'tournament', candidates: [{ myDeck, oppDeck }], updated_at: new Date().toISOString(),
    });
    res.json({ myDeck, oppDeck });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/players/me/tournament/play', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.userId);
    const cards = await getCards(player.id);
    canPlayTournament(player, cards);

    // The opponent's strength is whatever was generated and stored when the matchup was
    // viewed — never trusted from the request body. A client sending a fake easy oppDeck
    // in the request has no effect; only the stored value is ever used.
    const { data: pool } = await supabaseAdmin.from('ephemeral_pools').select('*').eq('player_id', player.id).eq('pool_type', 'tournament').maybeSingle();
    const stored = pool && pool.candidates && pool.candidates[0];
    if (!stored) return res.status(404).json({ error: 'No match lined up — check the matchup first' });

    const realMyDeck = deckPower(cards); // also re-derived server-side, never trusted from client
    const titleIds = await getTitleIds(player.id);
    const result = resolvetournamentMatch(player, realMyDeck, stored.oppDeck, titleIds);

    await supabaseAdmin.from('players').update({
      energy: result.player.energy, money: result.player.money,
      tournament_wins: result.player.tournament_wins, tournament_losses: result.player.tournament_losses,
      tournament_points: result.player.tournament_points,
    }).eq('id', player.id);

    if (result.awardTitleId) {
      await supabaseAdmin.from('titles').insert({ player_id: player.id, title_id: result.awardTitleId });
    }
    await supabaseAdmin.from('ephemeral_pools').upsert({ player_id: player.id, pool_type: 'tournament', candidates: [], updated_at: new Date().toISOString() });

    res.json({ won: result.won, player: result.player, moneyGain: result.moneyGain, awardTitleId: result.awardTitleId, cashRewardInstead: result.cashRewardInstead });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
