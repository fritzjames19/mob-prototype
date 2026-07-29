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

// --- Territory ---
// Named rivals are the same 5 persistent NPC bosses from the single-player prototype.
// The key new thing here: districts.owner_ref can ALSO be a real player's id, and when it
// is, the "defender" in a fight is that player's actual current stats read fresh from the
// database — not a snapshot, not client-supplied. That's what makes this real PvP instead
// of just reskinned NPC combat.
export const NAMED_RIVALS = {
  nr_sal:    { name: '"Big Sal" Moretti', basePower: 30 },
  nr_yuki:   { name: 'Yuki Tanaka',        basePower: 42 },
  nr_dmitri: { name: 'Dmitri Volkov',      basePower: 56 },
  nr_carlos: { name: 'Carlos Reyes',       basePower: 70 },
  nr_broker: { name: '"The Broker"',       basePower: 88 },
};

export const NEUTRAL_CLAIM_COST = 250;
export const TERRITORY_ATTACK_ENERGY_COST = 25;
export const INCOME_CAP_HOURS = 8;
export const UPGRADE_COSTS = [0, 400, 900]; // cost to reach tier 1, tier 2 (index = tier being upgraded FROM)
export const TIER_MULT = [1, 1.5, 2.2];
export const COMBAT_RAND_RANGE = 45;

export function pendingIncome(district) {
  const elapsedHours = Math.min(INCOME_CAP_HOURS, (Date.now() - new Date(district.last_collected).getTime()) / 3600000);
  return Math.max(0, Math.floor(district.base_income * TIER_MULT[district.tier] * elapsedHours));
}

// heldCount = how many districts this owner (rival or player) currently holds across the whole map
export function rivalEffectivePower(rivalId, heldCount, grudge) {
  const rival = NAMED_RIVALS[rivalId];
  if (!rival) throw Object.assign(new Error('Unknown rival id'), { status: 400 });
  const grudgeMult = 1 + Math.min(0.4, (grudge || 0) * 0.08);
  return Math.round((rival.basePower + heldCount * 10) * grudgeMult);
}

export function playerDefensePower(defenderPlayer, defenderGang) {
  const gangAtk = (defenderGang || []).reduce((s, m) => s + m.attack, 0);
  const gangDef = (defenderGang || []).reduce((s, m) => s + m.defense, 0);
  return defenderPlayer.attack + gangAtk + defenderPlayer.defense + gangDef;
}

export function attackerPower(attackerPlayer, attackerGang) {
  const gangAtk = (attackerGang || []).reduce((s, m) => s + m.attack, 0);
  const gangDef = (attackerGang || []).reduce((s, m) => s + m.defense, 0);
  return attackerPlayer.attack + gangAtk + attackerPlayer.defense + gangDef;
}

// Pure combat roll — given both sides' base power, returns whether the attacker wins.
// Exposed separately from the route so it's directly unit-testable without any DB mocking.
export function resolveCombatRoll(myBasePower, theirBasePower, rand = Math.random) {
  const myRoll = myBasePower + Math.round(rand() * COMBAT_RAND_RANGE);
  const theirRoll = theirBasePower + Math.round(rand() * COMBAT_RAND_RANGE);
  return { won: myRoll > theirRoll, myRoll, theirRoll };
}

export function canClaimNeutral(player, district) {
  if (district.owner_type !== 'neutral') throw Object.assign(new Error('That district is not unclaimed'), { status: 409 });
  if (player.money < NEUTRAL_CLAIM_COST) throw Object.assign(new Error('Not enough money'), { status: 400 });
}

export function canAttack(player, district) {
  if (district.owner_type === 'neutral') throw Object.assign(new Error('That district is unclaimed — move in instead of attacking'), { status: 409 });
  if (district.owner_type === 'player' && district.owner_ref === player.id) {
    throw Object.assign(new Error("You already own that district"), { status: 409 });
  }
  if (heatTier(player.heat) === 'wanted' || heatTier(player.heat) === 'mostwanted') {
    throw Object.assign(new Error('Too hot to make a move right now'), { status: 403 });
  }
  if (player.energy < TERRITORY_ATTACK_ENERGY_COST) {
    throw Object.assign(new Error('Not enough energy'), { status: 400 });
  }
}

export function canUpgrade(player, district) {
  if (district.owner_type !== 'player') throw Object.assign(new Error('You do not own that district'), { status: 403 });
  if (district.tier >= 2) throw Object.assign(new Error('Already at max tier'), { status: 409 });
  const cost = UPGRADE_COSTS[district.tier + 1];
  if (player.money < cost) throw Object.assign(new Error('Not enough money'), { status: 400 });
  return cost;
}

// --- Heat management ---
// Matches the single-player prototype's values exactly. This closes the "heat only ever
// goes up" gap — Quests and Territory raise it, this is the only way to bring it back down.
export const HEAT_METHODS = {
  laylow: { label: 'Lay low', energyCost: 15, heatReduction: 12 },
  bribe:  { label: 'Bribe police', heatReduction: 25, cost: (heat) => Math.max(20, Math.round(heat * 6)) },
  lawyer: { label: 'Hire lawyer', heatReduction: 15, cost: (heat) => Math.max(15, Math.round(heat * 4)) },
};

// Returns the money cost for bribe/lawyer at the player's CURRENT heat — computed server-side
// so a client can never lowball what it's willing to pay.
export function heatMethodCost(methodKey, player) {
  const m = HEAT_METHODS[methodKey];
  if (!m) throw Object.assign(new Error('Unknown heat management method'), { status: 400 });
  return m.cost ? m.cost(player.heat) : null; // laylow has no money cost
}

export function resolveHeatReduction(player, methodKey) {
  const m = HEAT_METHODS[methodKey];
  if (!m) throw Object.assign(new Error('Unknown heat management method'), { status: 400 });

  if (methodKey === 'laylow') {
    if (player.energy < m.energyCost) throw Object.assign(new Error('Not enough energy'), { status: 400 });
    player.energy -= m.energyCost;
  } else {
    const cost = heatMethodCost(methodKey, player);
    if (player.money < cost) throw Object.assign(new Error('Not enough money'), { status: 400 });
    player.money -= cost;
  }
  player.heat = Math.max(0, player.heat - m.heatReduction);
  return player;
}

// --- Gang recruitment ---
const RECRUIT_FIRST = ["Vinny","Sal","Tommy","Nicky","Frankie","Rocco","Enzo","Marco","Dmitri","Yuri","Kenji","Hiro","Carlos","Miguel","Chen","Wei","Bruno","Leo"];
const RECRUIT_NICK = ["The Blade","Two Fingers","The Ghost","Iron Fist","The Snake","Lucky","The Wolf","Razor","The Shadow","Bones","The Fox","Hammer"];
const RECRUIT_LAST = ["Rossi","Marchetti","Volkov","Petrov","Tanaka","Sato","Reyes","Cruz","Wong","Li","Moretti","DeLuca"];

export function randomRecruit() {
  const attack = 5 + Math.floor(Math.random() * 20);
  const defense = 5 + Math.floor(Math.random() * 20);
  const loyalty = 40 + Math.floor(Math.random() * 50);
  const cost = Math.round((attack + defense) * 3 + loyalty * 1.2);
  const useNick = Math.random() < 0.4;
  const name = useNick
    ? RECRUIT_FIRST[Math.floor(Math.random() * RECRUIT_FIRST.length)] + " '" + RECRUIT_NICK[Math.floor(Math.random() * RECRUIT_NICK.length)] + "'"
    : RECRUIT_FIRST[Math.floor(Math.random() * RECRUIT_FIRST.length)] + " " + RECRUIT_LAST[Math.floor(Math.random() * RECRUIT_LAST.length)];
  return { id: 'r' + Math.random().toString(36).slice(2, 10), name, attack, defense, loyalty, cost };
}

export function freshRecruitPool() {
  return [randomRecruit(), randomRecruit(), randomRecruit()];
}

export function canRecruit(player, candidate) {
  if (!candidate) throw Object.assign(new Error('That recruit is no longer available'), { status: 404 });
  if (player.money < candidate.cost) throw Object.assign(new Error('Not enough money'), { status: 400 });
}
