// Server-authoritative game data and logic.
// Mirrors the values tuned in the single-player prototype, but every calculation that
// used to happen in the browser now happens here instead — the client only ever sends
// an *intent* ("I want to do quest X") and receives back the *result*.

export const FACTIONS = {
  famiglia: { name: "La Famiglia", flag: "🇮🇹", moneyMult: 1.10 },
  bratva:   { name: "Volch'ya Staya", flag: "🇷🇺", defBonus: 10 },
  yakuza:   { name: "Kuroi Tatsu", flag: "🇯🇵", atkBonus: 10 },
  cartel:   { name: "Los Sangres Rojas", flag: "🇲🇽", respectMult: 1.10 },
  triad:    { name: "Crimson Phoenix", flag: "🇨🇳", maxEnergyBonus: 20 }
};

export const RANKS = [
  { name: "Street Punk", minLevel: 1 }, { name: "Associate", minLevel: 3 },
  { name: "Soldier", minLevel: 6 }, { name: "Capo", minLevel: 10 },
  { name: "Underboss", minLevel: 15 }, { name: "Boss", minLevel: 21 },
  { name: "Don", minLevel: 28 }, { name: "Godfather", minLevel: 36 }
];

export const QUESTS = {
  store:   { name: "Rob Convenience Store", energy: 10, xp: 14, money: [30,60], respect: 3, heat: 2 },
  smuggle: { name: "Smuggle Weapons",       energy: 18, xp: 22, money: [70,120], respect: 4, heat: 5 },
  extort:  { name: "Extort Business",       energy: 15, xp: 18, money: [50,90], respect: 5, heat: 3 },
  drugs:   { name: "Drug Delivery",         energy: 20, xp: 26, money: [90,150], respect: 3, heat: 6 },
  launder: { name: "Money Laundering",      energy: 25, xp: 30, money: [120,200], respect: 6, heat: 4 }
};

// Real-world pacing per the original GDD: 25 energy every 4 hours = 1 energy per 9.6 minutes.
// (The single-player prototype used a compressed demo rate — this is the real one.)
export const ENERGY_REGEN_MS_PER_POINT = (4 * 60 * 60 * 1000) / 25;

export function xpForLevel(level) { return level * 100; }
export function rankFor(level) {
  let r = RANKS[0];
  for (const rk of RANKS) if (level >= rk.minLevel) r = rk;
  return r;
}
export function heatTier(h) {
  if (h < 20) return 'low'; if (h < 45) return 'medium'; if (h < 70) return 'high';
  if (h < 90) return 'wanted'; return 'mostwanted';
}

// Applies passive energy regen based on elapsed real time since last_energy_tick.
// Called at the top of every request that reads or spends energy, so the stored value
// is always brought up to date before we use it — no background cron job needed.
export function applyEnergyRegen(player) {
  const elapsedMs = Date.now() - new Date(player.last_energy_tick).getTime();
  const pointsEarned = Math.floor(elapsedMs / ENERGY_REGEN_MS_PER_POINT);
  if (pointsEarned <= 0 || player.energy >= player.max_energy) return player;
  const newEnergy = Math.min(player.max_energy, player.energy + pointsEarned);
  const consumedMs = pointsEarned * ENERGY_REGEN_MS_PER_POINT;
  player.energy = newEnergy;
  player.last_energy_tick = new Date(new Date(player.last_energy_tick).getTime() + consumedMs).toISOString();
  return player;
}

export function gangAttackTotal(gang) { return gang.reduce((s, m) => s + m.attack, 0); }
export function gangDefenseTotal(gang) { return gang.reduce((s, m) => s + m.defense, 0); }
export function gangMoneyBonus(gang) { return 1 + Math.min(0.30, gang.length * 0.02); }

// Returns { player, gainXpResult, reward } or throws a { status, message } error object
// that the route handler turns into an HTTP response. Pure function — no DB access here,
// so it's easy to unit test in isolation from Express/Supabase.
export function resolveQuest(player, gang, questId) {
  const q = QUESTS[questId];
  if (!q) throw Object.assign(new Error('Unknown quest id'), { status: 400 });
  if (heatTier(player.heat) === 'wanted' || heatTier(player.heat) === 'mostwanted') {
    throw Object.assign(new Error('Too hot to operate right now'), { status: 403 });
  }
  if (player.energy < q.energy) throw Object.assign(new Error('Not enough energy'), { status: 400 });

  const faction = FACTIONS[player.faction_key];
  let money = Math.round(q.money[0] + Math.random() * (q.money[1] - q.money[0]));
  if (faction.moneyMult) money = Math.round(money * faction.moneyMult);
  money = Math.round(money * gangMoneyBonus(gang));

  let respect = q.respect;
  if (faction.respectMult) respect = Math.round(respect * faction.respectMult);

  const xp = Math.round(q.xp * (1 + player.xp_boost / 100));

  player.energy -= q.energy;
  player.money += money;
  player.respect += respect;
  player.heat = Math.min(100, player.heat + q.heat);
  player.quests_done += 1;

  const levelUps = [];
  player.xp += xp;
  let need = xpForLevel(player.level);
  while (player.xp >= need) {
    player.xp -= need;
    player.level += 1;
    levelUps.push({ level: player.level, rank: rankFor(player.level).name });
    need = xpForLevel(player.level);
  }

  return { player, reward: { questName: q.name, money, respect, xp }, levelUps };
}
