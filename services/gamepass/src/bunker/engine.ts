// Чистая логика Бункера: раздача, боты, голосование. Без сокетов и без сети —
// поэтому её можно прогонять хедлесс-симуляцией.

import {
  PROFESSIONS, HEALTH, HOBBIES, PHOBIAS, BAGGAGE, FACTS, ACTIONS,
  SCENARIOS, BUNKERS, makeBio, pick,
} from "../socket/bunkerData";

export const CARD_CATS = ["bio", "profession", "health", "hobby", "phobia", "baggage", "fact", "action"] as const;
export type CardCat = (typeof CARD_CATS)[number];

export interface BunkerPlayer {
  userId: number;
  name: string;
  bot: boolean;
  alive: boolean;
  cards: Record<CardCat, string>;
  revealed: Set<CardCat>;
  vote: number | null;
}

export interface BunkerState {
  hostId: number;
  phase: "lobby" | "discuss" | "vote" | "finished";
  round: number;
  scenario: (typeof SCENARIOS)[number] | null;
  bunker: (typeof BUNKERS)[number] | null;
  players: BunkerPlayer[];
  timerEnd: number | null;
  voteResult: string | null;
}

export type Rng = () => number;
const defaultRng: Rng = Math.random;
const choose = <T>(list: T[], rng: Rng): T => list[Math.floor(rng() * list.length)];

export function makePlayer(userId: number, name: string, bot = false): BunkerPlayer {
  return {
    userId,
    name: String(name || (bot ? "Бот" : "Игрок")).slice(0, 24),
    bot,
    alive: true,
    cards: {} as Record<CardCat, string>,
    revealed: new Set(),
    vote: null,
  };
}

export function initialState(hostId: number): BunkerState {
  return {
    hostId,
    phase: "lobby",
    round: 0,
    scenario: null,
    bunker: null,
    players: [],
    timerEnd: null,
    voteResult: null,
  };
}

export function dealCards(state: BunkerState, rng: Rng = defaultRng): void {
  const used = {
    prof: new Set<string>(), health: new Set<string>(), hobby: new Set<string>(),
    phobia: new Set<string>(), baggage: new Set<string>(), fact: new Set<string>(), action: new Set<string>(),
  };
  state.scenario = choose([...SCENARIOS], rng);
  state.bunker = choose([...BUNKERS], rng);
  state.players.forEach((p) => {
    p.alive = true;
    p.revealed = new Set();
    p.vote = null;
    p.cards = {
      bio: makeBio(),
      profession: pick(PROFESSIONS, used.prof),
      health: pick(HEALTH, used.health),
      hobby: pick(HOBBIES, used.hobby),
      phobia: pick(PHOBIAS, used.phobia),
      baggage: pick(BAGGAGE, used.baggage),
      fact: pick(FACTS, used.fact),
      action: pick(ACTIONS, used.action),
    };
  });
}

/** Раскрывает карты ботов и возвращает тексты событий для чата. */
export function revealBotCards(state: BunkerState, perBot: number, rng: Rng = defaultRng): string[] {
  const events: string[] = [];
  state.players.filter((p) => p.bot && p.alive).forEach((p) => {
    for (let i = 0; i < perBot; i += 1) {
      const hidden = CARD_CATS.filter((c) => !p.revealed.has(c));
      if (hidden.length === 0) break;
      const cat = choose([...hidden], rng);
      p.revealed.add(cat);
      events.push(`🤖 ${p.name} раскрывает: ${p.cards[cat]}`);
    }
  });
  return events;
}

export function assignBotVotes(state: BunkerState, rng: Rng = defaultRng): void {
  const alive = state.players.filter((p) => p.alive);
  const bots = alive.filter((p) => p.bot);
  if (bots.length === 0) return;
  // Боты договариваются об одном «козле отпущения» и валят голоса на него,
  // иначе случайный разброс почти всегда даёт ничью и партия стопорится.
  // Человека щадим: козлом выбираем бота, пока в живых есть хотя бы двое ботов.
  const scapegoat = bots.length > 1 ? choose(bots, rng) : null;
  bots.forEach((bot) => {
    if (scapegoat && bot.userId !== scapegoat.userId) {
      bot.vote = scapegoat.userId;
      return;
    }
    const pool = alive.filter((p) => p.userId !== bot.userId);
    bot.vote = pool.length ? choose(pool, rng).userId : null;
  });
}

export interface TallyResult {
  eliminated: BunkerPlayer | null;
  message: string;
}

export function tallyVotes(state: BunkerState): TallyResult {
  const alive = state.players.filter((p) => p.alive);
  const counts = new Map<number, number>();
  alive.forEach((p) => {
    if (p.vote != null) counts.set(p.vote, (counts.get(p.vote) || 0) + 1);
  });
  let max = 0;
  counts.forEach((n) => { if (n > max) max = n; });
  const top = [...counts.entries()].filter(([, n]) => n === max).map(([id]) => id);

  let eliminated: BunkerPlayer | null = null;
  if (max === 0 || top.length !== 1) {
    state.voteResult = "Ничья — никто не изгнан. Обсудите ещё раз!";
  } else {
    eliminated = state.players.find((p) => p.userId === top[0])!;
    eliminated.alive = false;
    CARD_CATS.forEach((c) => eliminated!.revealed.add(c)); // изгнанный вскрывает всё
    state.voteResult = `⛔ ${eliminated.name} изгнан(а) из бункера (${max} голос.)`;
  }

  state.phase = "discuss";
  state.round += 1;
  state.players.forEach((p) => { p.vote = null; });
  state.timerEnd = null;
  return { eliminated, message: state.voteResult! };
}
