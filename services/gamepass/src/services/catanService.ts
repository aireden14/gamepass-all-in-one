// Сервисный слой Catan: оборачивает движок, сохраняет/загружает Prisma,
// маскирует приватные данные при отдаче клиенту.

import { prisma } from "../utils/prisma";
import { createInitialState, applyAction, publicPlayerView } from "../catan/engine";
import { decideBotAction, BotLevel } from "../catan/bot";
import {
  Board, CatanAction, CatanEvent, CatanSettings, GameState, IllegalActionError, PlayerState,
} from "../catan/types";

export interface CatanFullSnapshot {
  id: string;
  status: string;
  hostId: number;
  winnerId: number | null;
  maxPlayers: number;
  board: Board;
  state: GameState;
  settings: CatanSettings;
  players: Array<{
    seat: number; color: string; userId: number | null; isBot: boolean;
    botLevel: BotLevel | null; hasLeft: boolean; username?: string | null;
    firstName?: string; photoUrl?: string | null;
  }>;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export async function loadGame(gameId: string): Promise<CatanFullSnapshot | null> {
  const g = await prisma.catanGame.findUnique({
    where: { id: gameId },
    include: { players: { include: { user: true } } },
  });
  if (!g) return null;
  const board = JSON.parse(g.boardJson) as Board;
  const state = JSON.parse(g.stateJson) as GameState;
  const settings = JSON.parse(g.settingsJson || "{}") as CatanSettings;
  const players = g.players
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      seat: p.seat,
      color: p.color,
      userId: p.userId,
      isBot: p.isBot,
      botLevel: (p.botLevel as BotLevel | null) ?? null,
      hasLeft: p.hasLeft,
      username: p.user?.username,
      firstName: p.user?.firstName,
      photoUrl: p.user?.photoUrl,
    }));
  return {
    id: g.id,
    status: g.status,
    hostId: g.hostId,
    winnerId: g.winnerId,
    maxPlayers: g.maxPlayers,
    board, state, settings, players,
    createdAt: g.createdAt.getTime(),
    updatedAt: g.updatedAt.getTime(),
    finishedAt: g.finishedAt?.getTime() ?? null,
  };
}

async function saveGame(snap: CatanFullSnapshot): Promise<void> {
  const finishedAt = snap.state.phase === "GAME_OVER" && !snap.finishedAt ? new Date() : (snap.finishedAt ? new Date(snap.finishedAt) : null);
  const status =
    snap.state.phase === "GAME_OVER" ? "COMPLETED" :
    snap.state.phase.startsWith("SETUP") ? "SETUP" :
    snap.status === "WAITING" ? "WAITING" : "ACTIVE";
  const winnerSeat = snap.state.winnerSeat;
  const winnerId = winnerSeat !== null ? (snap.players[winnerSeat]?.userId ?? null) : null;
  await prisma.catanGame.update({
    where: { id: snap.id },
    data: {
      status,
      boardJson: JSON.stringify(snap.board),
      stateJson: JSON.stringify(snap.state),
      settingsJson: JSON.stringify(snap.settings),
      winnerId,
      finishedAt,
    },
  });
}

// Преобразуем snapshot в DTO для клиента, маскируя приватные данные
export function snapshotForClient(snap: CatanFullSnapshot, viewerUserId: number | null) {
  const viewerSeat = snap.players.findIndex((p) => p.userId === viewerUserId);
  const players = snap.state.players.map((p) => {
    if (p.seat === viewerSeat) {
      return {
        seat: p.seat, color: p.color,
        resources: p.resources,
        devCards: p.devCards,
        newDevCards: p.newDevCards,
        playedKnights: p.playedKnights,
        settlements: p.settlements,
        cities: p.cities,
        roads: p.roads,
        hasLongestRoad: p.hasLongestRoad,
        hasLargestArmy: p.hasLargestArmy,
        victoryPointsHidden: p.victoryPointsHidden,
        publicVP: publicPlayerView(p).publicVP,
        totalVP: publicPlayerView(p).publicVP + p.victoryPointsHidden,
      };
    }
    return publicPlayerView(p);
  });
  return {
    id: snap.id,
    status: snap.status,
    hostId: snap.hostId,
    winnerId: snap.winnerId,
    maxPlayers: snap.maxPlayers,
    board: snap.board,
    settings: snap.settings,
    seats: snap.players,
    state: {
      phase: snap.state.phase,
      currentSeat: snap.state.currentSeat,
      dice: snap.state.dice,
      lastRoll: snap.state.lastRoll,
      mustDiscard: snap.state.mustDiscard,
      pendingTrades: snap.state.pendingTrades,
      longestRoadOwner: snap.state.longestRoadOwner,
      longestRoadLen: snap.state.longestRoadLen,
      largestArmyOwner: snap.state.largestArmyOwner,
      largestArmySize: snap.state.largestArmySize,
      hasRolled: snap.state.hasRolled,
      hasPlayedDevCardThisTurn: snap.state.hasPlayedDevCardThisTurn,
      freeRoadsRemaining: snap.state.freeRoadsRemaining,
      winnerSeat: snap.state.winnerSeat,
      log: snap.state.log.slice(-50),
      players,
      devDeckSize: Object.values(snap.state.devDeck).reduce((a, b) => a + b, 0),
      robberHex: snap.board.robberHex,
    },
    viewerSeat: viewerSeat >= 0 ? viewerSeat : null,
  };
}

export interface ApplyResult {
  snapshot: CatanFullSnapshot;
  events: CatanEvent[];
}

/** Применяет действие и сохраняет. Не делает за бота — это отдельный шаг. */
export async function applyActionAndSave(
  gameId: string,
  seat: number,
  action: CatanAction,
): Promise<ApplyResult> {
  const snap = await loadGame(gameId);
  if (!snap) throw new IllegalActionError("game not found");
  if (snap.state.phase === "GAME_OVER") throw new IllegalActionError("game over");
  const { events } = applyAction(snap.board, snap.state, seat, action);
  await saveGame(snap);
  return { snapshot: snap, events };
}

/** Если текущий ход у бота, играет за него (один ход). Возвращает действие/null. */
export async function runBotIfNeeded(gameId: string): Promise<ApplyResult | null> {
  const snap = await loadGame(gameId);
  if (!snap) return null;
  if (snap.state.phase === "GAME_OVER") return null;

  // Discard для ботов — отдельная история, нужен бот для каждого debtor'а
  if (snap.state.phase === "MAIN_DISCARD") {
    for (const debtor of Object.keys(snap.state.mustDiscard).map(Number)) {
      const need = snap.state.mustDiscard[debtor] ?? 0;
      if (need <= 0) continue;
      const player = snap.players[debtor];
      if (!player || !player.isBot) continue;
      const action = decideBotAction(snap.board, snap.state, debtor, (player.botLevel ?? "easy") as BotLevel);
      const { events } = applyAction(snap.board, snap.state, debtor, action);
      await saveGame(snap);
      return { snapshot: snap, events };
    }
    return null;
  }

  const curSeat = snap.state.currentSeat;
  const player = snap.players[curSeat];
  if (!player || !player.isBot) return null;

  const action = decideBotAction(snap.board, snap.state, curSeat, (player.botLevel ?? "easy") as BotLevel);
  const { events } = applyAction(snap.board, snap.state, curSeat, action);
  await saveGame(snap);
  return { snapshot: snap, events };
}

/** Создаёт новую партию, добавляет host'а и опциональных ботов. */
export async function createGame(opts: {
  gameId: string;
  hostUserId: number;
  maxPlayers: 3 | 4;
  botSeats?: Array<{ seat: number; level: BotLevel }>;
  settings?: CatanSettings;
}): Promise<CatanFullSnapshot> {
  const { gameId, hostUserId, maxPlayers, botSeats = [], settings = {} } = opts;
  const numPlayers = maxPlayers;

  const { board, state } = createInitialState({ numPlayers, settings });

  const playersData: Array<{ seat: number; color: string; userId: number | null; isBot: boolean; botLevel: BotLevel | null }> = [];
  // seat 0 — host
  playersData.push({ seat: 0, color: state.players[0]!.color, userId: hostUserId, isBot: false, botLevel: null });
  for (const b of botSeats) {
    if (b.seat <= 0 || b.seat >= maxPlayers) continue;
    playersData.push({
      seat: b.seat, color: state.players[b.seat]!.color,
      userId: null, isBot: true, botLevel: b.level,
    });
  }

  await prisma.catanGame.create({
    data: {
      id: gameId,
      status: "WAITING",
      maxPlayers,
      hostId: hostUserId,
      boardJson: JSON.stringify(board),
      stateJson: JSON.stringify(state),
      settingsJson: JSON.stringify(settings),
      players: { create: playersData.map((p) => ({
        seat: p.seat, color: p.color, userId: p.userId, isBot: p.isBot, botLevel: p.botLevel,
      })) },
    },
  });

  // Если все места уже заняты (host + боты заполнили) — стартуем
  if (playersData.length === maxPlayers) {
    await startGame(gameId);
  }

  return (await loadGame(gameId))!;
}

/** Переводит игру из WAITING в SETUP — фактически просто меняет статус, движок уже в SETUP_R1. */
export async function startGame(gameId: string): Promise<CatanFullSnapshot> {
  const snap = await loadGame(gameId);
  if (!snap) throw new IllegalActionError("not found");
  if (snap.status !== "WAITING") return snap;
  await prisma.catanGame.update({
    where: { id: gameId },
    data: { status: "SETUP" },
  });
  const fresh = (await loadGame(gameId))!;
  return fresh;
}

export async function joinGame(gameId: string, userId: number): Promise<CatanFullSnapshot> {
  const snap = await loadGame(gameId);
  if (!snap) throw new IllegalActionError("not found");
  if (snap.status !== "WAITING") {
    // если уже участник — просто вернуть
    if (snap.players.some((p) => p.userId === userId)) return snap;
    throw new IllegalActionError("not joinable");
  }
  if (snap.players.some((p) => p.userId === userId)) return snap;
  const taken = new Set(snap.players.map((p) => p.seat));
  let seat = -1;
  for (let i = 0; i < snap.maxPlayers; i++) if (!taken.has(i)) { seat = i; break; }
  if (seat < 0) throw new IllegalActionError("full");
  await prisma.catanPlayer.create({
    data: {
      gameId, seat, userId,
      color: snap.state.players[seat]!.color,
      isBot: false,
    },
  });
  const fresh1 = (await loadGame(gameId))!;
  if (fresh1.players.length >= fresh1.maxPlayers) {
    await startGame(gameId);
    return (await loadGame(gameId))!;
  }
  return fresh1;
}

export async function fillAndStart(gameId: string, hostUserId: number, defaultLevel: BotLevel = "easy"): Promise<CatanFullSnapshot> {
  const snap = await loadGame(gameId);
  if (!snap) throw new IllegalActionError("not found");
  if (snap.hostId !== hostUserId) throw new IllegalActionError("only host can start");
  if (snap.status !== "WAITING") return snap;
  const taken = new Set(snap.players.map((p) => p.seat));
  for (let seat = 0; seat < snap.maxPlayers; seat++) {
    if (!taken.has(seat)) {
      await prisma.catanPlayer.create({
        data: {
          gameId, seat, userId: null, isBot: true, botLevel: defaultLevel,
          color: snap.state.players[seat]!.color,
        },
      });
    }
  }
  return startGame(gameId);
}

export async function leaveGame(gameId: string, userId: number): Promise<CatanFullSnapshot | null> {
  const snap = await loadGame(gameId);
  if (!snap) return null;
  const me = snap.players.find((p) => p.userId === userId);
  if (!me) return snap;
  if (snap.status === "WAITING") {
    await prisma.catanPlayer.deleteMany({ where: { gameId, userId } });
    return (await loadGame(gameId));
  }
  // После старта — превращаем в бота
  await prisma.catanPlayer.updateMany({
    where: { gameId, userId },
    data: { isBot: true, botLevel: "easy", hasLeft: true },
  });
  return (await loadGame(gameId));
}

export async function cancelGame(gameId: string, userId: number): Promise<void> {
  const snap = await loadGame(gameId);
  if (!snap) throw new IllegalActionError("not found");
  if (snap.hostId !== userId) throw new IllegalActionError("only host");
  if (snap.status !== "WAITING") throw new IllegalActionError("not waiting");
  await prisma.catanGame.delete({ where: { id: gameId } });
}
