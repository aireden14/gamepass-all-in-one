import { Server as IOServer, Socket } from "socket.io";
import { prisma } from "../utils/prisma";
import { safeJson } from "../utils/json";
import {
  applyActionAndSave, fillAndStart, loadGame, runBotIfNeeded, snapshotForClient,
} from "../services/catanService";
import { CatanAction, IllegalActionError } from "../catan/types";

interface AuthedSocket extends Socket {
  data: { userId: number; telegramId: string };
}

function room(gameId: string): string {
  return `catan:${gameId}`;
}

// Serialise actions per game so simultaneous socket events cannot overwrite
// each other's freshly persisted snapshot.
const gameQueues = new Map<string, Promise<void>>();
async function withGameLock<T>(gameId: string, task: () => Promise<T>): Promise<T> {
  const previous = gameQueues.get(gameId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const marker = run.then(() => undefined, () => undefined);
  gameQueues.set(gameId, marker);
  try {
    return await run;
  } finally {
    if (gameQueues.get(gameId) === marker) gameQueues.delete(gameId);
  }
}

async function broadcastState(io: IOServer, gameId: string): Promise<void> {
  const snap = await loadGame(gameId);
  if (!snap) return;
  const sockets = await io.in(room(gameId)).fetchSockets();
  for (const s of sockets) {
    const userId = (s.data as any)?.userId ?? null;
    s.emit("CATAN_STATE", { snapshot: safeJson(snapshotForClient(snap, userId)) });
  }
}

async function emitEvents(io: IOServer, gameId: string, events: any[]): Promise<void> {
  if (events.length === 0) return;
  io.to(room(gameId)).emit("CATAN_EVENT", { events });
}

async function drainBots(io: IOServer, gameId: string): Promise<void> {
  // защита от бесконечного цикла
  for (let i = 0; i < 200; i++) {
    const r = await runBotIfNeeded(gameId);
    if (!r) break;
    await emitEvents(io, gameId, r.events);
    await broadcastState(io, gameId);
    if (r.snapshot.state.phase === "GAME_OVER") {
      io.to(room(gameId)).emit("CATAN_GAME_OVER", {
        winnerSeat: r.snapshot.state.winnerSeat,
        finalScores: r.snapshot.state.players.map((p) => ({
          seat: p.seat, vp: (p.settlements.length + p.cities.length * 2
            + (p.hasLongestRoad ? 2 : 0) + (p.hasLargestArmy ? 2 : 0) + p.victoryPointsHidden),
        })),
      });
      break;
    }
    // небольшая пауза для естественности
    await new Promise((res) => setTimeout(res, 250));
  }
}

export function registerCatanSocket(io: IOServer): void {
  io.on("connection", (raw: Socket) => {
    const socket = raw as AuthedSocket;

    socket.on("CATAN_JOIN_ROOM", async ({ gameId }, ack?: (result: any) => void) => {
      try {
        const snap = await loadGame(gameId);
        if (!snap) {
          ack?.({ ok: false, error: "game not found" });
          return socket.emit("CATAN_ERROR", { message: "game not found" });
        }
        socket.join(room(gameId));
        await withGameLock(gameId, async () => {
          await broadcastState(io, gameId);
          // Если на ходу бот — раскручиваем
          await drainBots(io, gameId);
        });
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || "join error" });
        socket.emit("CATAN_ERROR", { message: e?.message || "join error" });
      }
    });

    socket.on("CATAN_LEAVE_ROOM", ({ gameId }) => {
      socket.leave(room(gameId));
    });

    socket.on("CATAN_START", async ({ gameId, botLevel = "medium" }, ack?: (result: any) => void) => {
      try {
        const level = ["easy", "medium", "hard"].includes(botLevel) ? botLevel : "medium";
        await withGameLock(gameId, async () => {
          await fillAndStart(gameId, socket.data.userId, level);
          await broadcastState(io, gameId);
          await drainBots(io, gameId);
        });
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message || "start error" });
        socket.emit("CATAN_ERROR", { message: e?.message || "start error" });
      }
    });

    socket.on("CATAN_ACTION", async ({ gameId, action }: { gameId: string; action: CatanAction }, ack?: (result: any) => void) => {
      try {
        if (!gameId || !action || !action.type) {
          ack?.({ ok: false, error: "bad action" });
          return socket.emit("CATAN_ERROR", { message: "bad action" });
        }
        // seat игрока в этой партии
        const player = await prisma.catanPlayer.findFirst({
          where: { gameId, userId: socket.data.userId },
        });
        if (!player) {
          ack?.({ ok: false, error: "not a participant" });
          return socket.emit("CATAN_ERROR", { message: "not a participant" });
        }
        const seat = player.seat;

        await withGameLock(gameId, async () => {
          const { events } = await applyActionAndSave(gameId, seat, action);
          await emitEvents(io, gameId, events);
          await broadcastState(io, gameId);

          const snap = await loadGame(gameId);
          if (snap?.state.phase === "GAME_OVER") {
            io.to(room(gameId)).emit("CATAN_GAME_OVER", {
              winnerSeat: snap.state.winnerSeat,
              finalScores: snap.state.players.map((p) => ({
                seat: p.seat,
                vp: (p.settlements.length + p.cities.length * 2
                  + (p.hasLongestRoad ? 2 : 0) + (p.hasLargestArmy ? 2 : 0) + p.victoryPointsHidden),
              })),
            });
            return;
          }

          // Если следующий ход за ботом — раскручиваем в той же очереди.
          await drainBots(io, gameId);
        });
        ack?.({ ok: true });
      } catch (e: any) {
        const msg = e instanceof IllegalActionError ? e.message : (e?.message || "action error");
        ack?.({ ok: false, error: msg });
        socket.emit("CATAN_ERROR", { message: msg });
      }
    });
  });
}
