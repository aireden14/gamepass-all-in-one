// Судоку PVP по сети: оба игрока решают ОДИН и тот же расклад, клетку получает
// тот, кто первым поставил верную цифру. Расклад генерирует создатель комнаты
// (генератор живёт во фронте), сервер его проверяет и дальше судит сам.

import { Server as IOServer, Socket } from "socket.io";
import { Room, RoomRegistry } from "../multiplayer/rooms";
import {
  DuelState, claimCell, createDuel, duelWinner, makePlayer, publicDuel, validatePuzzle,
} from "../sudoku/duel";

interface AuthedSocket extends Socket {
  data: { userId: number; telegramId: string };
}

interface DuelRoomState {
  duel: DuelState;
  hostId: number;
  names: Record<number, string>;
}

const registry = new RoomRegistry<DuelRoomState>({
  channel: "sudoku-duel",
  idPrefix: "SD",
  seatOrder: ["a", "b"],
  onSeatAbandoned: (room, _seat, _userId, io) => {
    // Соперник не вернулся за отведённое время — дуэль останавливаем,
    // очки остаются, доигрывать в одиночку смысла нет.
    if (room.state.duel.status !== "playing") return;
    room.state.duel.status = "finished";
    // Молча менять состояние нельзя: оставшийся игрок будет думать, что партия идёт.
    io.to(registry.roomName(room.id)).emit("SD_STATE", { room: publicRoom(room) });
    io.to(registry.roomName(room.id)).emit("SD_OVER", {
      winner: duelWinner(room.state.duel),
      room: publicRoom(room),
      reason: "opponent_left",
    });
  },
});

function publicRoom(room: Room<DuelRoomState>) {
  const duel = publicDuel(room.state.duel);
  return {
    code: room.id,
    hostId: room.state.hostId,
    hasPassword: registry.hasPassword(room),
    winner: duelWinner(room.state.duel),
    ...duel,
    players: duel.players.map((p) => ({
      ...p,
      name: room.state.names[p.userId] || "Игрок",
      online: registry.isUserOnline(room, p.userId),
    })),
  };
}

function emitState(io: IOServer, room: Room<DuelRoomState>): void {
  registry.touch(room);
  io.to(registry.roomName(room.id)).emit("SD_STATE", { room: publicRoom(room) });
}

export function registerSudokuDuelSocket(io: IOServer): void {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;
    const err = (message: string) => socket.emit("SD_ERROR", { message });
    const myRoom = () => registry.roomOf(userId) ?? null;

    socket.on("SD_CREATE", ({ puzzle, name, password }, ack) => {
      const checked = validatePuzzle(puzzle);
      if (!checked) {
        ack?.({ ok: false, error: "bad puzzle" });
        return err("Расклад не прошёл проверку");
      }
      const previous = myRoom();
      if (previous) {
        socket.leave(registry.roomName(previous.id));
        registry.release(previous, userId);
      }

      const room = registry.create(userId, {
        duel: createDuel(checked, userId),
        hostId: userId,
        names: { [userId]: String(name || "Игрок").slice(0, 24) },
      }, password);
      registry.join(room.id, userId, socket, password);
      emitState(io, room);
      ack?.({ ok: true, room: publicRoom(room) });
    });

    socket.on("SD_JOIN", ({ code, name, password }, ack) => {
      const target = registry.get(code);
      if (!target) {
        ack?.({ ok: false, error: "room not found" });
        return err("Комната не найдена — проверь код");
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
        return err("В дуэли уже двое");
      }

      const room = result.room;
      room.state.names[userId] = String(name || "Игрок").slice(0, 24);
      if (!room.state.duel.players.some((p) => p.userId === userId)) {
        room.state.duel.players.push(makePlayer(userId));
      }
      // Второй сел за доску — дуэль начинается.
      if (room.state.duel.status === "waiting" && room.state.duel.players.length === 2) {
        room.state.duel.status = "playing";
        room.state.duel.startedAt = Date.now();
      }
      emitState(io, room);
      ack?.({ ok: true, room: publicRoom(room), reconnected: result.reconnected });
    });

    socket.on("SD_CLAIM", ({ index, digit }, ack) => {
      const room = myRoom();
      if (!room) return err("Ты не в дуэли");
      const outcome = claimCell(room.state.duel, userId, Number(index), Number(digit));

      if (outcome.result === "taken") {
        io.to(registry.roomName(room.id)).emit("SD_CELL", {
          index: Number(index), digit: outcome.digit, userId, points: outcome.points,
        });
      }
      emitState(io, room);
      if (room.state.duel.status === "finished") {
        io.to(registry.roomName(room.id)).emit("SD_OVER", {
          winner: duelWinner(room.state.duel),
          room: publicRoom(room),
        });
      }
      ack?.(outcome);
    });

    socket.on("SD_LEAVE", () => {
      const room = myRoom();
      if (!room) return;
      socket.leave(registry.roomName(room.id));
      registry.release(room, userId);
      if (registry.occupiedSeats(room).length === 0) return registry.delete(room.id);
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
