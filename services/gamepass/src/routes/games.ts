import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { gameToDTO, getGame, makeBotMoveIfNeeded, GameWithPlayers } from "../services/gameService";
import { safeJson } from "../utils/json";
import { serializeSettings, parseSettings } from "../utils/settings";
import { getIO } from "../socket";

export const gamesRouter = Router();
gamesRouter.use(authMiddleware);

const VALID_TIME = new Set([0, 60, 180, 300, 600, 900, 1800]);
const VALID_INC = new Set([0, 1, 2, 3, 5, 10]);

async function getOrCreateBotUser() {
  const botTgId = BigInt(0); // зарезервируем 0 под бота
  return prisma.user.upsert({
    where: { telegramId: botTgId },
    update: {},
    create: {
      telegramId: botTgId,
      firstName: "Шахматный бот",
      username: "chess_bot",
      isBot: true,
      rating: 1200,
    },
  });
}

gamesRouter.post("/create", async (req: AuthedRequest, res) => {
  try {
    const { timeControl = 600, increment = 0, colorChoice = "random", vsBot, botDifficulty, customCode } =
      req.body || {};
    if (!VALID_TIME.has(timeControl)) return res.status(400).json({ error: "bad timeControl" });
    if (!VALID_INC.has(increment)) return res.status(400).json({ error: "bad increment" });
    if (!["random", "white", "black"].includes(colorChoice))
      return res.status(400).json({ error: "bad colorChoice" });

    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!me) return res.status(404).json({ error: "user not found" });
    console.log("[create game] userId:", me.id, "telegramId:", me.telegramId);

    let myColor: "w" | "b";
    if (colorChoice === "white") myColor = "w";
    else if (colorChoice === "black") myColor = "b";
    else myColor = Math.random() < 0.5 ? "w" : "b";

    const isBotGame = !!vsBot;
    let game;

    if (isBotGame) {
      const diff: "easy" | "medium" = botDifficulty === "easy" ? "easy" : "medium";
      const bot = await getOrCreateBotUser();
      const botColor = myColor === "w" ? "black" : "white";
      game = await prisma.game.create({
        data: {
          status: "ACTIVE",
          playerWhiteId: myColor === "w" ? me.id : bot.id,
          playerBlackId: myColor === "b" ? me.id : bot.id,
          timerWhite: timeControl,
          timerBlack: timeControl,
          increment,
          isBotGame: true,
          botDifficulty: diff,
          botColor,
          lastMoveAt: new Date(),
          settings: serializeSettings({ timeControl, increment, colorChoice }),
        },
        include: { playerWhite: true, playerBlack: true },
      });
      // Если бот ходит первым — сразу делаем его ход
      if (botColor === "white") {
        await makeBotMoveIfNeeded(game.id);
        game = (await getGame(game.id))!;
      }
    } else {
      let gameId = customCode?.trim();
      if (!gameId) {
        // Generate random 6 character alphanumeric code
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        gameId = '';
        for (let i = 0; i < 6; i++) {
          gameId += chars.charAt(Math.floor(Math.random() * chars.length));
        }
      }
      
      try {
        game = await prisma.game.create({
          data: {
            id: gameId,
            status: "WAITING",
            playerWhiteId: myColor === "w" ? me.id : null,
            playerBlackId: myColor === "b" ? me.id : null,
            timerWhite: timeControl,
            timerBlack: timeControl,
            increment,
            settings: serializeSettings({ timeControl, increment, colorChoice }),
          },
          include: { playerWhite: true, playerBlack: true },
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return res.status(400).json({ error: "Этот код уже занят. Придумайте другой!" });
        }
        throw err;
      }
    }

    const botUsername = process.env.BOT_USERNAME || "your_bot";
    const inviteLink = `https://t.me/${botUsername}/app?startapp=${game.id}`;
    return res.json({
      gameId: game.id,
      inviteLink,
      game: safeJson(gameToDTO(game)),
    });
  } catch (e: any) {
    console.error("[games/create]", e);
    return res.status(500).json({ error: e?.message || "server error" });
  }
});

gamesRouter.post("/:gameId/join", async (req: AuthedRequest, res) => {
  try {
    const { gameId } = req.params;
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!me) return res.status(404).json({ error: "user not found" });

    const game = await getGame(gameId as string);
    if (!game) return res.status(404).json({ error: "game not found" });
    if (game.status !== "WAITING") {
      // Если уже участник — просто вернуть текущее состояние
      if (game.playerWhiteId === me.id || game.playerBlackId === me.id) {
        return res.json({ game: safeJson(gameToDTO(game)) });
      }
      return res.status(409).json({ error: "game not joinable" });
    }
    if (game.playerWhiteId === me.id || game.playerBlackId === me.id) {
      return res.json({ game: safeJson(gameToDTO(game)) });
    }

    const settings = parseSettings(game.settings);
    const colorChoice = settings.colorChoice || "random";

    let updateData: any = { status: "ACTIVE", lastMoveAt: new Date() };
    if (colorChoice === "random") {
      // Один из слотов уже занят? — нет, в random оба null. Раскидываем
      const meWhite = Math.random() < 0.5;
      updateData.playerWhiteId = meWhite ? me.id : game.playerWhiteId;
      updateData.playerBlackId = meWhite ? game.playerBlackId : me.id;
      // Один слот будет всё ещё null — заполним его создателем (но мы не знаем создателя в random режиме без поля)
      // В нашей схеме при colorChoice=random оба null. Значит создателя нужно где-то хранить.
      // Решение: ищем "ожидающего" — это создатель, его id где-то должен быть. Если оба null — найдём по статусу WAITING.
      // Здесь упрощаем: если оба null — нужно знать создателя. В реальном сценарии добавим creatorId.
      // Для текущей логики: создатель — НЕ оставляющий обоих null. Его игрок-id уже указан.
    } else {
      // Создатель занял известный слот — мы добираем противоположный
      if (game.playerWhiteId && !game.playerBlackId) updateData.playerBlackId = me.id;
      else if (game.playerBlackId && !game.playerWhiteId) updateData.playerWhiteId = me.id;
      else return res.status(409).json({ error: "no free slot" });
    }

    const updated = await prisma.game.update({
      where: { id: gameId as string },
      data: updateData,
      include: { playerWhite: true, playerBlack: true },
    });

    const dto = gameToDTO(updated as GameWithPlayers);
    const io = getIO();
    if (io) io.to(`game:${gameId}`).emit("GAME_STARTED", { game: safeJson(dto) });
    return res.json({ game: safeJson(dto) });
  } catch (e: any) {
    console.error("[games/join]", e);
    return res.status(500).json({ error: e?.message || "server error" });
  }
});

gamesRouter.get("/my/active", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const games = await prisma.game.findMany({
    where: {
      OR: [{ playerWhiteId: userId }, { playerBlackId: userId }],
      status: { in: ["ACTIVE", "WAITING", "PAUSED", "PAUSE_REQUESTED"] },
    },
    orderBy: { updatedAt: "desc" },
    include: { playerWhite: true, playerBlack: true },
  });
  res.json(safeJson(games.map((g) => gameToDTO(g))));
});

gamesRouter.get("/my/history", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const games = await prisma.game.findMany({
    where: {
      OR: [{ playerWhiteId: userId }, { playerBlackId: userId }],
      status: "COMPLETED",
    },
    orderBy: { updatedAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
    include: { playerWhite: true, playerBlack: true },
  });
  res.json(safeJson(games.map((g) => gameToDTO(g))));
});

gamesRouter.get("/public/waiting", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const games = await prisma.game.findMany({
    where: {
      status: "WAITING",
      isBotGame: false,
      playerWhiteId: { not: userId },
      playerBlackId: { not: userId },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { playerWhite: true, playerBlack: true },
  });
  res.json(safeJson(games.map((g) => gameToDTO(g))));
});

gamesRouter.get("/:gameId", async (req: AuthedRequest, res) => {
  const { gameId } = req.params;
  const game = await getGame(gameId as string);
  if (!game) return res.status(404).json({ error: "not found" });
  res.json(safeJson(gameToDTO(game)));
});

gamesRouter.delete("/:gameId/cancel", async (req: AuthedRequest, res) => {
  const { gameId } = req.params;
  const game = await getGame(gameId as string);
  if (!game) return res.status(404).json({ error: "not found" });
  if (game.status !== "WAITING") return res.status(409).json({ error: "not waiting" });
  const userId = req.auth!.userId;
  if (game.playerWhiteId !== userId && game.playerBlackId !== userId)
    return res.status(403).json({ error: "not yours" });
  await prisma.game.delete({ where: { id: game.id } });
  res.json({ ok: true });
});
