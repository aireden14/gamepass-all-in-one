import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { safeJson } from "../utils/json";
import {
  cancelGame, createGame, fillAndStart, joinGame, leaveGame, loadGame, snapshotForClient,
} from "../services/catanService";
import { BotLevel } from "../catan/bot";

export const catanRouter = Router();
catanRouter.use(authMiddleware);

function genId(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без O/0/1/I/L
  let s = "";
  for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

catanRouter.post("/create", async (req: AuthedRequest, res) => {
  try {
    const { maxPlayers = 4, withBots = false, botSeats = [], targetVP = 10 } = req.body || {};
    if (![3, 4].includes(maxPlayers)) return res.status(400).json({ error: "maxPlayers must be 3 or 4" });
    if (typeof targetVP !== "number" || targetVP < 5 || targetVP > 15) {
      return res.status(400).json({ error: "bad targetVP" });
    }
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!me) return res.status(404).json({ error: "user not found" });

    const seats: Array<{ seat: number; level: BotLevel }> = [];
    if (withBots && Array.isArray(botSeats)) {
      for (const b of botSeats) {
        if (typeof b?.seat !== "number") continue;
        const level = ["easy", "medium", "hard"].includes(b?.level) ? b.level : "easy";
        if (b.seat > 0 && b.seat < maxPlayers) seats.push({ seat: b.seat, level });
      }
    }

    // Уникальный id
    let id = genId();
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.catanGame.findUnique({ where: { id } });
      if (!exists) break;
      id = genId();
    }

    const snap = await createGame({
      gameId: id,
      hostUserId: me.id,
      maxPlayers: maxPlayers as 3 | 4,
      botSeats: seats,
      settings: { targetVP, withBots, botDifficulties: Object.fromEntries(seats.map((s) => [s.seat, s.level])) },
    });

    const botUsername = process.env.BOT_USERNAME || "your_bot";
    const inviteLink = `https://t.me/${botUsername}/app?startapp=catan_${snap.id}`;
    res.json({ gameId: snap.id, inviteLink, snapshot: safeJson(snapshotForClient(snap, me.id)) });
  } catch (e: any) {
    console.error("[catan/create]", e);
    res.status(500).json({ error: e?.message || "server error" });
  }
});

catanRouter.post("/:gameId/join", async (req: AuthedRequest, res) => {
  try {
    const { gameId } = req.params;
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!me) return res.status(404).json({ error: "user not found" });
    const snap = await joinGame(gameId as string, me.id);
    res.json({ snapshot: safeJson(snapshotForClient(snap, me.id)) });
  } catch (e: any) {
    console.error("[catan/join]", e);
    res.status(500).json({ error: e?.message || "server error" });
  }
});

catanRouter.post("/:gameId/start", async (req: AuthedRequest, res) => {
  try {
    const { gameId } = req.params;
    const me = req.auth!.userId;
    const snap = await fillAndStart(gameId as string, me, "easy");
    res.json({ snapshot: safeJson(snapshotForClient(snap, me)) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "start error" });
  }
});

catanRouter.post("/:gameId/leave", async (req: AuthedRequest, res) => {
  try {
    const { gameId } = req.params;
    const me = req.auth!.userId;
    const snap = await leaveGame(gameId as string, me);
    res.json({ snapshot: snap ? safeJson(snapshotForClient(snap, me)) : null });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "leave error" });
  }
});

catanRouter.delete("/:gameId/cancel", async (req: AuthedRequest, res) => {
  try {
    const { gameId } = req.params;
    await cancelGame(gameId as string, req.auth!.userId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "cancel error" });
  }
});

catanRouter.get("/my/active", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const games = await prisma.catanGame.findMany({
    where: {
      status: { in: ["WAITING", "SETUP", "ACTIVE"] },
      players: { some: { userId } },
    },
    orderBy: { updatedAt: "desc" },
    take: 30,
    include: { players: true },
  });
  res.json(safeJson(games.map((g) => ({
    id: g.id, status: g.status, maxPlayers: g.maxPlayers,
    seats: g.players.length, createdAt: g.createdAt,
  }))));
});

catanRouter.get("/my/history", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const games = await prisma.catanGame.findMany({
    where: {
      status: "COMPLETED",
      players: { some: { userId } },
    },
    orderBy: { finishedAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
    include: { players: { include: { user: true } } },
  });
  res.json(safeJson(games.map((g) => ({
    id: g.id, status: g.status, winnerId: g.winnerId,
    maxPlayers: g.maxPlayers, finishedAt: g.finishedAt, createdAt: g.createdAt,
    seats: g.players.map((p) => ({
      seat: p.seat, userId: p.userId, isBot: p.isBot, color: p.color,
      username: p.user?.username, firstName: p.user?.firstName,
    })),
  }))));
});

catanRouter.get("/public/waiting", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const games = await prisma.catanGame.findMany({
    where: {
      status: "WAITING",
      players: { none: { userId } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { players: { include: { user: true } }, host: true },
  });
  res.json(safeJson(games.map((g) => ({
    id: g.id, maxPlayers: g.maxPlayers, seats: g.players.length,
    host: { id: g.host.id, firstName: g.host.firstName, username: g.host.username },
    createdAt: g.createdAt,
  }))));
});

catanRouter.get("/:gameId", async (req: AuthedRequest, res) => {
  const { gameId } = req.params;
  const snap = await loadGame(gameId as string);
  if (!snap) return res.status(404).json({ error: "not found" });
  res.json(safeJson(snapshotForClient(snap, req.auth!.userId)));
});
