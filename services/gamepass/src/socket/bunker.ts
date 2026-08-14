import { Server as IOServer, Socket } from "socket.io";
import {
  PROFESSIONS, HEALTH, HOBBIES, PHOBIAS, BAGGAGE, FACTS, ACTIONS,
  SCENARIOS, BUNKERS, makeBio, pick,
} from "./bunkerData";

interface AuthedSocket extends Socket {
  data: { userId: number; telegramId: string };
}

export const CARD_CATS = ["bio", "profession", "health", "hobby", "phobia", "baggage", "fact", "action"] as const;
export type CardCat = (typeof CARD_CATS)[number];

interface BunkerPlayer {
  userId: number;
  name: string;
  sid: string | null; // текущий socket.id
  bot?: boolean;
  alive: boolean;
  cards: Record<CardCat, string>;
  revealed: Set<CardCat>;
  vote: number | null; // userId цели
}

interface Room {
  code: string;
  hostId: number;
  phase: "lobby" | "discuss" | "vote" | "finished";
  round: number;
  scenario: (typeof SCENARIOS)[number] | null;
  bunker: (typeof BUNKERS)[number] | null;
  players: BunkerPlayer[];
  timerEnd: number | null; // ms epoch — таймер обсуждения
  voteResult: string | null;
  createdAt: number;
  updatedAt: number;
}

const rooms = new Map<string, Room>();
const ROOM_TTL = 1000 * 60 * 60 * 6;
let nextBotId = -1000;

const BOT_NAMES = [
  "Макс-бот",
  "Алиса-бот",
  "Саша-бот",
  "Мира-бот",
  "Роман-бот",
  "Лина-бот",
  "Виктор-бот",
  "Ника-бот",
];

function cleanup() {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.updatedAt > ROOM_TTL) rooms.delete(code);
  }
}
setInterval(cleanup, 1000 * 60 * 10);

const roomCh = (code: string) => `bunker:${code}`;
const normCode = (raw: unknown) =>
  String(raw ?? "").trim().toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/gi, "").slice(0, 12);

function makePlayer(userId: number, name: string, sid: string | null, bot = false): BunkerPlayer {
  return {
    userId,
    name: String(name || (bot ? "Бот" : "Игрок")).slice(0, 24),
    sid,
    bot,
    alive: true,
    cards: {} as Record<CardCat, string>,
    revealed: new Set(),
    vote: null,
  };
}

function makeUniqueTestCode() {
  for (let i = 0; i < 20; i += 1) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const code = `TEST${suffix}`;
    if (!rooms.has(code)) return code;
  }
  return `TEST${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function publicState(r: Room) {
  return {
    code: r.code,
    hostId: r.hostId,
    phase: r.phase,
    round: r.round,
    scenario: r.scenario,
    bunker: r.bunker,
    timerEnd: r.timerEnd,
    voteResult: r.voteResult,
    players: r.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      alive: p.alive,
      online: p.sid != null,
      bot: p.bot === true,
      voted: p.vote != null,
      revealed: Object.fromEntries([...p.revealed].map((c) => [c, p.cards[c]])),
      revealedCount: p.revealed.size,
    })),
  };
}

function emitState(io: IOServer, r: Room) {
  r.updatedAt = Date.now();
  io.to(roomCh(r.code)).emit("BUNKER_STATE", { state: publicState(r) });
  // личные карты — каждому только свои
  r.players.forEach((p) => {
    if (p.sid) io.to(p.sid).emit("BUNKER_HAND", { cards: p.cards, revealed: [...p.revealed] });
  });
}

function dealCards(r: Room) {
  const used = {
    prof: new Set<string>(), health: new Set<string>(), hobby: new Set<string>(),
    phobia: new Set<string>(), baggage: new Set<string>(), fact: new Set<string>(), action: new Set<string>(),
  };
  r.scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  r.bunker = BUNKERS[Math.floor(Math.random() * BUNKERS.length)];
  r.players.forEach((p) => {
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

function revealBotCards(io: IOServer, r: Room, perBot: number) {
  let revealed = 0;
  r.players.filter((p) => p.bot && p.alive).forEach((p) => {
    for (let i = 0; i < perBot; i += 1) {
      const hidden = CARD_CATS.filter((c) => !p.revealed.has(c));
      if (hidden.length === 0) break;
      const cat = hidden[Math.floor(Math.random() * hidden.length)];
      p.revealed.add(cat);
      revealed += 1;
      io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: `🤖 ${p.name} раскрывает: ${p.cards[cat]}` });
    }
  });
  return revealed;
}

function assignBotVotes(r: Room) {
  const alive = r.players.filter((p) => p.alive);
  const bots = alive.filter((p) => p.bot);
  if (bots.length === 0) return;
  // Боты договариваются об одном «козле отпущения» и валят голоса на него,
  // иначе случайный разброс почти всегда даёт ничью и тестовая партия стопорится.
  // Человека щадим: козлом выбираем бота, пока в живых есть хотя бы двое ботов.
  const scapegoat = bots.length > 1 ? bots[Math.floor(Math.random() * bots.length)] : null;
  bots.forEach((bot) => {
    if (scapegoat && bot.userId !== scapegoat.userId) {
      bot.vote = scapegoat.userId;
      return;
    }
    // сам «козёл» (или последний бот в эндшпиле) голосует за случайного живого
    const pool = alive.filter((p) => p.userId !== bot.userId);
    bot.vote = pool.length ? pool[Math.floor(Math.random() * pool.length)].userId : null;
  });
}

function tallyVotes(io: IOServer, r: Room) {
  const alive = r.players.filter((p) => p.alive);
  const counts = new Map<number, number>();
  alive.forEach((p) => {
    if (p.vote != null) counts.set(p.vote, (counts.get(p.vote) || 0) + 1);
  });
  let max = 0;
  counts.forEach((n) => { if (n > max) max = n; });
  const top = [...counts.entries()].filter(([, n]) => n === max).map(([id]) => id);
  if (max === 0 || top.length !== 1) {
    r.voteResult = "Ничья — никто не изгнан. Обсудите ещё раз!";
  } else {
    const out = r.players.find((p) => p.userId === top[0])!;
    out.alive = false;
    CARD_CATS.forEach((c) => out.revealed.add(c)); // изгнанный вскрывает всё
    r.voteResult = `⛔ ${out.name} изгнан(а) из бункера (${max} голос.)`;
  }
  r.phase = "discuss";
  r.round += 1;
  r.players.forEach((p) => { p.vote = null; });
  r.timerEnd = null;
  emitState(io, r);
}

export function registerBunkerSocket(io: IOServer) {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;
    let myRoom: string | null = null;

    const getRoom = (): Room | null => (myRoom ? rooms.get(myRoom) || null : null);
    const err = (message: string) => socket.emit("BUNKER_ERROR", { message });

    const attach = (r: Room) => {
      myRoom = r.code;
      socket.join(roomCh(r.code));
      emitState(io, r);
    };

    socket.on("BUNKER_CREATE", ({ code, name }) => {
      const c = normCode(code);
      if (c.length < 3) return err("Код комнаты — минимум 3 символа (буквы/цифры)");
      const existing = rooms.get(c);
      if (existing && Date.now() - existing.updatedAt < ROOM_TTL && existing.players.some((p) => p.sid))
        return err("Такая комната уже есть и активна — придумай другой код");
      const r: Room = {
        code: c, hostId: userId, phase: "lobby", round: 0,
        scenario: null, bunker: null, players: [], timerEnd: null, voteResult: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      r.players.push({
        ...makePlayer(userId, String(name || "Игрок"), socket.id),
      });
      rooms.set(c, r);
      attach(r);
    });

    socket.on("BUNKER_CREATE_TEST", ({ name, botCount }) => {
      if (myRoom) socket.leave(roomCh(myRoom));
      const c = makeUniqueTestCode();
      const count = Math.max(2, Math.min(7, Number(botCount) || 5));
      const r: Room = {
        code: c, hostId: userId, phase: "lobby", round: 0,
        scenario: null, bunker: null, players: [], timerEnd: null, voteResult: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      r.players.push(makePlayer(userId, String(name || "Игрок"), socket.id));
      for (let i = 0; i < count; i += 1) {
        r.players.push(makePlayer(nextBotId, BOT_NAMES[i % BOT_NAMES.length], null, true));
        nextBotId -= 1;
      }
      dealCards(r);
      r.phase = "discuss";
      r.round = 1;
      rooms.set(c, r);
      attach(r);
      io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: `🤖 Тестовая партия создана: ты и ${count} ботов.` });
    });

    socket.on("BUNKER_JOIN", ({ code, name }) => {
      const c = normCode(code);
      const r = rooms.get(c);
      if (!r) return err("Комната не найдена — проверь код");
      const existing = r.players.find((p) => p.userId === userId);
      if (existing) {
        existing.sid = socket.id;
        if (name) existing.name = String(name).slice(0, 24);
        return attach(r);
      }
      if (r.phase !== "lobby") return err("Игра уже началась — попроси создать новую комнату");
      if (r.players.length >= 12) return err("Комната переполнена (12 максимум)");
      r.players.push(makePlayer(userId, String(name || "Игрок"), socket.id));
      attach(r);
    });

    socket.on("BUNKER_LEAVE", () => {
      const r = getRoom();
      if (!r) return;
      socket.leave(roomCh(r.code));
      if (r.phase === "lobby") {
        r.players = r.players.filter((p) => p.userId !== userId);
        if (r.players.length === 0 || r.players.every((p) => !p.sid)) rooms.delete(r.code);
        else {
          if (r.hostId === userId) r.hostId = r.players[0].userId;
          emitState(io, r);
        }
      } else {
        const p = r.players.find((x) => x.userId === userId);
        if (p) p.sid = null;
        emitState(io, r);
      }
      myRoom = null;
    });

    socket.on("BUNKER_START", () => {
      const r = getRoom();
      if (!r || r.hostId !== userId) return err("Начать игру может только создатель комнаты");
      if (r.phase !== "lobby") return;
      if (r.players.length < 3) return err("Нужно минимум 3 игрока");
      dealCards(r);
      r.phase = "discuss";
      r.round = 1;
      r.voteResult = null;
      emitState(io, r);
    });

    socket.on("BUNKER_REVEAL", ({ cat }) => {
      const r = getRoom();
      if (!r || r.phase === "lobby" || r.phase === "finished") return;
      const p = r.players.find((x) => x.userId === userId);
      if (!p || !p.alive) return;
      if (!CARD_CATS.includes(cat)) return;
      p.revealed.add(cat);
      io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: `🃏 ${p.name} раскрывает: ${p.cards[cat as CardCat]}` });
      emitState(io, r);
    });

    socket.on("BUNKER_TIMER", ({ seconds }) => {
      const r = getRoom();
      if (!r || r.hostId !== userId) return;
      const s = Math.max(10, Math.min(600, Number(seconds) || 60));
      r.timerEnd = Date.now() + s * 1000;
      io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: `⏱ Ведущий запустил таймер: ${s} сек` });
      emitState(io, r);
    });

    socket.on("BUNKER_BOTS_REVEAL", ({ cards }) => {
      const r = getRoom();
      if (!r || r.hostId !== userId || r.phase !== "discuss") return;
      const perBot = Math.max(1, Math.min(3, Number(cards) || 1));
      const revealed = revealBotCards(io, r, perBot);
      if (revealed === 0) io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: "🤖 У ботов уже раскрыты все карты." });
      emitState(io, r);
    });

    socket.on("BUNKER_VOTE_START", () => {
      const r = getRoom();
      if (!r || r.hostId !== userId || r.phase !== "discuss") return;
      r.phase = "vote";
      r.voteResult = null;
      r.timerEnd = null;
      r.players.forEach((p) => { p.vote = null; });
      const botReveals = revealBotCards(io, r, 1);
      assignBotVotes(r);
      io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: "🗳 Голосование: кого изгоняем из бункера?" });
      if (botReveals > 0) io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: "🤖 Боты перед голосованием раскрыли по карте." });
      if (r.players.some((p) => p.bot && p.alive)) io.to(roomCh(r.code)).emit("BUNKER_EVENT", { text: "🤖 Боты уже сделали свой выбор." });
      emitState(io, r);
    });

    socket.on("BUNKER_VOTE", ({ target }) => {
      const r = getRoom();
      if (!r || r.phase !== "vote") return;
      const p = r.players.find((x) => x.userId === userId);
      if (!p || !p.alive) return;
      const t = r.players.find((x) => x.userId === Number(target));
      if (!t || !t.alive || t.userId === userId) return err("Голосовать можно за живого игрока (не за себя)");
      p.vote = t.userId;
      const alive = r.players.filter((x) => x.alive);
      if (alive.every((x) => x.vote != null)) tallyVotes(io, r);
      else emitState(io, r);
    });

    socket.on("BUNKER_VOTE_END", () => {
      const r = getRoom();
      if (!r || r.hostId !== userId || r.phase !== "vote") return;
      tallyVotes(io, r); // ведущий может завершить досрочно (не проголосовавшие — воздержались)
    });

    socket.on("BUNKER_FINISH", () => {
      const r = getRoom();
      if (!r || r.hostId !== userId) return;
      r.phase = "finished";
      r.players.forEach((p) => CARD_CATS.forEach((c) => p.revealed.add(c)));
      emitState(io, r);
    });

    socket.on("BUNKER_RESTART", () => {
      const r = getRoom();
      if (!r || r.hostId !== userId) return;
      r.phase = "lobby";
      r.round = 0;
      r.scenario = null;
      r.bunker = null;
      r.voteResult = null;
      r.timerEnd = null;
      r.players.forEach((p) => {
        p.alive = true; p.revealed = new Set(); p.vote = null; p.cards = {} as Record<CardCat, string>;
      });
      emitState(io, r);
    });

    socket.on("disconnect", () => {
      const r = getRoom();
      if (!r) return;
      const p = r.players.find((x) => x.userId === userId);
      if (p && p.sid === socket.id) p.sid = null;
      if (r.phase === "lobby" && r.players.every((x) => !x.sid)) rooms.delete(r.code);
      else emitState(io, r);
    });
  });
}
