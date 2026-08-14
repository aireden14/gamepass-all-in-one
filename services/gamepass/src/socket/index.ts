import { Server as IOServer, Socket } from "socket.io";
import { Server as HttpServer } from "node:http";
import { verifyToken } from "../utils/jwt";
import { prisma } from "../utils/prisma";
import {
  applyMove,
  finishGame,
  gameToDTO,
  getGame,
  getPlayerColor,
  makeBotMoveIfNeeded,
} from "../services/gameService";
import { safeJson } from "../utils/json";
import { parseSettings } from "../utils/settings";
import { registerCheckersSocket } from "./checkers";
import { registerBunkerSocket } from "./bunker";
import { registerCatanSocket } from "./catan";

let io: IOServer | null = null;
export function getIO() {
  return io;
}

interface AuthedSocket extends Socket {
  data: {
    userId: number;
    telegramId: string;
  };
}

const onlineUsers = new Map<number, Set<string>>(); // userId -> socketIds
function addOnline(userId: number, sid: string) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId)!.add(sid);
}
function removeOnline(userId: number, sid: string) {
  const s = onlineUsers.get(userId);
  if (!s) return;
  s.delete(sid);
  if (s.size === 0) onlineUsers.delete(userId);
}
export function isOnline(userId: number) {
  return onlineUsers.has(userId);
}

export function initSocket(httpServer: HttpServer, _frontendUrl: string) {
  io = new IOServer(httpServer, {
    cors: { origin: true, credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("missing token"));
    const payload = verifyToken(token);
    if (!payload) return next(new Error("invalid token"));
    (socket as AuthedSocket).data = { userId: payload.userId, telegramId: payload.telegramId };
    next();
  });

  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;
    const userId = socket.data.userId;
    console.log("[socket] connected userId:", userId, "telegramId:", socket.data.telegramId);
    addOnline(userId, socket.id);

    socket.on("JOIN_GAME_ROOM", async ({ gameId }) => {
      try {
        const game = await getGame(gameId);
        if (!game) return socket.emit("ERROR", { message: "game not found" });
        socket.join(`game:${gameId}`);
        socket.emit("GAME_STATE", { game: safeJson(gameToDTO(game)) });
        // Сообщить противнику что мы онлайн
        socket.to(`game:${gameId}`).emit("OPPONENT_ONLINE", {});
      } catch (e: any) {
        socket.emit("ERROR", { message: e?.message || "join error" });
      }
    });

    socket.on("MAKE_MOVE", async ({ gameId, move }) => {
      try {
        console.log("[MAKE_MOVE] gameId:", gameId, "userId:", userId, "move:", move);
        const r = await applyMove(gameId, userId, move);
        if (!r.ok) return socket.emit("ERROR", { message: r.error });
        const dto = gameToDTO(r.game);
        io!.to(`game:${gameId}`).emit("MOVE_MADE", {
          fen: dto.fen,
          pgn: dto.pgn,
          san: r.san,
          timerWhite: dto.timerWhite,
          timerBlack: dto.timerBlack,
          currentTurn: dto.currentTurn,
          serverTime: Date.now(),
          lastMoveAt: dto.lastMoveAt,
        });
        if (r.gameOver) {
          io!.to(`game:${gameId}`).emit("GAME_OVER", {
            winner: r.game.winner,
            reason: r.game.endReason,
            game: safeJson(dto),
          });
          return;
        }
        // Если игра против бота — следующий ход бота
        if (r.game.isBotGame) {
          const botRes = await makeBotMoveIfNeeded(gameId);
          if (botRes) {
            const dto2 = gameToDTO(botRes.game);
            io!.to(`game:${gameId}`).emit("MOVE_MADE", {
              fen: dto2.fen,
              pgn: dto2.pgn,
              san: botRes.san,
              timerWhite: dto2.timerWhite,
              timerBlack: dto2.timerBlack,
              currentTurn: dto2.currentTurn,
              serverTime: Date.now(),
              lastMoveAt: dto2.lastMoveAt,
            });
            if (botRes.gameOver) {
              io!.to(`game:${gameId}`).emit("GAME_OVER", {
                winner: botRes.game.winner,
                reason: botRes.game.endReason,
                game: safeJson(dto2),
              });
            }
          }
        }
      } catch (e: any) {
        console.error("[MAKE_MOVE]", e);
        socket.emit("ERROR", { message: e?.message || "move error" });
      }
    });

    socket.on("RESIGN", async ({ gameId }) => {
      try {
        const game = await getGame(gameId);
        if (!game) return socket.emit("ERROR", { message: "game not found" });
        const color = getPlayerColor(game, userId);
        if (!color) return socket.emit("ERROR", { message: "not participant" });
        const winner = color === "w" ? "black" : "white";
        await finishGame(gameId, winner, "resignation");
        const fresh = await getGame(gameId);
        io!.to(`game:${gameId}`).emit("GAME_OVER", {
          winner,
          reason: "resignation",
          game: safeJson(gameToDTO(fresh!)),
        });
      } catch (e: any) {
        socket.emit("ERROR", { message: e?.message || "resign error" });
      }
    });

    socket.on("OFFER_DRAW", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "ACTIVE") return;
      const color = getPlayerColor(game, userId);
      if (!color) return;
      await prisma.game.update({
        where: { id: gameId },
        data: { drawOfferBy: color === "w" ? "white" : "black" },
      });
      io!.to(`game:${gameId}`).emit("DRAW_OFFERED", { by: color === "w" ? "white" : "black" });
    });

    socket.on("ACCEPT_DRAW", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || !game.drawOfferBy || game.status !== "ACTIVE") return;
      const color = getPlayerColor(game, userId);
      if (!color) return;
      const meStr = color === "w" ? "white" : "black";
      if (meStr === game.drawOfferBy) return; // нельзя принять свой же офер
      await finishGame(gameId, "draw", "draw_agreement");
      const fresh = await getGame(gameId);
      io!.to(`game:${gameId}`).emit("GAME_OVER", {
        winner: "draw",
        reason: "draw_agreement",
        game: safeJson(gameToDTO(fresh!)),
      });
    });

    socket.on("DECLINE_DRAW", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game) return;
      await prisma.game.update({ where: { id: gameId }, data: { drawOfferBy: null } });
      io!.to(`game:${gameId}`).emit("DRAW_DECLINED", {});
    });

    socket.on("REQUEST_PAUSE", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "ACTIVE") return;
      const color = getPlayerColor(game, userId);
      if (!color) return;
      // Сохраняем текущие таймеры
      let { timerWhite, timerBlack } = game;
      const tc = parseSettings(game.settings).timeControl ?? 0;
      if (tc > 0 && game.lastMoveAt) {
        const elapsed = (Date.now() - game.lastMoveAt.getTime()) / 1000;
        if (game.currentTurn === "w") timerWhite = Math.max(0, timerWhite - elapsed);
        else timerBlack = Math.max(0, timerBlack - elapsed);
      }
      await prisma.game.update({
        where: { id: gameId },
        data: {
          status: "PAUSE_REQUESTED",
          pauseRequestBy: color === "w" ? "white" : "black",
          timerWhite: Math.round(timerWhite),
          timerBlack: Math.round(timerBlack),
          lastMoveAt: null,
        },
      });
      io!.to(`game:${gameId}`).emit("PAUSE_REQUESTED", { by: color === "w" ? "white" : "black" });
    });

    socket.on("ACCEPT_PAUSE", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "PAUSE_REQUESTED") return;
      const color = getPlayerColor(game, userId);
      if (!color) return;
      const meStr = color === "w" ? "white" : "black";
      if (meStr === game.pauseRequestBy) return;
      await prisma.game.update({ where: { id: gameId }, data: { status: "PAUSED" } });
      io!.to(`game:${gameId}`).emit("PAUSE_ACCEPTED", {
        timerWhite: game.timerWhite,
        timerBlack: game.timerBlack,
      });
    });

    socket.on("DECLINE_PAUSE", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "PAUSE_REQUESTED") return;
      await prisma.game.update({
        where: { id: gameId },
        data: { status: "ACTIVE", lastMoveAt: new Date(), pauseRequestBy: null },
      });
      io!.to(`game:${gameId}`).emit("PAUSE_DECLINED", {});
    });

    socket.on("REQUEST_RESUME", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "PAUSED") return;
      const color = getPlayerColor(game, userId);
      if (!color) return;
      io!.to(`game:${gameId}`).emit("RESUME_REQUESTED", { by: color === "w" ? "white" : "black" });
    });

    socket.on("ACCEPT_RESUME", async ({ gameId }) => {
      const game = await getGame(gameId);
      if (!game || game.status !== "PAUSED") return;
      await prisma.game.update({
        where: { id: gameId },
        data: { status: "ACTIVE", lastMoveAt: new Date(), pauseRequestBy: null },
      });
      const fresh = await getGame(gameId);
      const dto = gameToDTO(fresh!);
      io!.to(`game:${gameId}`).emit("RESUME_ACCEPTED", {
        timerWhite: dto.timerWhite,
        timerBlack: dto.timerBlack,
        fen: dto.fen,
        pgn: dto.pgn,
      });
    });

    socket.on("DECLINE_RESUME", ({ gameId }) => {
      io!.to(`game:${gameId}`).emit("RESUME_DECLINED", {});
    });

    socket.on("disconnect", () => {
      removeOnline(userId, socket.id);
      // Уведомить все комнаты — упрощённо: на момент disconnect мы не знаем roomы.
      // Используем socket.rooms в pre-disconnect, см. 'disconnecting'.
    });

    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("game:")) {
          socket.to(room).emit("OPPONENT_OFFLINE", {});
        }
      }
    });
  });

  registerCheckersSocket(io);
  registerBunkerSocket(io);
  registerCatanSocket(io);

  return io;
}

/**
 * Глобальный watchdog таймера: каждые 5с проверяет ACTIVE-игры с timeControl>0
 * и закрывает те, у которых истекло время текущего игрока.
 */
export function startTimerWatchdog() {
  setInterval(async () => {
    try {
      const games = await prisma.game.findMany({
        where: { status: "ACTIVE", lastMoveAt: { not: null } },
        include: { playerWhite: true, playerBlack: true },
      });
      for (const g of games) {
        const tc = (g.settings as any)?.timeControl ?? 0;
        if (!tc) continue;
        const elapsed = (Date.now() - g.lastMoveAt!.getTime()) / 1000;
        const remaining =
          g.currentTurn === "w" ? g.timerWhite - elapsed : g.timerBlack - elapsed;
        if (remaining <= 0) {
          const winner = g.currentTurn === "w" ? "black" : "white";
          await finishGame(g.id, winner, "timeout");
          const fresh = await getGame(g.id);
          if (io && fresh) {
            io.to(`game:${g.id}`).emit("GAME_OVER", {
              winner,
              reason: "timeout",
              game: safeJson(gameToDTO(fresh)),
            });
          }
        }
      }
    } catch (e) {
      console.error("[timer-watchdog]", e);
    }
  }, 5000);
}
