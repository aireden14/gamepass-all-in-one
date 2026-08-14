import { Chess } from "chess.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { computeElo } from "./elo";
import { pickBotMove } from "./bot";
import { parseSettings } from "../utils/settings";

export type GameWithPlayers = Prisma.GameGetPayload<{
  include: { playerWhite: true; playerBlack: true };
}>;
type User = Prisma.UserGetPayload<{}>;

export interface GameStateDTO {
  id: string;
  status: string;
  fen: string;
  pgn: string;
  timerWhite: number;
  timerBlack: number;
  increment: number;
  currentTurn: "w" | "b";
  playerWhite: PublicUser | null;
  playerBlack: PublicUser | null;
  winner: string | null;
  endReason: string | null;
  pauseRequestBy: string | null;
  drawOfferBy: string | null;
  isBotGame: boolean;
  botDifficulty: string | null;
  botColor: string | null;
  settings: any;
  serverTime: number;
  lastMoveAt: number | null;
}

export interface PublicUser {
  id: number;
  telegramId: string;
  username: string | null;
  firstName: string;
  photoUrl: string | null;
  rating: number;
  isBot: boolean;
}

function toPublicUser(u: User | null): PublicUser | null {
  if (!u) return null;
  return {
    id: u.id,
    telegramId: u.telegramId.toString(),
    username: u.username,
    firstName: u.firstName,
    photoUrl: u.photoUrl,
    rating: u.rating,
    isBot: u.isBot,
  };
}

export function gameToDTO(game: GameWithPlayers): GameStateDTO {
  return {
    id: game.id,
    status: game.status,
    fen: game.fen,
    pgn: game.pgn,
    timerWhite: game.timerWhite,
    timerBlack: game.timerBlack,
    increment: game.increment,
    currentTurn: game.currentTurn as "w" | "b",
    playerWhite: toPublicUser(game.playerWhite),
    playerBlack: toPublicUser(game.playerBlack),
    winner: game.winner,
    endReason: game.endReason,
    pauseRequestBy: game.pauseRequestBy,
    drawOfferBy: game.drawOfferBy,
    isBotGame: game.isBotGame,
    botDifficulty: game.botDifficulty,
    botColor: game.botColor,
    settings: parseSettings(game.settings),
    serverTime: Date.now(),
    lastMoveAt: game.lastMoveAt ? game.lastMoveAt.getTime() : null,
  };
}

export async function getGame(gameId: string): Promise<GameWithPlayers | null> {
  return prisma.game.findUnique({
    where: { id: gameId },
    include: { playerWhite: true, playerBlack: true },
  });
}

export function getPlayerColor(game: GameWithPlayers, userId: number): "w" | "b" | null {
  console.log("[getPlayerColor] userId:", userId, "playerWhiteId:", game.playerWhiteId, "playerBlackId:", game.playerBlackId);
  if (game.playerWhiteId === userId) return "w";
  if (game.playerBlackId === userId) return "b";
  return null;
}

/**
 * Применяет ход. Возвращает обновлённую игру и метаданные хода или null, если ход невалиден.
 * Также отвечает за разруливание окончания игры (mate/stalemate/draw/timeout).
 */
export async function applyMove(
  gameId: string,
  userId: number,
  move: { from: string; to: string; promotion?: string },
): Promise<
  | { ok: true; game: GameWithPlayers; san: string; gameOver: boolean }
  | { ok: false; error: string; game?: GameWithPlayers }
> {
  const game = await getGame(gameId);
  if (!game) return { ok: false, error: "game not found" };
  if (game.status !== "ACTIVE") return { ok: false, error: "game not active", game };

  const color = getPlayerColor(game, userId);
  if (!color) return { ok: false, error: "not a participant", game };
  if (game.currentTurn !== color) return { ok: false, error: "not your turn", game };

  // Расчёт времени
  const timeControl = parseSettings(game.settings).timeControl ?? 0;
  let timerWhite = game.timerWhite;
  let timerBlack = game.timerBlack;

  if (timeControl > 0 && game.lastMoveAt) {
    const elapsed = (Date.now() - game.lastMoveAt.getTime()) / 1000;
    if (color === "w") {
      timerWhite = timerWhite - elapsed;
      if (timerWhite <= 0) {
        await finishGame(gameId, "black", "timeout");
        const fresh = await getGame(gameId);
        return { ok: true, game: fresh!, san: "", gameOver: true };
      }
    } else {
      timerBlack = timerBlack - elapsed;
      if (timerBlack <= 0) {
        await finishGame(gameId, "white", "timeout");
        const fresh = await getGame(gameId);
        return { ok: true, game: fresh!, san: "", gameOver: true };
      }
    }
  }

  // Валидация хода через chess.js
  const chess = new Chess(game.fen);
  if (game.pgn) {
    try {
      chess.loadPgn(game.pgn);
    } catch {
      // fallback: just FEN
    }
  }
  let result;
  try {
    result = chess.move({ from: move.from, to: move.to, promotion: move.promotion as any });
  } catch {
    return { ok: false, error: "illegal move", game };
  }
  if (!result) return { ok: false, error: "illegal move", game };

  // Increment
  if (timeControl > 0) {
    if (color === "w") timerWhite = Math.max(0, timerWhite) + game.increment;
    else timerBlack = Math.max(0, timerBlack) + game.increment;
  }

  // Сохраняем
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      fen: chess.fen(),
      pgn: chess.pgn(),
      currentTurn: chess.turn(),
      timerWhite: Math.round(timerWhite),
      timerBlack: Math.round(timerBlack),
      lastMoveAt: new Date(),
      drawOfferBy: null, // любое предложение ничьей сбрасывается ходом
    },
    include: { playerWhite: true, playerBlack: true },
  });

  // Проверка конца игры
  let gameOver = false;
  if (chess.isCheckmate()) {
    await finishGame(gameId, color === "w" ? "white" : "black", "checkmate");
    gameOver = true;
  } else if (chess.isStalemate()) {
    await finishGame(gameId, "draw", "stalemate");
    gameOver = true;
  } else if (chess.isInsufficientMaterial()) {
    await finishGame(gameId, "draw", "insufficient");
    gameOver = true;
  } else if (chess.isThreefoldRepetition()) {
    await finishGame(gameId, "draw", "threefold");
    gameOver = true;
  } else if (chess.isDraw()) {
    await finishGame(gameId, "draw", "fifty_move");
    gameOver = true;
  }

  const fresh = gameOver ? (await getGame(gameId))! : updated;
  return { ok: true, game: fresh, san: result.san, gameOver };
}

/**
 * Завершает игру, считает Elo (только если оба игрока — не боты).
 */
export async function finishGame(
  gameId: string,
  winner: "white" | "black" | "draw",
  reason: string,
): Promise<{ deltaWhite: number; deltaBlack: number }> {
  const game = await getGame(gameId);
  if (!game) return { deltaWhite: 0, deltaBlack: 0 };
  if (game.status === "COMPLETED") return { deltaWhite: 0, deltaBlack: 0 };

  let deltaWhite = 0;
  let deltaBlack = 0;

  const wPlayer = game.playerWhite;
  const bPlayer = game.playerBlack;
  const ranked = wPlayer && bPlayer && !wPlayer.isBot && !bPlayer.isBot;

  if (ranked && wPlayer && bPlayer) {
    const scoreA: 0 | 0.5 | 1 = winner === "white" ? 1 : winner === "draw" ? 0.5 : 0;
    const elo = computeElo(wPlayer.rating, bPlayer.rating, scoreA);
    deltaWhite = elo.deltaA;
    deltaBlack = elo.deltaB;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: wPlayer.id },
        data: {
          rating: elo.newA,
          totalGames: { increment: 1 },
          wins: winner === "white" ? { increment: 1 } : undefined,
          losses: winner === "black" ? { increment: 1 } : undefined,
          draws: winner === "draw" ? { increment: 1 } : undefined,
        },
      }),
      prisma.user.update({
        where: { id: bPlayer.id },
        data: {
          rating: elo.newB,
          totalGames: { increment: 1 },
          wins: winner === "black" ? { increment: 1 } : undefined,
          losses: winner === "white" ? { increment: 1 } : undefined,
          draws: winner === "draw" ? { increment: 1 } : undefined,
        },
      }),
    ]);
  } else {
    // Нерейтинговая (с ботом) — только статистика игроку-человеку
    const human = wPlayer && !wPlayer.isBot ? wPlayer : bPlayer && !bPlayer.isBot ? bPlayer : null;
    if (human) {
      const humanIsWhite = human.id === wPlayer?.id;
      const humanWon =
        (humanIsWhite && winner === "white") || (!humanIsWhite && winner === "black");
      const humanLost =
        (humanIsWhite && winner === "black") || (!humanIsWhite && winner === "white");
      await prisma.user.update({
        where: { id: human.id },
        data: {
          totalGames: { increment: 1 },
          wins: humanWon ? { increment: 1 } : undefined,
          losses: humanLost ? { increment: 1 } : undefined,
          draws: winner === "draw" ? { increment: 1 } : undefined,
        },
      });
    }
  }

  await prisma.game.update({
    where: { id: gameId },
    data: { status: "COMPLETED", winner, endReason: reason },
  });

  return { deltaWhite, deltaBlack };
}

/**
 * Если ход бота — сразу делает ход за бота. Вызывается после хода человека.
 * Возвращает обновлённую игру или null если бота не было.
 */
export async function makeBotMoveIfNeeded(
  gameId: string,
): Promise<
  | null
  | { game: GameWithPlayers; san: string; move: { from: string; to: string }; gameOver: boolean }
> {
  const game = await getGame(gameId);
  if (!game || !game.isBotGame || game.status !== "ACTIVE") return null;
  const botColor = game.botColor === "white" ? "w" : "b";
  if (game.currentTurn !== botColor) return null;

  const botUserId = botColor === "w" ? game.playerWhiteId : game.playerBlackId;
  if (!botUserId) return null;

  const move = pickBotMove(game.fen, (game.botDifficulty as "easy" | "medium") || "medium");
  if (!move) {
    // Нет ходов — должно быть закрыто валидатором (мат/пат)
    return null;
  }
  const result = await applyMove(gameId, botUserId, move);
  if (!result.ok) return null;
  return { game: result.game, san: result.san, move, gameOver: result.gameOver };
}
