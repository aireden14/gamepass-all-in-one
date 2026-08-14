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

interface AuthedSocket extends Socket {
  data: {
    userId: number;
    telegramId: string;
  };
}

interface CheckersGame {
  id: string;
  board: Board;
  turn: Color;
  chainFrom: number | null;
  status: "WAITING" | "ACTIVE" | "FINISHED";
  winner: Color | "draw" | null;
  players: {
    w: number;
    b: number | null;
  };
  createdAt: number;
  updatedAt: number;
}

const games = new Map<string, CheckersGame>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const room = (id: string) => `checkers:${id}`;
const other = (color: Color): Color => (color === "w" ? "b" : "w");

function makeId(): string {
  for (let tries = 0; tries < 20; tries += 1) {
    let id = "CK";
    for (let i = 0; i < 4; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!games.has(id)) return id;
  }
  return `CK${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

function publicGame(game: CheckersGame) {
  return {
    id: game.id,
    board: game.board,
    turn: game.turn,
    chainFrom: game.chainFrom,
    status: game.status,
    winner: game.winner,
    players: game.players,
  };
}

function playerColor(game: CheckersGame, userId: number): Color | null {
  if (game.players.w === userId) return "w";
  if (game.players.b === userId) return "b";
  return null;
}

function emitState(io: IOServer, game: CheckersGame): void {
  io.to(room(game.id)).emit("CHECKERS_STATE", { game: publicGame(game) });
}

function finishIfNeeded(game: CheckersGame): void {
  if (game.status === "FINISHED") return;
  if (!hasAnyMove(game.board, game.turn)) {
    game.status = "FINISHED";
    game.winner = other(game.turn);
  }
}

function validateMove(game: CheckersGame, color: Color, move: Move): Move | null {
  if (game.chainFrom !== null && move.from !== game.chainFrom) return null;
  return allLegalMoves(game.board, color).find(
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

    socket.on("CHECKERS_CREATE", (_payload, ack) => {
      const id = makeId();
      const game: CheckersGame = {
        id,
        board: initialBoard(),
        turn: "w",
        chainFrom: null,
        status: "WAITING",
        winner: null,
        players: { w: userId, b: null },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      games.set(id, game);
      socket.join(room(id));
      socket.emit("CHECKERS_STATE", { game: publicGame(game) });
      ack?.({ ok: true, game: publicGame(game) });
    });

    socket.on("CHECKERS_JOIN", ({ gameId }: { gameId: string }, ack) => {
      const id = String(gameId || "").trim().toUpperCase();
      const game = games.get(id);
      if (!game) {
        ack?.({ ok: false, error: "game not found" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра не найдена" });
      }

      const color = playerColor(game, userId);
      if (!color) {
        if (game.players.b === null) {
          game.players.b = userId;
          game.status = "ACTIVE";
          game.updatedAt = Date.now();
        } else {
          ack?.({ ok: false, error: "game full" });
          return socket.emit("CHECKERS_ERROR", { message: "Игра уже заполнена" });
        }
      }

      socket.join(room(id));
      emitState(io, game);
      ack?.({ ok: true, game: publicGame(game) });
    });

    socket.on("CHECKERS_MOVE", ({ gameId, move }: { gameId: string; move: Move }, ack) => {
      const game = games.get(String(gameId || "").trim().toUpperCase());
      if (!game) {
        ack?.({ ok: false, error: "game not found" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра не найдена" });
      }
      if (game.status !== "ACTIVE") {
        ack?.({ ok: false, error: "game not active" });
        return socket.emit("CHECKERS_ERROR", { message: "Игра ещё не активна" });
      }

      const color = playerColor(game, userId);
      if (!color || color !== game.turn) {
        ack?.({ ok: false, error: "not your turn" });
        return socket.emit("CHECKERS_ERROR", { message: "Сейчас не твой ход" });
      }

      const legal = validateMove(game, color, move);
      if (!legal) {
        ack?.({ ok: false, error: "illegal move" });
        return socket.emit("CHECKERS_ERROR", { message: "Нельзя так ходить" });
      }

      const result = applyMove(game.board, legal.from, legal.to, legal.captured);
      game.board = result.board;
      game.updatedAt = Date.now();
      if (result.mustContinue) {
        game.chainFrom = result.end;
      } else {
        game.chainFrom = null;
        game.turn = other(game.turn);
      }
      finishIfNeeded(game);
      emitState(io, game);
      ack?.({ ok: true, game: publicGame(game) });
    });

    socket.on("CHECKERS_RESTART", ({ gameId }: { gameId: string }, ack) => {
      const game = games.get(String(gameId || "").trim().toUpperCase());
      if (!game) return ack?.({ ok: false, error: "game not found" });
      if (!playerColor(game, userId)) return ack?.({ ok: false, error: "not participant" });
      game.board = initialBoard();
      game.turn = "w";
      game.chainFrom = null;
      game.status = game.players.b === null ? "WAITING" : "ACTIVE";
      game.winner = null;
      game.updatedAt = Date.now();
      emitState(io, game);
      ack?.({ ok: true, game: publicGame(game) });
    });
  });

  setInterval(() => {
    const cutoff = Date.now() - 1000 * 60 * 60 * 6;
    for (const [id, game] of games.entries()) {
      if (game.updatedAt < cutoff) games.delete(id);
    }
  }, 1000 * 60 * 30).unref?.();
}
