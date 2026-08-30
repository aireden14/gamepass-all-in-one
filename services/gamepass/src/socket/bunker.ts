import { Server as IOServer, Socket } from "socket.io";
import {
  BunkerState, CARD_CATS, CardCat, assignBotVotes, dealCards, initialState,
  makePlayer, revealBotCards, tallyVotes,
} from "../bunker/engine";
import { Room, RoomRegistry } from "../multiplayer/rooms";

interface AuthedSocket extends Socket {
  data: { userId: number; telegramId: string };
}

export { CARD_CATS };
export type { CardCat };

const MAX_PLAYERS = 12;
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

const registry = new RoomRegistry<BunkerState>({
  channel: "bunker",
  idPrefix: "BK",
  capacity: MAX_PLAYERS,
  onSeatAbandoned: (room, _seat, userId, io) => {
    // Игрок не вернулся за отведённое время: в лобби убираем совсем,
    // в идущей партии оставляем в составе — иначе развалится расклад карт.
    if (room.state.phase !== "lobby") return;
    room.state.players = room.state.players.filter((p) => p.userId !== userId);
    if (room.state.hostId === userId && room.state.players.length > 0) {
      room.state.hostId = room.state.players[0].userId;
    }
    emitState(io, room);
  },
});

const normCode = (raw: unknown) =>
  String(raw ?? "").trim().toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/gi, "").slice(0, 12);

function makeUniqueTestCode(): string {
  for (let i = 0; i < 20; i += 1) {
    const code = `TEST${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    if (!registry.get(code)) return code;
  }
  return `TEST${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function publicState(room: Room<BunkerState>) {
  const s = room.state;
  return {
    code: room.id,
    hostId: s.hostId,
    phase: s.phase,
    round: s.round,
    scenario: s.scenario,
    bunker: s.bunker,
    timerEnd: s.timerEnd,
    voteResult: s.voteResult,
    hasPassword: registry.hasPassword(room),
    players: s.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      alive: p.alive,
      online: p.bot ? false : registry.isUserOnline(room, p.userId),
      bot: p.bot === true,
      voted: p.vote != null,
      revealed: Object.fromEntries([...p.revealed].map((c) => [c, p.cards[c]])),
      revealedCount: p.revealed.size,
    })),
  };
}

function emitState(io: IOServer, room: Room<BunkerState>) {
  registry.touch(room);
  io.to(registry.roomName(room.id)).emit("BUNKER_STATE", { state: publicState(room) });
  // личные карты — каждому только свои, во все его вкладки
  room.state.players.forEach((p) => {
    if (p.bot) return;
    for (const sid of registry.socketsOf(room, p.userId)) {
      io.to(sid).emit("BUNKER_HAND", { cards: p.cards, revealed: [...p.revealed] });
    }
  });
}

const say = (io: IOServer, room: Room<BunkerState>, text: string) =>
  io.to(registry.roomName(room.id)).emit("BUNKER_EVENT", { text });

export function registerBunkerSocket(io: IOServer) {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;

    const getRoom = (): Room<BunkerState> | null => registry.roomOf(userId) ?? null;
    const err = (message: string) => socket.emit("BUNKER_ERROR", { message });
    const me = (room: Room<BunkerState>) => room.state.players.find((p) => p.userId === userId);

    socket.on("BUNKER_CREATE", ({ code, name, password }) => {
      const c = normCode(code);
      if (c.length < 3) return err("Код комнаты — минимум 3 символа (буквы/цифры)");
      const existing = registry.get(c);
      if (existing && existing.state.players.some((p) => registry.isUserOnline(existing, p.userId))) {
        return err("Такая комната уже есть и активна — придумай другой код");
      }
      if (existing) registry.delete(c);

      const room = registry.create(userId, initialState(userId), password, { id: c });
      room.state.players.push(makePlayer(userId, String(name || "Игрок")));
      registry.join(room.id, userId, socket, password);
      emitState(io, room);
    });

    socket.on("BUNKER_CREATE_TEST", ({ name, botCount }) => {
      const previous = getRoom();
      if (previous) {
        socket.leave(registry.roomName(previous.id));
        registry.release(previous, userId);
      }

      const count = Math.max(2, Math.min(7, Number(botCount) || 5));
      const room = registry.create(userId, initialState(userId), null, { id: makeUniqueTestCode() });
      room.state.players.push(makePlayer(userId, String(name || "Игрок")));
      registry.join(room.id, userId, socket);

      for (let i = 0; i < count; i += 1) {
        const botId = nextBotId;
        nextBotId -= 1;
        if (!registry.claimSeat(room, botId)) break;
        room.state.players.push(makePlayer(botId, BOT_NAMES[i % BOT_NAMES.length], true));
      }
      dealCards(room.state);
      room.state.phase = "discuss";
      room.state.round = 1;
      emitState(io, room);
      say(io, room, `🤖 Тестовая партия создана: ты и ${count} ботов.`);
    });

    socket.on("BUNKER_JOIN", ({ code, name, password }) => {
      const c = normCode(code);
      const target = registry.get(c);
      if (!target) return err("Комната не найдена — проверь код");

      const known = target.state.players.some((p) => p.userId === userId);
      if (!known && target.state.phase !== "lobby") {
        return err("Игра уже началась — попроси создать новую комнату");
      }

      const result = registry.join(c, userId, socket, password);
      if (!result) return err("Комната не найдена — проверь код");
      if (result.error === "wrong_password") return err("Неверный пароль");
      if (!result.seat) return err(`Комната переполнена (${MAX_PLAYERS} максимум)`);

      const room = result.room;
      const player = me(room);
      if (player) {
        if (name) player.name = String(name).slice(0, 24);
      } else {
        room.state.players.push(makePlayer(userId, String(name || "Игрок")));
      }
      emitState(io, room);
    });

    socket.on("BUNKER_LEAVE", () => {
      const room = getRoom();
      if (!room) return;
      socket.leave(registry.roomName(room.id));

      if (room.state.phase === "lobby") {
        room.state.players = room.state.players.filter((p) => p.userId !== userId);
        registry.release(room, userId);
        const humans = room.state.players.filter((p) => !p.bot);
        if (humans.length === 0) return registry.delete(room.id);
        if (room.state.hostId === userId) room.state.hostId = room.state.players[0].userId;
      } else {
        registry.release(room, userId);
      }
      emitState(io, room);
    });

    socket.on("BUNKER_START", () => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId) return err("Начать игру может только создатель комнаты");
      if (room.state.phase !== "lobby") return;
      if (room.state.players.length < 3) return err("Нужно минимум 3 игрока");
      dealCards(room.state);
      room.state.phase = "discuss";
      room.state.round = 1;
      room.state.voteResult = null;
      emitState(io, room);
    });

    socket.on("BUNKER_REVEAL", ({ cat }) => {
      const room = getRoom();
      if (!room || room.state.phase === "lobby" || room.state.phase === "finished") return;
      const p = me(room);
      if (!p || !p.alive) return;
      if (!CARD_CATS.includes(cat)) return;
      p.revealed.add(cat);
      say(io, room, `🃏 ${p.name} раскрывает: ${p.cards[cat as CardCat]}`);
      emitState(io, room);
    });

    socket.on("BUNKER_TIMER", ({ seconds }) => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId) return;
      const s = Math.max(10, Math.min(600, Number(seconds) || 60));
      room.state.timerEnd = Date.now() + s * 1000;
      say(io, room, `⏱ Ведущий запустил таймер: ${s} сек`);
      emitState(io, room);
    });

    socket.on("BUNKER_BOTS_REVEAL", ({ cards }) => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId || room.state.phase !== "discuss") return;
      const perBot = Math.max(1, Math.min(3, Number(cards) || 1));
      const events = revealBotCards(room.state, perBot);
      events.forEach((text) => say(io, room, text));
      if (events.length === 0) say(io, room, "🤖 У ботов уже раскрыты все карты.");
      emitState(io, room);
    });

    socket.on("BUNKER_VOTE_START", () => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId || room.state.phase !== "discuss") return;
      room.state.phase = "vote";
      room.state.voteResult = null;
      room.state.timerEnd = null;
      room.state.players.forEach((p) => { p.vote = null; });

      const events = revealBotCards(room.state, 1);
      events.forEach((text) => say(io, room, text));
      assignBotVotes(room.state);
      say(io, room, "🗳 Голосование: кого изгоняем из бункера?");
      if (events.length > 0) say(io, room, "🤖 Боты перед голосованием раскрыли по карте.");
      if (room.state.players.some((p) => p.bot && p.alive)) say(io, room, "🤖 Боты уже сделали свой выбор.");
      emitState(io, room);
    });

    socket.on("BUNKER_VOTE", ({ target }) => {
      const room = getRoom();
      if (!room || room.state.phase !== "vote") return;
      const p = me(room);
      if (!p || !p.alive) return;
      const t = room.state.players.find((x) => x.userId === Number(target));
      if (!t || !t.alive || t.userId === userId) return err("Голосовать можно за живого игрока (не за себя)");
      p.vote = t.userId;
      const alive = room.state.players.filter((x) => x.alive);
      if (alive.every((x) => x.vote != null)) {
        const { message } = tallyVotes(room.state);
        say(io, room, message);
      }
      emitState(io, room);
    });

    socket.on("BUNKER_VOTE_END", () => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId || room.state.phase !== "vote") return;
      // ведущий может завершить досрочно — не проголосовавшие считаются воздержавшимися
      const { message } = tallyVotes(room.state);
      say(io, room, message);
      emitState(io, room);
    });

    socket.on("BUNKER_FINISH", () => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId) return;
      room.state.phase = "finished";
      room.state.players.forEach((p) => CARD_CATS.forEach((c) => p.revealed.add(c)));
      emitState(io, room);
    });

    socket.on("BUNKER_RESTART", () => {
      const room = getRoom();
      if (!room || room.state.hostId !== userId) return;
      const s = room.state;
      s.phase = "lobby";
      s.round = 0;
      s.scenario = null;
      s.bunker = null;
      s.voteResult = null;
      s.timerEnd = null;
      s.players.forEach((p) => {
        p.alive = true; p.revealed = new Set(); p.vote = null; p.cards = {} as Record<CardCat, string>;
      });
      emitState(io, room);
    });

    socket.on("disconnect", () => {
      const room = getRoom();
      registry.detach(userId, socket.id, io);
      if (room) emitState(io, room);
    });
  });

  registry.startSweeper();
}
