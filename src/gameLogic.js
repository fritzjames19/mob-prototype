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
export const NUMBER_CARDS = [2,3,4,5,6,7,8,9,10].map(n => ({
  id: 'card' + n, name: String(n), tier: 'number', cost: 40 + (n - 2) * 12,
}));
export const PREMIUM_TITLES = {
  jack:  { id: 'jack',  name: 'Jack',  tier: 'premium', cost: 900,  desc: '+6% money from every job', bonusType: 'money', value: 0.06 },
  queen: { id: 'queen', name: 'Queen', tier: 'premium', cost: 900,  desc: '+6% respect from every job', bonusType: 'respect', value: 0.06 },
  king:  { id: 'king',  name: 'King',  tier: 'premium', cost: 1400, desc: '-15% heat from every crime', bonusType: 'heat', value: 0.15 },
  ace:   { id: 'ace',   name: 'Ace',   tier: 'premium', cost: 1600, desc: '+8% XP from every job', bonusType: 'xp', value: 0.08 },
};
export function allTitleDefs() { return [...NUMBER_CARDS, ...Object.values(PREMIUM_TITLES)]; }
export function titleDef(id) { return allTitleDefs().find(t => t.id === id); }
export function ownsAnyTitle(titleIds) { return (titleIds || []).length > 0; }

// titleIds = array of title id strings the player owns (fetched from the `titles` table).
export function titleBonusMult(titleIds, bonusType) {
  const owned = (titleIds || []).map(id => PREMIUM_TITLES[id]).filter(t => t && t.bonusType === bonusType)[0];
  if (!owned) return 1;
  return bonusType === 'heat' ? (1 - owned.value) : (1 + owned.value);
}
export function applyHeatGain(amount, titleIds) {
  return Math.max(0, Math.round(amount * titleBonusMult(titleIds, 'heat')));
}
export function canBuyTitle(player, ownedTitleIds, titleId) {
  const t = titleDef(titleId);
  if (!t) throw Object.assign(new Error('Unknown title'), { status: 400 });
  if ((ownedTitleIds || []).includes(titleId)) throw Object.assign(new Error('You already own that title'), { status: 409 });
  if (player.money < t.cost) throw Object.assign(new Error('Not enough money'), { status: 400 });
  return t;
}

export function resolveQuest(player, gang, questId, titleIds) {
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
  money = Math.round(money * titleBonusMult(titleIds, 'money'));

  let respect = q.respect;
  if (faction.respectMult) respect = Math.round(respect * faction.respectMult);
  respect = Math.round(respect * titleBonusMult(titleIds, 'respect'));

  const xp = Math.round(q.xp * (1 + player.xp_boost / 100) * titleBonusMult(titleIds, 'xp'));

  player.energy -= q.energy;
  player.money += money;
  player.respect += respect;
  player.heat = Math.min(100, player.heat + applyHeatGain(q.heat, titleIds));
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

// --- Underground: Black Market + Secret Deals ---
export const BLACK_MARKET_COOLDOWN_MS = 12 * 60 * 1000;
export const BLACK_MARKET_ENERGY_COST = 35;

const ELITE_TARGET_NAMES = ["\"Two-Tone\" Costa","Ivan Sorokin","\"Needles\" Park","Ramon Castillo","\"Silent\" Wu","Alexei Volkova","\"Preacher\" Diallo","Mateo Reyes","\"Cold Eyes\" Han","Grigor Popov"];

export function randomEliteTarget(playerBasePower) {
  const power = Math.max(30, Math.round(playerBasePower * (0.45 + Math.random() * 0.3)));
  return {
    name: ELITE_TARGET_NAMES[Math.floor(Math.random() * ELITE_TARGET_NAMES.length)] + " (Underboss)",
    defense: Math.round(power * 0.42),
    luck: 8 + Math.floor(Math.random() * 12),
    money: 300 + power * 6,
    respect: 20 + Math.round(power * 0.2),
  };
}

export function canAttemptBlackMarket(player, titleIds, sniperLastUsedAt) {
  if (!ownsAnyTitle(titleIds)) throw Object.assign(new Error('The Underground is members-only — you need a Title'), { status: 403 });
  if (heatTier(player.heat) === 'wanted' || heatTier(player.heat) === 'mostwanted') {
    throw Object.assign(new Error('Too hot to make a move right now'), { status: 403 });
  }
  if (player.energy < BLACK_MARKET_ENERGY_COST) throw Object.assign(new Error('Not enough energy'), { status: 400 });
  if (sniperLastUsedAt) {
    const elapsed = Date.now() - new Date(sniperLastUsedAt).getTime();
    if (elapsed < BLACK_MARKET_COOLDOWN_MS) {
      throw Object.assign(new Error('Your contact is still cooling off from the last job'), { status: 429, retryAfterMs: BLACK_MARKET_COOLDOWN_MS - elapsed });
    }
  }
}

export function resolveBlackMarket(player, gang, target) {
  const myRoll = player.attack + gangAttackTotal(gang) + Math.round(player.luck * 1.5) + Math.round(Math.random() * 25);
  const theirRoll = target.defense + target.luck + Math.round(Math.random() * 20);
  const won = myRoll > theirRoll;

  player.energy -= BLACK_MARKET_ENERGY_COST;
  if (won) {
    player.money += target.money;
    player.respect += target.respect;
    player.heat = Math.min(100, player.heat + 30);
    player.hits_completed += 1;
  } else {
    const lost = Math.min(player.money, Math.round(player.money * 0.2) + 80);
    player.money -= lost;
    player.heat = Math.min(100, player.heat + 15);
    player.hits_failed += 1;
  }
  return { player, won };
}

export const SECRET_DEAL_TEMPLATES = {
  atk:     { id: 'atk', label: 'Weapon Dealer', desc: '+3 Attack, permanent', cost: 180, apply: (p) => { p.attack += 3; } },
  def:     { id: 'def', label: 'Armor Plating', desc: '+3 Defense, permanent', cost: 180, apply: (p) => { p.defense += 3; } },
  luck:    { id: 'luck', label: 'Lucky Charm', desc: '+3 Luck, permanent', cost: 200, apply: (p) => { p.luck += 3; } },
  energy:  { id: 'energy', label: 'Stamina Contact', desc: '+10 Max Energy, permanent', cost: 260, apply: (p) => { p.max_energy += 10; p.energy += 10; } },
  respect: { id: 'respect', label: 'Reputation Broker', desc: '+15 Respect, instantly', cost: 150, apply: (p) => { p.respect += 15; } },
};
export function freshDealsPool() {
  const keys = Object.keys(SECRET_DEAL_TEMPLATES).sort(() => Math.random() - 0.5);
  return keys.slice(0, 3);
}
export function canBuyDeal(player, dealPool, dealId) {
  if (!dealPool.includes(dealId)) throw Object.assign(new Error('That deal is no longer on the table'), { status: 404 });
  const d = SECRET_DEAL_TEMPLATES[dealId];
  if (player.money < d.cost) throw Object.assign(new Error('Not enough money'), { status: 400 });
  return d;
}

// --- Gang Wars (PvP vs generated NPC rivals — quick disposable skirmishes, distinct from
// Territory's persistent named rivals and real player conquest) ---
export const PVP_ENERGY_COST = 20;
const RIVAL_TITLES_LIST = ["Boss","Capo","Don","Underboss","Kingpin"];
const RIVAL_CREWS = ["The Iron Serpents","Red Lantern Crew","The Broken Blades","Nightfall Syndicate","The Ashwood Family","Steel Talon Gang","The Hollow Crows","Copper Fang Outfit"];

export function randomGangWarsRival(playerBasePower) {
  const variance = 0.7 + Math.random() * 0.6;
  const power = Math.max(15, Math.round(playerBasePower * variance));
  const attackShare = 0.4 + Math.random() * 0.2;
  const attack = Math.round(power * attackShare);
  const defense = Math.round(power * (1 - attackShare));
  return {
    id: 'v' + Math.random().toString(36).slice(2, 10),
    name: RIVAL_TITLES_LIST[Math.floor(Math.random() * RIVAL_TITLES_LIST.length)] + ' of ' + RIVAL_CREWS[Math.floor(Math.random() * RIVAL_CREWS.length)],
    attack, defense, crewSize: Math.floor(Math.random() * 4),
    moneyStake: Math.round(power * (4 + Math.random() * 4)),
    respectStake: Math.max(2, Math.round(power * 0.15)),
  };
}
export function freshRivalPool(playerBasePower) {
  return [randomGangWarsRival(playerBasePower), randomGangWarsRival(playerBasePower), randomGangWarsRival(playerBasePower)];
}
export function canFightRival(player) {
  if (heatTier(player.heat) === 'wanted' || heatTier(player.heat) === 'mostwanted') {
    throw Object.assign(new Error('Too hot to make a move right now'), { status: 403 });
  }
  if (player.energy < PVP_ENERGY_COST) throw Object.assign(new Error('Not enough energy'), { status: 400 });
}
// Returns { player, gang, won, joinedRecruit } — joinedRecruit is a randomRecruit() object
// if a defected crew member should be added to the player's gang, else null.
export function resolveGangWarsFight(player, gang, rival, titleIds) {
  const myPower = player.attack + gangAttackTotal(gang) + Math.round(Math.random() * 15);
  const theirPower = rival.attack + Math.round(Math.random() * 15);
  const myDefRoll = player.defense + gangDefenseTotal(gang) + Math.round(Math.random() * 10);
  const theirDefRoll = rival.defense + Math.round(Math.random() * 10);
  const won = (myPower + myDefRoll) > (theirPower + theirDefRoll);

  player.energy -= PVP_ENERGY_COST;
  player.heat = Math.min(100, player.heat + applyHeatGain(won ? 8 : 5, titleIds));

  let joinedRecruit = null;
  if (won) {
    player.money += rival.moneyStake;
    player.respect += rival.respectStake;
    player.pvp_wins += 1;
    if (rival.crewSize > 0 && Math.random() < 0.35) joinedRecruit = randomRecruit();
  } else {
    const lost = Math.min(player.money, Math.round(rival.moneyStake * 0.5));
    player.money -= lost;
    player.pvp_losses += 1;
  }
  return { player, won, joinedRecruit };
}

// --- Hitlist ---
export const HIT_ENERGY_COST = 22;
const HIT_TARGET_NAMES = ["\"Two-Tone\" Costa","Ivan Sorokin","\"Needles\" Park","Ramon Castillo","\"Silent\" Wu","Alexei Volkova","\"Preacher\" Diallo","Mateo Reyes","\"Cold Eyes\" Han","Grigor Popov"];
export const HIT_TYPES = {
  anonymous: { label: "Anonymous Hit", moneyMult: 1.0, respectMult: 1.0, heat: 10 },
  faction:   { label: "Faction Hit", moneyMult: 1.4, respectMult: 0.8, heat: 16 },
  revenge:   { label: "Revenge Hit", moneyMult: 0.6, respectMult: 1.8, heat: 8 },
};
export function randomContract(playerBasePower) {
  const typeKeys = Object.keys(HIT_TYPES);
  const typeKey = typeKeys[Math.floor(Math.random() * typeKeys.length)];
  const type = HIT_TYPES[typeKey];
  const targetPower = Math.max(10, Math.round(playerBasePower * (0.6 + Math.random() * 0.7)));
  const baseMoney = 60 + targetPower * 3;
  const baseRespect = 4 + Math.round(targetPower * 0.1);
  return {
    id: 'h' + Math.random().toString(36).slice(2, 10), typeKey,
    name: HIT_TARGET_NAMES[Math.floor(Math.random() * HIT_TARGET_NAMES.length)],
    targetDefense: Math.round(targetPower * 0.5),
    targetLuck: 5 + Math.floor(Math.random() * 20),
    money: Math.round(baseMoney * type.moneyMult),
    respect: Math.round(baseRespect * type.respectMult),
  };
}
export function freshHitlistPool(playerBasePower) {
  return [randomContract(playerBasePower), randomContract(playerBasePower), randomContract(playerBasePower)];
}
export function canAttemptHit(player) {
  if (heatTier(player.heat) === 'wanted' || heatTier(player.heat) === 'mostwanted') {
    throw Object.assign(new Error('Too hot to make a move right now'), { status: 403 });
  }
  if (player.energy < HIT_ENERGY_COST) throw Object.assign(new Error('Not enough energy'), { status: 400 });
}
export function resolveHit(player, gang, contract, titleIds) {
  const type = HIT_TYPES[contract.typeKey];
  const myRoll = player.attack + gangAttackTotal(gang) + player.luck + Math.round(Math.random() * 20);
  const targetRoll = contract.targetDefense + contract.targetLuck + Math.round(Math.random() * 20);
  const success = myRoll > targetRoll;

  player.energy -= HIT_ENERGY_COST;
  if (success) {
    player.money += contract.money;
    player.respect += contract.respect;
    player.heat = Math.min(100, player.heat + applyHeatGain(type.heat, titleIds));
    player.hits_completed += 1;
  } else {
    const lost = Math.min(player.money, 25 + Math.floor(Math.random() * 35));
    player.money -= lost;
    player.heat = Math.min(100, player.heat + applyHeatGain(Math.round(type.heat / 2), titleIds));
    player.hits_failed += 1;
  }
  return { player, success };
}
// Someone puts a hit on the player — resolved automatically, no client input at all.
export function resolveIncomingHit(player, gang) {
  const attackerPower = 15 + Math.round(Math.random() * 40);
  const myDefense = player.defense + gangDefenseTotal(gang) + player.luck + Math.round(Math.random() * 15);
  const survived = myDefense >= attackerPower;
  let lost = 0;
  if (survived) {
    player.hits_survived += 1;
    player.respect += 3;
  } else {
    lost = Math.min(player.money, 40 + Math.floor(Math.random() * 60));
    player.money -= lost;
  }
  return { player, survived, lost };
}

// --- Card Battle ---
export const CARD_RARITIES = [
  { id: 'common',    label: 'Common',    weight: 60, powerMin: 5,  powerMax: 15 },
  { id: 'rare',      label: 'Rare',      weight: 25, powerMin: 15, powerMax: 30 },
  { id: 'epic',      label: 'Epic',      weight: 12, powerMin: 30, powerMax: 55 },
  { id: 'legendary', label: 'Legendary', weight: 3,  powerMin: 55, powerMax: 90 },
];
const CARD_NAMES = ["The Enforcer","The Consigliere","The Wheelman","The Fixer","The Hacker","The Smuggler",
  "The Cleaner","The Bookkeeper","The Muscle","The Informant","The Negotiator","The Ghost Driver",
  "The Torch","The Locksmith","The Sniper","The Don's Right Hand"];
export const CARD_PACK_COST = 60;
export const TOURNAMENT_ENERGY_COST = 15;

function rollRarity() {
  const total = CARD_RARITIES.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of CARD_RARITIES) { if (roll < r.weight) return r; roll -= r.weight; }
  return CARD_RARITIES[0];
}
export function openPack() {
  const rarity = rollRarity();
  const power = rarity.powerMin + Math.floor(Math.random() * (rarity.powerMax - rarity.powerMin + 1));
  return { name: CARD_NAMES[Math.floor(Math.random() * CARD_NAMES.length)], rarityId: rarity.id, power };
}
export function canBuyPack(player) {
  if (player.money < CARD_PACK_COST) throw Object.assign(new Error('Not enough money'), { status: 400 });
}
export function deckPower(cards) {
  return [...cards].sort((a, b) => b.power - a.power).slice(0, 5).reduce((s, c) => s + c.power, 0);
}
export function canPlayTournament(player, cards) {
  if (cards.length === 0) throw Object.assign(new Error('You need at least one card to enter'), { status: 400 });
  if (player.energy < TOURNAMENT_ENERGY_COST) throw Object.assign(new Error('Not enough energy'), { status: 400 });
}
export function makeTournamentOpponent(myDeck) {
  return Math.max(10, Math.round(myDeck * (0.65 + Math.random() * 0.6)));
}
// titleIds param reserved for future NFT-reward integration; returns whether a free title
// was awarded so the route can grant it via the titles table.
export function resolvetournamentMatch(player, myDeck, oppDeck, ownedTitleIds) {
  const myRoll = myDeck + Math.round(Math.random() * (myDeck * 0.3 + 5));
  const oppRoll = oppDeck + Math.round(Math.random() * (oppDeck * 0.3 + 5));
  const won = myRoll > oppRoll;

  player.energy -= TOURNAMENT_ENERGY_COST;
  let moneyGain = 0, awardTitleId = null, cashRewardInstead = 0;
  if (won) {
    player.tournament_wins += 1;
    player.tournament_points += 10;
    moneyGain = 40 + Math.round(myDeck * 1.5);
    player.money += moneyGain;
    if (Math.random() < 0.15) {
      const unowned = NUMBER_CARDS.find(c => !(ownedTitleIds || []).includes(c.id));
      if (unowned) awardTitleId = unowned.id;
      else { cashRewardInstead = 100; player.money += 100; }
    }
  } else {
    player.tournament_losses += 1;
  }
  return { player, won, moneyGain, awardTitleId, cashRewardInstead };
}
