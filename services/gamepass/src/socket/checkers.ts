import { Server as IOServer, Socket } from "socket.io";
import {
  Board,
  Color,
  Move,
  allLegalMoves,
  applyMove,
  hasAnyMove,
  initialBoard,
} from "../checkers/engine";
import { Room, RoomRegistry } from "../multiplayer/rooms";

interface AuthedSocket extends Socket {
  data: {
    userId: number;
    telegramId: string;
  };
}

/** Чисто игровое состояние: участники и присутствие живут в ядре комнат. */
interface CheckersState {
  board: Board;
  turn: Color;
  chainFrom: number | null;
  status: "WAITING" | "ACTIVE" | "FINISHED";
  winner: Color | "draw" | null;
}

const other = (color: Color): Color => (color === "w" ? "b" : "w");

const registry = new RoomRegistry<CheckersState>({
  channel: "checkers",
  idPrefix: "CK",
  seatOrder: ["w", "b"],
  onSeatAbandoned: (room, seat) => {
    // Игрок не вернулся за отведённое время — партия останавливается и ждёт замены.
    if (room.state.status !== "ACTIVE") return;
    room.state.status = "WAITING";
    void seat;
  },
});

function initialState(): CheckersState {
  return { board: initialBoard(), turn: "w", chainFrom: null, status: "WAITING", winner: null };
}

function publicGame(room: Room<CheckersState>) {
  return {
    id: room.id,
    board: room.state.board,
    turn: room.state.turn,
    chainFrom: room.state.chainFrom,
    status: room.state.status,
    winner: room.state.winner,
    players: {
      w: room.seats.get("w") ?? null,
      b: room.seats.get("b") ?? null,
    },
    presence: registry.presence(room),
    hasPassword: registry.hasPassword(room),
  };
}

function emitState(io: IOServer, room: Room<CheckersState>): void {
  io.to(registry.roomName(room.id)).emit("CHECKERS_STATE", { game: publicGame(room) });
}

function finishIfNeeded(state: CheckersState): void {
  if (state.status !== "ACTIVE") return;
  if (!hasAnyMove(state.board, state.turn)) {
    state.status = "FINISHED";
    state.winner = other(state.turn);
  }
}

function validateMove(state: CheckersState, color: Color, move: Move): Move | null {
  if (state.chainFrom !== null && move.from !== state.chainFrom) return null;
  return allLegalMoves(state.board, color).find(
    (candidate) =>
      candidate.from === move.from &&
      candidate.to === move.to &&
      candidate.captured === move.captured,
  ) || null;
}

export function registerCheckersSocket(io: IOServer): void {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;

    socket.on("CHECKERS_CREATE", ({ password }: { password?: string } = {}, ack) => {
      const room = registry.create(userId, initialState(), password);
      registry.join(room.id, userId, socket);
      socket.emit("CHECKERS_STATE", { game: publicGame(room) });
      ack?.({ ok: true, game: publicGame(room) });
    });

    socket.on(
      "CHECKERS_JOIN",
      ({ gameId, password }: { gameId: string; password?: string }, ack) => {
      const result = registry.join(gameId, userId, socket, password);
      if (!result) {
        ack?.({ ok: false, error: "game not found" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра не найдена" });
      }
      const { room, seat, reconnected } = result;
      if (result.error === "wrong_password") {
        ack?.({ ok: false, error: "wrong password" });
        return socket.emit("CHECKERS_ERROR", { message: "Неверный пароль" });
      }
      if (!seat) {
        ack?.({ ok: false, error: "game full" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра уже заполнена" });
      }

      if (room.state.status === "WAITING" && registry.occupiedSeats(room).length === 2) {
        room.state.status = "ACTIVE";
      }
      registry.touch(room);
      emitState(io, room);
      ack?.({ ok: true, game: publicGame(room), reconnected });
    },
    );

    socket.on("CHECKERS_MOVE", ({ gameId, move }: { gameId: string; move: Move }, ack) => {
      const room = registry.get(gameId);
      if (!room) {
        ack?.({ ok: false, error: "game not found" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра не найдена" });
      }
      if (room.state.status !== "ACTIVE") {
        ack?.({ ok: false, error: "game not active" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра ещё не активна" });
      }

      const color = registry.seatOf(room, userId) as Color | null;
      if (!color || color !== room.state.turn) {
        ack?.({ ok: false, error: "not your turn" });
        return socket.emit("CHECKERS_ERROR", { message: "Сейчас не твой ход" });
      }

      const legal = validateMove(room.state, color, move);
      if (!legal) {
        ack?.({ ok: false, error: "illegal move" });
        return socket.emit("CHECKERS_ERROR", { message: "Нельзя так ходить" });
      }

      const result = applyMove(room.state.board, legal.from, legal.to, legal.captured);
      room.state.board = result.board;
      if (result.mustContinue) {
        room.state.chainFrom = result.end;
      } else {
        room.state.chainFrom = null;
        room.state.turn = other(room.state.turn);
      }
      finishIfNeeded(room.state);
      registry.touch(room);
      emitState(io, room);
      ack?.({ ok: true, game: publicGame(room) });
    });

    socket.on("CHECKERS_RESTART", ({ gameId }: { gameId: string }, ack) => {
      const room = registry.get(gameId);
      if (!room) return ack?.({ ok: false, error: "game not found" });
      if (!registry.seatOf(room, userId)) return ack?.({ ok: false, error: "not participant" });

      const twoSeated = registry.occupiedSeats(room).length === 2;
      room.state = initialState();
      room.state.status = twoSeated ? "ACTIVE" : "WAITING";
      registry.touch(room);
      emitState(io, room);
      ack?.({ ok: true, game: publicGame(room) });
    });

    socket.on("disconnect", () => {
      registry.detach(userId, socket.id, io);
    });
  });

  registry.startSweeper();
}
