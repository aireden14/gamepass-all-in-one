// Общий мультиплеер для настолок, которые живут в iframe и сами считают правила
// (Каркассон, Монополия, Мачкин, Ticket to Sonnet, Оверквест, Катан Фэйбл).
//
// Схема: правила считает клиент-ведущий, сервер хранит последний снапшот и состав.
// Это даёт партии, переживающие выход, и перенос роли ведущего, если он отвалился,
// без переписывания правил шести игр на сервере.

import { Server as IOServer, Socket } from "socket.io";
import { Room, RoomRegistry } from "../multiplayer/rooms";

interface AuthedSocket extends Socket {
  data: { userId: number; telegramId: string };
}

export const TABLETOP_GAMES = [
  "carcassonne",
  "monopoly-hp",
  "machkin",
  "ticket-to-sonnet",
  "overquest",
  "catan-fable",
] as const;
export type TabletopGame = (typeof TABLETOP_GAMES)[number];

const MAX_SEATS = 6;
const MIN_TURN_SECONDS = 15;
const MAX_TURN_SECONDS = 600;

export interface TabletopSettings {
  /** сколько всего мест за столом */
  seats: number;
  /** добор ботами, если людей не хватает */
  botFill: boolean;
  /** секунды на ход; 0 — без таймера */
  turnSeconds: number;
}

export interface TabletopPlayer {
  userId: number;
  name: string;
  bot: boolean;
}

export interface TabletopState {
  game: TabletopGame;
  hostId: number;
  phase: "lobby" | "playing" | "finished";
  players: TabletopPlayer[];
  settings: TabletopSettings;
  /** последний снапшот от ведущего — по нему возвращаются вышедшие */
  snapshot: string | null;
  /** чей сейчас ход, индексом в players */
  turnIndex: number;
  turnDeadline: number | null;
}

export function normalizeSettings(raw: any): TabletopSettings {
  const seats = Math.max(2, Math.min(MAX_SEATS, Number(raw?.seats) || 2));
  const turnRaw = Number(raw?.turnSeconds) || 0;
  const turnSeconds = turnRaw <= 0
    ? 0
    : Math.max(MIN_TURN_SECONDS, Math.min(MAX_TURN_SECONDS, Math.round(turnRaw)));
  return { seats, botFill: raw?.botFill === true, turnSeconds };
}

export const isTabletopGame = (value: unknown): value is TabletopGame =>
  TABLETOP_GAMES.includes(value as TabletopGame);

const registry = new RoomRegistry<TabletopState>({
  channel: "tabletop",
  idPrefix: "TT",
  capacity: MAX_SEATS,
  onSeatAbandoned: (room, _seat, userId, io) => {
    const state = room.state;
    if (state.phase === "lobby") {
      state.players = state.players.filter((p) => p.userId !== userId);
    }
    // Ведущий не вернулся — роль уходит любому, кто остался за столом.
    if (state.hostId === userId) {
      const heir = state.players.find(
        (p) => !p.bot && p.userId !== userId && registry.isUserOnline(room, p.userId),
      );
      if (heir) state.hostId = heir.userId;
    }
    emitState(io, room);
  },
});

export function publicState(room: Room<TabletopState>) {
  const s = room.state;
  return {
    code: room.id,
    game: s.game,
    hostId: s.hostId,
    phase: s.phase,
    settings: s.settings,
    turnIndex: s.turnIndex,
    turnDeadline: s.turnDeadline,
    hasPassword: registry.hasPassword(room),
    hasSnapshot: s.snapshot !== null,
    players: s.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      bot: p.bot,
      online: p.bot ? false : registry.isUserOnline(room, p.userId),
      isHost: p.userId === s.hostId,
    })),
  };
}

function emitState(io: IOServer, room: Room<TabletopState>): void {
  registry.touch(room);
  io.to(registry.roomName(room.id)).emit("TT_STATE", { room: publicState(room) });
}

function hostSockets(room: Room<TabletopState>): string[] {
  return registry.socketsOf(room, room.state.hostId);
}

export function registerTabletopSocket(io: IOServer): void {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;

    const err = (message: string) => socket.emit("TT_ERROR", { message });
    const myRoom = () => registry.roomOf(userId) ?? null;

    socket.on("TT_CREATE", ({ game, name, password, settings }, ack) => {
      if (!isTabletopGame(game)) {
        ack?.({ ok: false, error: "unknown game" });
        return err("Неизвестная игра");
      }
      const previous = myRoom();
      if (previous) {
        socket.leave(registry.roomName(previous.id));
        registry.release(previous, userId);
      }

      const normalized = normalizeSettings(settings);
      const room = registry.create(
        userId,
        {
          game,
          hostId: userId,
          phase: "lobby",
          players: [],
          settings: normalized,
          snapshot: null,
          turnIndex: 0,
          turnDeadline: null,
        },
        password,
      );
      room.state.players.push({ userId, name: String(name || "Игрок").slice(0, 24), bot: false });
      registry.join(room.id, userId, socket, password);
      emitState(io, room);
      ack?.({ ok: true, room: publicState(room) });
    });

    socket.on("TT_JOIN", ({ code, name, password }, ack) => {
      const target = registry.get(code);
      if (!target) {
        ack?.({ ok: false, error: "room not found" });
        return err("Комната не найдена — проверь код");
      }

      const known = target.state.players.some((p) => p.userId === userId);
      if (!known && target.state.players.filter((p) => !p.bot).length >= target.state.settings.seats) {
        ack?.({ ok: false, error: "room full" });
        return err("За столом нет свободных мест");
      }

      const result = registry.join(code, userId, socket, password);
      if (!result) {
        ack?.({ ok: false, error: "room not found" });
        return err("Комната не найдена — проверь код");
      }
      if (result.error === "wrong_password") {
        ack?.({ ok: false, error: "wrong password" });
        return err("Неверный пароль");
      }
      if (!result.seat) {
        ack?.({ ok: false, error: "room full" });
        return err("За столом нет свободных мест");
      }

      const room = result.room;
      const player = room.state.players.find((p) => p.userId === userId);
      if (player) {
        if (name) player.name = String(name).slice(0, 24);
      } else {
        room.state.players.push({ userId, name: String(name || "Игрок").slice(0, 24), bot: false });
      }

      // Вернувшемуся сразу отдаём партию с того места, где она идёт.
      if (room.state.snapshot) {
        socket.emit("TT_SNAPSHOT", { snapshot: room.state.snapshot, turnIndex: room.state.turnIndex });
      }
      emitState(io, room);
      ack?.({ ok: true, room: publicState(room), reconnected: result.reconnected });
    });

    socket.on("TT_SETTINGS", ({ settings }, ack) => {
      const room = myRoom();
      if (!room || room.state.hostId !== userId) return err("Настройки меняет только ведущий");
      if (room.state.phase !== "lobby") return err("Партия уже идёт");
      room.state.settings = normalizeSettings(settings);
      emitState(io, room);
      ack?.({ ok: true, room: publicState(room) });
    });

    socket.on("TT_START", ({ snapshot }, ack) => {
      const room = myRoom();
      if (!room || room.state.hostId !== userId) return err("Начать партию может только ведущий");
      const humans = room.state.players.filter((p) => !p.bot).length;
      if (humans < 2 && !room.state.settings.botFill) {
        return err("Нужен второй игрок или добор ботами");
      }

      // Добор ботами до нужного числа мест.
      if (room.state.settings.botFill) {
        let botIndex = 1;
        while (room.state.players.length < room.state.settings.seats) {
          room.state.players.push({ userId: -botIndex, name: `Бот-${botIndex}`, bot: true });
          botIndex += 1;
        }
      }

      room.state.phase = "playing";
      room.state.turnIndex = 0;
      room.state.snapshot = typeof snapshot === "string" ? snapshot : null;
      room.state.turnDeadline = room.state.settings.turnSeconds
        ? Date.now() + room.state.settings.turnSeconds * 1000
        : null;
      emitState(io, room);
      if (room.state.snapshot) {
        io.to(registry.roomName(room.id)).emit("TT_SNAPSHOT", {
          snapshot: room.state.snapshot,
          turnIndex: 0,
        });
      }
      ack?.({ ok: true, room: publicState(room) });
    });

    // Ведущий посчитал ход и разослал новое состояние стола.
    socket.on("TT_SNAPSHOT", ({ snapshot, turnIndex, finished }, ack) => {
      const room = myRoom();
      if (!room) return;
      if (room.state.hostId !== userId) return err("Состояние публикует только ведущий");
      if (typeof snapshot !== "string") return;

      room.state.snapshot = snapshot;
      if (Number.isInteger(turnIndex)) room.state.turnIndex = Number(turnIndex);
      room.state.turnDeadline = room.state.settings.turnSeconds
        ? Date.now() + room.state.settings.turnSeconds * 1000
        : null;
      if (finished === true) {
        room.state.phase = "finished";
        room.state.turnDeadline = null;
      }
      registry.touch(room);

      socket.to(registry.roomName(room.id)).emit("TT_SNAPSHOT", {
        snapshot,
        turnIndex: room.state.turnIndex,
      });
      emitState(io, room);
      ack?.({ ok: true });
    });

    // Ход обычного игрока уходит ведущему, тот применяет его по правилам игры.
    socket.on("TT_INTENT", ({ intent }, ack) => {
      const room = myRoom();
      if (!room) return;
      if (room.state.phase !== "playing") return err("Партия ещё не идёт");
      const targets = hostSockets(room);
      if (targets.length === 0) return err("Ведущий сейчас не в сети — подожди");
      for (const sid of targets) {
        io.to(sid).emit("TT_INTENT", { from: userId, intent });
      }
      ack?.({ ok: true });
    });

    socket.on("TT_LEAVE", () => {
      const room = myRoom();
      if (!room) return;
      socket.leave(registry.roomName(room.id));
      if (room.state.phase === "lobby") {
        room.state.players = room.state.players.filter((p) => p.userId !== userId);
      }
      registry.release(room, userId);

      const humans = room.state.players.filter((p) => !p.bot);
      if (humans.length === 0) return registry.delete(room.id);
      if (room.state.hostId === userId) room.state.hostId = humans[0].userId;
      emitState(io, room);
    });

    socket.on("disconnect", () => {
      const room = myRoom();
      registry.detach(userId, socket.id, io);
      if (room) emitState(io, room);
    });
  });

  registry.startSweeper();
}

/** Только для тестов: чистый реестр столов. */
export const tabletopRegistryForTests = registry;
