// Catan engine — чистая логика. Один источник правды для всех ходов.

import { createBoard } from "./board";
import {
  Board, CatanAction, CatanEvent, CatanSettings, COST_CITY, COST_DEV,
  COST_ROAD, COST_SETTLEMENT, DevCardType, GameState, IllegalActionError,
  LogEntry, PendingTrade, PlayerState, Resource, ResourceBag, RESOURCES,
} from "./types";

const COLORS = ["red", "blue", "white", "orange"];

export interface InitOptions {
  numPlayers: number;
  settings?: CatanSettings;
  rng?: () => number;
}

function emptyResources(): Record<Resource, number> {
  return { brick: 0, wood: 0, sheep: 0, wheat: 0, ore: 0 };
}
function emptyDev(): Record<DevCardType, number> {
  return { knight: 0, vp: 0, road_building: 0, year_of_plenty: 0, monopoly: 0 };
}

function makePlayer(seat: number): PlayerState {
  return {
    seat,
    color: COLORS[seat] ?? `p${seat}`,
    resources: emptyResources(),
    devCards: emptyDev(),
    newDevCards: emptyDev(),
    playedKnights: 0,
    settlements: [],
    cities: [],
    roads: [],
    hasLongestRoad: false,
    hasLargestArmy: false,
    victoryPointsHidden: 0,
  };
}

export function createInitialState(opts: InitOptions): { board: Board; state: GameState } {
  const { numPlayers } = opts;
  if (numPlayers < 2 || numPlayers > 4) {
    throw new IllegalActionError("numPlayers must be 2..4");
  }
  const board = createBoard({ rng: opts.rng });
  const players: PlayerState[] = [];
  for (let i = 0; i < numPlayers; i++) players.push(makePlayer(i));

  const devDeck: Record<DevCardType, number> = {
    knight: 14, vp: 5, road_building: 2, year_of_plenty: 2, monopoly: 2,
  };

  const state: GameState = {
    phase: "SETUP_R1_SETTLEMENT",
    currentSeat: 0,
    numPlayers,
    targetVP: opts.settings?.targetVP ?? 10,
    players,
    dice: null,
    lastRoll: null,
    mustDiscard: {},
    devDeck,
    longestRoadOwner: null,
    longestRoadLen: 4, // присуждается при ≥5
    largestArmyOwner: null,
    largestArmySize: 2, // присуждается при ≥3
    longestRoadAwarded: false,
    largestArmyAwarded: false,
    hasRolled: false,
    hasPlayedDevCardThisTurn: false,
    freeRoadsRemaining: 0,
    pendingTrades: [],
    winnerSeat: null,
    log: [],
  };
  return { board, state };
}

// ────────────────────────────────────────────────────────────────────────────
// Вспомогательные
// ────────────────────────────────────────────────────────────────────────────

function bagTotal(bag: Record<Resource, number>): number {
  return RESOURCES.reduce((s, r) => s + (bag[r] ?? 0), 0);
}

function hasResources(p: PlayerState, cost: ResourceBag): boolean {
  return RESOURCES.every((r) => (p.resources[r] ?? 0) >= (cost[r] ?? 0));
}

function payResources(p: PlayerState, cost: ResourceBag): void {
  for (const r of RESOURCES) p.resources[r] -= cost[r] ?? 0;
}

function gainResources(p: PlayerState, gain: ResourceBag): void {
  for (const r of RESOURCES) p.resources[r] += gain[r] ?? 0;
}

function logEvent(state: GameState, e: LogEntry): void {
  state.log.push(e);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

function settlementAt(state: GameState, vertex: string): { seat: number; type: "settlement" | "city" } | null {
  for (const p of state.players) {
    if (p.settlements.includes(vertex)) return { seat: p.seat, type: "settlement" };
    if (p.cities.includes(vertex)) return { seat: p.seat, type: "city" };
  }
  return null;
}

function roadAt(state: GameState, edge: string): number | null {
  for (const p of state.players) if (p.roads.includes(edge)) return p.seat;
  return null;
}

/** Соблюдается ли distance rule (нет поселения на смежной вершине). */
function distanceRuleOK(board: Board, state: GameState, vertex: string): boolean {
  if (settlementAt(state, vertex)) return false;
  for (const n of board.vertexNeighbors[vertex] ?? []) {
    if (settlementAt(state, n)) return false;
  }
  return true;
}

/** Есть ли у seat дорога, инцидентная этой вершине. */
function ownRoadTouchesVertex(board: Board, state: GameState, seat: number, vertex: string): boolean {
  const p = state.players[seat]!;
  for (const e of board.vertexEdges[vertex] ?? []) {
    if (p.roads.includes(e)) return true;
  }
  return false;
}

/** Можно ли построить дорогу на этом ребре (соединено с своей дорогой/поселением, не блокируется чужим settle). */
function canBuildRoadAt(board: Board, state: GameState, seat: number, edge: string): boolean {
  if (roadAt(state, edge) !== null) return false;
  const [v1, v2] = board.edgeVertices[edge]!;
  const p = state.players[seat]!;
  const ownsAtV1 = p.settlements.includes(v1) || p.cities.includes(v1);
  const ownsAtV2 = p.settlements.includes(v2) || p.cities.includes(v2);
  if (ownsAtV1 || ownsAtV2) return true;
  // Через вершину может идти, если там нет чужого поселения (которое блокирует)
  for (const v of [v1, v2]) {
    const sa = settlementAt(state, v);
    if (sa && sa.seat !== seat) continue; // блокирует
    // ищем смежное ребро seat'а
    for (const e2 of board.vertexEdges[v] ?? []) {
      if (e2 === edge) continue;
      if (p.roads.includes(e2)) return true;
    }
  }
  return false;
}

function totalVP(state: GameState, seat: number): number {
  const p = state.players[seat]!;
  let vp = p.settlements.length * 1 + p.cities.length * 2 + p.victoryPointsHidden;
  if (p.hasLongestRoad) vp += 2;
  if (p.hasLargestArmy) vp += 2;
  return vp;
}

export function computeVictoryPoints(state: GameState, seat: number): number {
  return totalVP(state, seat);
}

function checkWin(state: GameState, seat: number): boolean {
  if (totalVP(state, seat) >= state.targetVP) {
    state.winnerSeat = seat;
    state.phase = "GAME_OVER";
    logEvent(state, { t: Date.now(), seat, kind: "GAME_OVER" });
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Longest Road (DFS на графе дорог seat'а с обрывом на чужих поселениях)
// ────────────────────────────────────────────────────────────────────────────

function longestRoadFor(board: Board, state: GameState, seat: number): number {
  const p = state.players[seat]!;
  if (p.roads.length === 0) return 0;

  // Построим граф: для каждого ребра — соседние рёбра того же seat через общую вершину,
  // но при условии что чужое поселение в этой вершине обрывает цепь.
  const adj: Record<string, string[]> = {};
  for (const e of p.roads) {
    adj[e] = [];
    const [v1, v2] = board.edgeVertices[e]!;
    for (const v of [v1, v2]) {
      const occ = settlementAt(state, v);
      if (occ && occ.seat !== seat) continue; // блокирует
      for (const e2 of board.vertexEdges[v] ?? []) {
        if (e2 !== e && p.roads.includes(e2)) adj[e]!.push(e2);
      }
    }
  }

  let best = 0;
  function dfs(e: string, visited: Set<string>, depth: number) {
    if (depth > best) best = depth;
    if (depth > 60) return; // safety
    for (const e2 of adj[e] ?? []) {
      if (visited.has(e2)) continue;
      visited.add(e2);
      dfs(e2, visited, depth + 1);
      visited.delete(e2);
    }
  }
  for (const e of p.roads) {
    const v = new Set<string>([e]);
    dfs(e, v, 1);
  }
  return best;
}

function recomputeLongestRoad(board: Board, state: GameState): void {
  let bestSeat: number | null = null;
  let bestLen = 4; // нужно >=5 для бонуса
  for (const p of state.players) {
    const len = longestRoadFor(board, state, p.seat);
    if (len >= 5 && len > bestLen) {
      bestLen = len;
      bestSeat = p.seat;
    }
  }
  // Если бонус ещё никому не выдан и есть кандидат
  if (!state.longestRoadAwarded && bestSeat !== null) {
    state.players[bestSeat]!.hasLongestRoad = true;
    state.longestRoadOwner = bestSeat;
    state.longestRoadLen = bestLen;
    state.longestRoadAwarded = true;
    logEvent(state, { t: Date.now(), seat: bestSeat, kind: "LONGEST_ROAD", data: { length: bestLen } });
    return;
  }
  // Если бонус уже выдан — проверяем смену лидера / потерю
  if (state.longestRoadAwarded) {
    const currentLen =
      state.longestRoadOwner !== null
        ? longestRoadFor(board, state, state.longestRoadOwner)
        : 0;
    // Если у текущего лидера осталось <5 — бонус аннулируется до новой раздачи
    if (currentLen < 5) {
      if (state.longestRoadOwner !== null) {
        state.players[state.longestRoadOwner]!.hasLongestRoad = false;
      }
      state.longestRoadOwner = null;
      state.longestRoadLen = 4;
      state.longestRoadAwarded = false;
      // переоценим
      if (bestSeat !== null) {
        state.players[bestSeat]!.hasLongestRoad = true;
        state.longestRoadOwner = bestSeat;
        state.longestRoadLen = bestLen;
        state.longestRoadAwarded = true;
        logEvent(state, { t: Date.now(), seat: bestSeat, kind: "LONGEST_ROAD", data: { length: bestLen } });
      }
      return;
    }
    // Если кто-то строго перегнал
    if (bestSeat !== null && bestSeat !== state.longestRoadOwner && bestLen > currentLen) {
      if (state.longestRoadOwner !== null) {
        state.players[state.longestRoadOwner]!.hasLongestRoad = false;
      }
      state.players[bestSeat]!.hasLongestRoad = true;
      state.longestRoadOwner = bestSeat;
      state.longestRoadLen = bestLen;
      logEvent(state, { t: Date.now(), seat: bestSeat, kind: "LONGEST_ROAD", data: { length: bestLen } });
    } else {
      // Лидер сохраняет, обновим длину
      state.longestRoadLen = currentLen;
    }
  }
}

function recomputeLargestArmy(state: GameState): CatanEvent | null {
  let bestSeat: number | null = null;
  let bestCount = 2;
  for (const p of state.players) {
    if (p.playedKnights >= 3 && p.playedKnights > bestCount) {
      bestCount = p.playedKnights;
      bestSeat = p.seat;
    }
  }
  if (!state.largestArmyAwarded && bestSeat !== null) {
    state.players[bestSeat]!.hasLargestArmy = true;
    state.largestArmyOwner = bestSeat;
    state.largestArmySize = bestCount;
    state.largestArmyAwarded = true;
    const event: CatanEvent = { kind: "LARGEST_ARMY", seat: bestSeat, data: { size: bestCount } };
    logEvent(state, { t: Date.now(), ...event });
    return event;
  }
  if (state.largestArmyAwarded && bestSeat !== null && bestSeat !== state.largestArmyOwner && bestCount > state.largestArmySize) {
    if (state.largestArmyOwner !== null) state.players[state.largestArmyOwner]!.hasLargestArmy = false;
    state.players[bestSeat]!.hasLargestArmy = true;
    state.largestArmyOwner = bestSeat;
    state.largestArmySize = bestCount;
    const event: CatanEvent = { kind: "LARGEST_ARMY", seat: bestSeat, data: { size: bestCount } };
    logEvent(state, { t: Date.now(), ...event });
    return event;
  }
  return null;
}

function availableRoads(board: Board, state: GameState, seat: number): string[] {
  return board.edges.filter((edge) => canBuildRoadAt(board, state, seat, edge));
}

// ────────────────────────────────────────────────────────────────────────────
// Производство ресурсов при броске
// ────────────────────────────────────────────────────────────────────────────

function produceFromRoll(board: Board, state: GameState, roll: number): void {
  if (roll === 7) return;
  // Гексы с этим токеном (исключая разбойника)
  for (const h of board.hexes) {
    if (h.token !== roll) continue;
    const hid = `${h.q},${h.r}`;
    if (hid === board.robberHex) continue;
    if (h.terrain === "desert") continue;
    const res = h.terrain as Resource;
    for (const v of board.hexVertices[hid] ?? []) {
      const occ = settlementAt(state, v);
      if (!occ) continue;
      const p = state.players[occ.seat]!;
      p.resources[res] += occ.type === "city" ? 2 : 1;
    }
  }
  logEvent(state, { t: Date.now(), kind: "PRODUCE", data: { roll } });
}

// Курс торговли seat'а с банком: 4:1 базово, 3:1 если есть generic port,
// 2:1 если есть resource-port для этого ресурса.
function bankRatio(board: Board, state: GameState, seat: number, give: Resource): 2 | 3 | 4 {
  const p = state.players[seat]!;
  const myVertices = new Set([...p.settlements, ...p.cities]);
  let ratio: 2 | 3 | 4 = 4;
  for (const port of board.ports) {
    if (!port.vertices.some((v) => myVertices.has(v))) continue;
    if (port.kind === give) return 2;
    if (port.kind === "any" && ratio > 3) ratio = 3;
  }
  return ratio;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase transitions
// ────────────────────────────────────────────────────────────────────────────

function advanceSetup(state: GameState): void {
  // Порядок: R1 seats 0..n-1, R2 seats n-1..0. Каждый раз settlement → road → next seat.
  const n = state.numPlayers;
  switch (state.phase) {
    case "SETUP_R1_SETTLEMENT":
      state.phase = "SETUP_R1_ROAD";
      return;
    case "SETUP_R1_ROAD":
      if (state.currentSeat < n - 1) {
        state.currentSeat += 1;
        state.phase = "SETUP_R1_SETTLEMENT";
      } else {
        // переход к R2, тот же seat начинает второй раунд
        state.phase = "SETUP_R2_SETTLEMENT";
      }
      return;
    case "SETUP_R2_SETTLEMENT":
      state.phase = "SETUP_R2_ROAD";
      return;
    case "SETUP_R2_ROAD":
      if (state.currentSeat > 0) {
        state.currentSeat -= 1;
        state.phase = "SETUP_R2_SETTLEMENT";
      } else {
        // SETUP завершён → seat 0 начинает MAIN
        state.currentSeat = 0;
        state.phase = "MAIN_ROLL";
        state.hasRolled = false;
      }
      return;
  }
}

function endTurn(state: GameState): void {
  // Переносим newDevCards → devCards
  const p = state.players[state.currentSeat]!;
  for (const k of Object.keys(p.newDevCards) as DevCardType[]) {
    p.devCards[k] += p.newDevCards[k];
    p.newDevCards[k] = 0;
  }
  state.currentSeat = (state.currentSeat + 1) % state.numPlayers;
  state.phase = "MAIN_ROLL";
  state.hasRolled = false;
  state.hasPlayedDevCardThisTurn = false;
  state.freeRoadsRemaining = 0;
  state.pendingTrades = [];
  state.dice = null;
  logEvent(state, { t: Date.now(), seat: state.currentSeat, kind: "END_TURN" });
}

// ────────────────────────────────────────────────────────────────────────────
// Discard / Robber после 7
// ────────────────────────────────────────────────────────────────────────────

function startDiscardPhase(state: GameState): void {
  state.mustDiscard = {};
  for (const p of state.players) {
    const total = bagTotal(p.resources);
    if (total > 7) state.mustDiscard[p.seat] = Math.floor(total / 2);
  }
  if (Object.keys(state.mustDiscard).length > 0) {
    state.phase = "MAIN_DISCARD";
  } else {
    state.phase = "MAIN_ROBBER";
  }
}

function maybeFinishDiscard(state: GameState): void {
  if (state.phase !== "MAIN_DISCARD") return;
  if (Object.values(state.mustDiscard).every((n) => n === 0)) {
    state.mustDiscard = {};
    state.phase = "MAIN_ROBBER";
  }
}

function pickRandomVictim(board: Board, state: GameState, hexId_: string, mover: number, rng: () => number): number | null {
  const candidates = new Set<number>();
  for (const v of board.hexVertices[hexId_] ?? []) {
    const occ = settlementAt(state, v);
    if (occ && occ.seat !== mover && bagTotal(state.players[occ.seat]!.resources) > 0) {
      candidates.add(occ.seat);
    }
  }
  const arr = Array.from(candidates);
  if (arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)]!;
}

function stealOne(state: GameState, fromSeat: number, toSeat: number, rng: () => number): Resource | null {
  const victim = state.players[fromSeat]!;
  const pool: Resource[] = [];
  for (const r of RESOURCES) {
    for (let i = 0; i < victim.resources[r]; i++) pool.push(r);
  }
  if (pool.length === 0) return null;
  const res = pool[Math.floor(rng() * pool.length)]!;
  victim.resources[res] -= 1;
  state.players[toSeat]!.resources[res] += 1;
  return res;
}

// ────────────────────────────────────────────────────────────────────────────
// Главная apply-функция
// ────────────────────────────────────────────────────────────────────────────

export interface ApplyOpts {
  rng?: () => number;
}

export function applyAction(
  board: Board,
  state: GameState,
  seat: number,
  action: CatanAction,
  opts: ApplyOpts = {},
): { events: CatanEvent[] } {
  const rng = opts.rng ?? Math.random;
  const events: CatanEvent[] = [];

  if (state.phase === "GAME_OVER") throw new IllegalActionError("game over");

  // DISCARD доступен и не текущему игроку
  if (action.type === "DISCARD") {
    if (state.phase !== "MAIN_DISCARD") throw new IllegalActionError("not in discard phase");
    const need = state.mustDiscard[seat] ?? 0;
    if (need <= 0) throw new IllegalActionError("nothing to discard");
    let sum = 0;
    for (const r of RESOURCES) sum += action.resources[r] ?? 0;
    if (sum !== need) throw new IllegalActionError(`must discard exactly ${need}`);
    const p = state.players[seat]!;
    for (const r of RESOURCES) {
      const v = action.resources[r] ?? 0;
      if ((p.resources[r] ?? 0) < v) throw new IllegalActionError("not enough resources");
    }
    for (const r of RESOURCES) p.resources[r] -= action.resources[r] ?? 0;
    state.mustDiscard[seat] = 0;
    logEvent(state, { t: Date.now(), seat, kind: "DISCARD", data: { resources: action.resources } });
    events.push({ kind: "DISCARD", seat, data: { resources: action.resources } });
    maybeFinishDiscard(state);
    return { events };
  }

  // ACCEPT_TRADE может прислать любой не-текущий игрок
  if (action.type === "ACCEPT_TRADE") {
    const trade = state.pendingTrades.find((t) => t.id === action.offerId);
    if (!trade) throw new IllegalActionError("no such trade");
    const accepter = state.players[action.bySeat]!;
    if (action.bySeat === trade.fromSeat) throw new IllegalActionError("cannot accept own trade");
    if (!hasResources(accepter, trade.receive as ResourceBag)) {
      throw new IllegalActionError("accepter lacks resources");
    }
    if (!trade.acceptedBy.includes(action.bySeat)) trade.acceptedBy.push(action.bySeat);
    return { events };
  }

  // Остальные действия — только от текущего игрока
  if (seat !== state.currentSeat) throw new IllegalActionError("not your turn");

  switch (action.type) {
    // ── SETUP ─────────────────────────────────────
    case "BUILD_SETTLEMENT": {
      if (state.phase === "SETUP_R1_SETTLEMENT" || state.phase === "SETUP_R2_SETTLEMENT") {
        const v = action.vertex;
        if (!board.vertexNeighbors[v]) throw new IllegalActionError("unknown vertex");
        if (!distanceRuleOK(board, state, v)) throw new IllegalActionError("distance rule");
        const p = state.players[seat]!;
        p.settlements.push(v);
        // во второй фазе SETUP — раздаём ресурсы с трёх смежных гексов
        if (state.phase === "SETUP_R2_SETTLEMENT") {
          for (const hid of board.vertexHexes[v] ?? []) {
            const h = board.hexById[hid]!;
            if (h.terrain !== "desert") p.resources[h.terrain as Resource] += 1;
          }
        }
        logEvent(state, { t: Date.now(), seat, kind: "BUILD_SETTLEMENT", data: { vertex: v, setup: true } });
        events.push({ kind: "BUILD_SETTLEMENT", seat, data: { vertex: v } });
        advanceSetup(state);
        return { events };
      }
      // обычная постройка
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      const v = action.vertex;
      if (!board.vertexNeighbors[v]) throw new IllegalActionError("unknown vertex");
      if (!distanceRuleOK(board, state, v)) throw new IllegalActionError("distance rule");
      if (!ownRoadTouchesVertex(board, state, seat, v)) throw new IllegalActionError("need own road");
      if (!hasResources(p, COST_SETTLEMENT)) throw new IllegalActionError("cannot afford");
      payResources(p, COST_SETTLEMENT);
      p.settlements.push(v);
      logEvent(state, { t: Date.now(), seat, kind: "BUILD_SETTLEMENT", data: { vertex: v } });
      events.push({ kind: "BUILD_SETTLEMENT", seat, data: { vertex: v } });
      // постройка settlement может разорвать чужую цепь
      recomputeLongestRoad(board, state);
      if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      return { events };
    }

    case "BUILD_CITY": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      const v = action.vertex;
      const idx = p.settlements.indexOf(v);
      if (idx < 0) throw new IllegalActionError("no settlement to upgrade");
      if (!hasResources(p, COST_CITY)) throw new IllegalActionError("cannot afford");
      payResources(p, COST_CITY);
      p.settlements.splice(idx, 1);
      p.cities.push(v);
      logEvent(state, { t: Date.now(), seat, kind: "BUILD_CITY", data: { vertex: v } });
      events.push({ kind: "BUILD_CITY", seat, data: { vertex: v } });
      if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      return { events };
    }

    case "BUILD_ROAD": {
      const e = action.edge;
      if (!board.edgeVertices[e]) throw new IllegalActionError("unknown edge");
      if (roadAt(state, e) !== null) throw new IllegalActionError("edge occupied");

      // SETUP road: должна быть инцидентна только что построенному поселению
      if (state.phase === "SETUP_R1_ROAD" || state.phase === "SETUP_R2_ROAD") {
        const p = state.players[seat]!;
        const lastSettle = p.settlements[p.settlements.length - 1];
        const [v1, v2] = board.edgeVertices[e]!;
        if (lastSettle !== v1 && lastSettle !== v2) {
          throw new IllegalActionError("setup road must touch last settlement");
        }
        p.roads.push(e);
        logEvent(state, { t: Date.now(), seat, kind: "BUILD_ROAD", data: { edge: e, setup: true } });
        events.push({ kind: "BUILD_ROAD", seat, data: { edge: e } });
        advanceSetup(state);
        return { events };
      }

      // Free road (Road Building / second setup-like)
      if (state.freeRoadsRemaining > 0) {
        if (!canBuildRoadAt(board, state, seat, e)) throw new IllegalActionError("road not connected");
        const p = state.players[seat]!;
        p.roads.push(e);
        state.freeRoadsRemaining -= 1;
        logEvent(state, { t: Date.now(), seat, kind: "BUILD_ROAD", data: { edge: e, free: true } });
        events.push({ kind: "BUILD_ROAD", seat, data: { edge: e } });
        if (state.freeRoadsRemaining > 0 && availableRoads(board, state, seat).length === 0) {
          state.freeRoadsRemaining = 0;
        }
        recomputeLongestRoad(board, state);
        if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
        return { events };
      }

      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      if (!hasResources(p, COST_ROAD)) throw new IllegalActionError("cannot afford");
      if (!canBuildRoadAt(board, state, seat, e)) throw new IllegalActionError("road not connected");
      payResources(p, COST_ROAD);
      p.roads.push(e);
      logEvent(state, { t: Date.now(), seat, kind: "BUILD_ROAD", data: { edge: e } });
      events.push({ kind: "BUILD_ROAD", seat, data: { edge: e } });
      recomputeLongestRoad(board, state);
      if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      return { events };
    }

    // ── MAIN ──────────────────────────────────────
    case "ROLL_DICE": {
      if (state.phase !== "MAIN_ROLL") throw new IllegalActionError("wrong phase");
      const d1 = 1 + Math.floor(rng() * 6);
      const d2 = 1 + Math.floor(rng() * 6);
      const sum = d1 + d2;
      state.dice = [d1, d2];
      state.lastRoll = sum;
      state.hasRolled = true;
      logEvent(state, { t: Date.now(), seat, kind: "ROLL", data: { d1, d2, sum } });
      events.push({ kind: "ROLL", seat, data: { d1, d2, sum } });
      if (sum === 7) {
        startDiscardPhase(state);
      } else {
        produceFromRoll(board, state, sum);
        state.phase = "MAIN_TURN";
      }
      return { events };
    }

    case "MOVE_ROBBER": {
      if (state.phase !== "MAIN_ROBBER") throw new IllegalActionError("wrong phase");
      const hid = action.toHex;
      if (!board.hexById[hid]) throw new IllegalActionError("unknown hex");
      if (hid === board.robberHex) throw new IllegalActionError("robber must move");
      board.robberHex = hid;
      logEvent(state, { t: Date.now(), seat, kind: "ROBBER_MOVED", data: { hex: hid } });
      events.push({ kind: "ROBBER_MOVED", seat, data: { hex: hid } });
      // Steal
      let victim = action.stealFrom;
      if (victim === null) {
        victim = pickRandomVictim(board, state, hid, seat, rng);
      } else {
        // проверим валидность
        const valid = (board.hexVertices[hid] ?? []).some((v) => {
          const occ = settlementAt(state, v);
          return occ && occ.seat === victim && bagTotal(state.players[victim]!.resources) > 0;
        });
        if (!valid) throw new IllegalActionError("invalid steal target");
      }
      if (victim !== null) {
        const res = stealOne(state, victim, seat, rng);
        if (res) {
          logEvent(state, { t: Date.now(), seat, kind: "STOLEN", data: { from: victim, resource: res } });
          events.push({ kind: "STOLEN", seat, data: { from: victim, resource: res } });
        }
      }
      state.phase = "MAIN_TURN";
      return { events };
    }

    case "BANK_TRADE": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      const ratio = bankRatio(board, state, seat, action.give);
      if ((p.resources[action.give] ?? 0) < ratio) throw new IllegalActionError("not enough");
      if (action.give === action.receive) throw new IllegalActionError("same resource");
      p.resources[action.give] -= ratio;
      p.resources[action.receive] += 1;
      logEvent(state, { t: Date.now(), seat, kind: "BANK_TRADE", data: { give: action.give, receive: action.receive, ratio } });
      events.push({ kind: "BANK_TRADE", seat, data: { give: action.give, receive: action.receive, ratio } });
      return { events };
    }

    case "OFFER_TRADE": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      if (!hasResources(p, action.give)) throw new IllegalActionError("cannot back offer");
      const id = `t${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const toSeats = action.to && action.to.length > 0
        ? action.to.filter((s) => s !== seat && s >= 0 && s < state.numPlayers)
        : state.players.map((pl) => pl.seat).filter((s) => s !== seat);
      const trade: PendingTrade = {
        id, fromSeat: seat,
        give: action.give, receive: action.receive,
        toSeats, acceptedBy: [],
      };
      state.pendingTrades.push(trade);
      logEvent(state, { t: Date.now(), seat, kind: "TRADE_OFFER", data: { id, give: action.give, receive: action.receive, to: toSeats } });
      events.push({ kind: "TRADE_OFFER", seat, data: { trade } });
      return { events };
    }

    case "CONFIRM_TRADE": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const tr = state.pendingTrades.find((t) => t.id === action.offerId);
      if (!tr) throw new IllegalActionError("no such trade");
      if (tr.fromSeat !== seat) throw new IllegalActionError("only proposer can confirm");
      if (!tr.acceptedBy.includes(action.withSeat)) throw new IllegalActionError("partner did not accept");
      const me = state.players[seat]!;
      const other = state.players[action.withSeat]!;
      if (!hasResources(me, tr.give as ResourceBag)) throw new IllegalActionError("proposer lacks");
      if (!hasResources(other, tr.receive as ResourceBag)) throw new IllegalActionError("partner lacks");
      payResources(me, tr.give as ResourceBag);
      gainResources(me, tr.receive as ResourceBag);
      payResources(other, tr.receive as ResourceBag);
      gainResources(other, tr.give as ResourceBag);
      state.pendingTrades = state.pendingTrades.filter((t) => t.id !== tr.id);
      logEvent(state, { t: Date.now(), seat, kind: "TRADE_CONFIRMED", data: { id: tr.id, with: action.withSeat } });
      events.push({ kind: "TRADE_CONFIRMED", seat, data: { id: tr.id, with: action.withSeat } });
      return { events };
    }

    case "CANCEL_TRADE": {
      state.pendingTrades = state.pendingTrades.filter((t) => t.id !== action.offerId);
      events.push({ kind: "TRADE_CANCELLED", seat, data: { id: action.offerId } });
      return { events };
    }

    case "BUY_DEV_CARD": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      const p = state.players[seat]!;
      if (!hasResources(p, COST_DEV)) throw new IllegalActionError("cannot afford");
      const totalLeft = Object.values(state.devDeck).reduce((a, b) => a + b, 0);
      if (totalLeft === 0) throw new IllegalActionError("dev deck empty");
      payResources(p, COST_DEV);
      // случайная карта пропорционально остатку
      const pick = Math.floor(rng() * totalLeft);
      let acc = 0;
      let drawn: DevCardType = "knight";
      for (const k of Object.keys(state.devDeck) as DevCardType[]) {
        acc += state.devDeck[k];
        if (pick < acc) { drawn = k; break; }
      }
      state.devDeck[drawn] -= 1;
      if (drawn === "vp") {
        p.victoryPointsHidden += 1;
        // VP карты считаются сразу в hidden VP, в руку не идут как «новая»
        if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      } else {
        p.newDevCards[drawn] += 1;
      }
      logEvent(state, { t: Date.now(), seat, kind: "BUY_DEV" });
      events.push({ kind: "BUY_DEV", seat, data: { /* приватно: card */ } });
      return { events };
    }

    case "PLAY_KNIGHT": {
      if (state.phase !== "MAIN_TURN" && state.phase !== "MAIN_ROLL") throw new IllegalActionError("wrong phase");
      if (state.hasPlayedDevCardThisTurn) throw new IllegalActionError("already played dev");
      const p = state.players[seat]!;
      if ((p.devCards.knight ?? 0) < 1) throw new IllegalActionError("no knight");
      p.devCards.knight -= 1;
      p.playedKnights += 1;
      state.hasPlayedDevCardThisTurn = true;
      logEvent(state, { t: Date.now(), seat, kind: "PLAY_DEV", data: { card: "knight" } });
      events.push({ kind: "PLAY_DEV", seat, data: { card: "knight" } });
      // двигаем разбойника
      if (action.toHex === board.robberHex) throw new IllegalActionError("must move robber");
      if (!board.hexById[action.toHex]) throw new IllegalActionError("unknown hex");
      board.robberHex = action.toHex;
      logEvent(state, { t: Date.now(), seat, kind: "ROBBER_MOVED", data: { hex: action.toHex } });
      events.push({ kind: "ROBBER_MOVED", seat, data: { hex: action.toHex } });
      let victim = action.stealFrom;
      if (victim === null) victim = pickRandomVictim(board, state, action.toHex, seat, rng);
      if (victim !== null) {
        const res = stealOne(state, victim, seat, rng);
        if (res) {
          logEvent(state, { t: Date.now(), seat, kind: "STOLEN", data: { from: victim, resource: res } });
          events.push({ kind: "STOLEN", seat, data: { from: victim, resource: res } });
        }
      }
      const armyEvent = recomputeLargestArmy(state);
      if (armyEvent) events.push(armyEvent);
      // если рыцарь сыгран до броска, фазу не меняем — игрок ещё должен бросить
      if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      return { events };
    }

    case "PLAY_ROAD_BUILDING": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      if (state.hasPlayedDevCardThisTurn) throw new IllegalActionError("already played dev");
      const p = state.players[seat]!;
      if ((p.devCards.road_building ?? 0) < 1) throw new IllegalActionError("no road building");
      p.devCards.road_building -= 1;
      state.hasPlayedDevCardThisTurn = true;
      logEvent(state, { t: Date.now(), seat, kind: "PLAY_DEV", data: { card: "road_building" } });
      events.push({ kind: "PLAY_DEV", seat, data: { card: "road_building" } });
      // Сразу строим до 2 бесплатных дорог через тот же путь
      state.freeRoadsRemaining = 2;
      for (const e of action.edges) {
        if (state.freeRoadsRemaining <= 0) break;
        if (roadAt(state, e) !== null) continue;
        if (!canBuildRoadAt(board, state, seat, e)) continue;
        p.roads.push(e);
        state.freeRoadsRemaining -= 1;
        events.push({ kind: "BUILD_ROAD", seat, data: { edge: e } });
      }
      if (state.freeRoadsRemaining > 0 && availableRoads(board, state, seat).length === 0) {
        state.freeRoadsRemaining = 0;
      }
      recomputeLongestRoad(board, state);
      if (checkWin(state, seat)) events.push({ kind: "GAME_OVER", seat });
      return { events };
    }

    case "PLAY_YEAR_OF_PLENTY": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      if (state.hasPlayedDevCardThisTurn) throw new IllegalActionError("already played dev");
      const p = state.players[seat]!;
      if ((p.devCards.year_of_plenty ?? 0) < 1) throw new IllegalActionError("no yop");
      p.devCards.year_of_plenty -= 1;
      state.hasPlayedDevCardThisTurn = true;
      for (const r of action.resources) p.resources[r] += 1;
      logEvent(state, { t: Date.now(), seat, kind: "PLAY_DEV", data: { card: "year_of_plenty", resources: action.resources } });
      events.push({ kind: "PLAY_DEV", seat, data: { card: "year_of_plenty" } });
      return { events };
    }

    case "PLAY_MONOPOLY": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      if (state.hasPlayedDevCardThisTurn) throw new IllegalActionError("already played dev");
      const p = state.players[seat]!;
      if ((p.devCards.monopoly ?? 0) < 1) throw new IllegalActionError("no monopoly");
      p.devCards.monopoly -= 1;
      state.hasPlayedDevCardThisTurn = true;
      let total = 0;
      for (const other of state.players) {
        if (other.seat === seat) continue;
        const have = other.resources[action.resource];
        if (have > 0) {
          other.resources[action.resource] = 0;
          total += have;
        }
      }
      p.resources[action.resource] += total;
      logEvent(state, { t: Date.now(), seat, kind: "PLAY_DEV", data: { card: "monopoly", resource: action.resource, total } });
      events.push({ kind: "PLAY_DEV", seat, data: { card: "monopoly", resource: action.resource, total } });
      return { events };
    }

    case "END_TURN": {
      if (state.phase !== "MAIN_TURN") throw new IllegalActionError("wrong phase");
      endTurn(state);
      events.push({ kind: "END_TURN", seat });
      return { events };
    }

    default:
      throw new IllegalActionError(`unhandled action ${(action as any).type}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Перечисление легальных ходов (для ботов и UI подсветки)
// ────────────────────────────────────────────────────────────────────────────

export function legalActions(board: Board, state: GameState, seat: number): CatanAction[] {
  const out: CatanAction[] = [];
  if (state.phase === "GAME_OVER") return out;

  // DISCARD (для всех, у кого есть долг)
  if (state.phase === "MAIN_DISCARD") {
    if ((state.mustDiscard[seat] ?? 0) > 0) {
      // не перечисляем все комбинации — бот выберет жадно
      out.push({ type: "DISCARD", resources: {} } as any);
    }
    return out;
  }

  if (seat !== state.currentSeat) return out;

  const p = state.players[seat]!;

  if (state.phase === "SETUP_R1_SETTLEMENT" || state.phase === "SETUP_R2_SETTLEMENT") {
    for (const v of board.vertices) {
      if (distanceRuleOK(board, state, v)) out.push({ type: "BUILD_SETTLEMENT", vertex: v });
    }
    return out;
  }
  if (state.phase === "SETUP_R1_ROAD" || state.phase === "SETUP_R2_ROAD") {
    const lastSettle = p.settlements[p.settlements.length - 1]!;
    for (const e of board.vertexEdges[lastSettle] ?? []) {
      if (roadAt(state, e) === null) out.push({ type: "BUILD_ROAD", edge: e });
    }
    return out;
  }

  if (state.phase === "MAIN_ROLL") {
    out.push({ type: "ROLL_DICE" });
    if (!state.hasPlayedDevCardThisTurn && (p.devCards.knight ?? 0) > 0) {
      for (const h of board.hexes) {
        const hid = `${h.q},${h.r}`;
        if (hid !== board.robberHex) {
          out.push({ type: "PLAY_KNIGHT", toHex: hid, stealFrom: null });
        }
      }
    }
    return out;
  }

  if (state.phase === "MAIN_ROBBER") {
    for (const h of board.hexes) {
      const hid = `${h.q},${h.r}`;
      if (hid !== board.robberHex) out.push({ type: "MOVE_ROBBER", toHex: hid, stealFrom: null });
    }
    return out;
  }

  if (state.phase === "MAIN_TURN") {
    // build settlement
    if (hasResources(p, COST_SETTLEMENT)) {
      for (const v of board.vertices) {
        if (distanceRuleOK(board, state, v) && ownRoadTouchesVertex(board, state, seat, v)) {
          out.push({ type: "BUILD_SETTLEMENT", vertex: v });
        }
      }
    }
    // build city
    if (hasResources(p, COST_CITY)) {
      for (const v of p.settlements) out.push({ type: "BUILD_CITY", vertex: v });
    }
    // build road. Road Building keeps the same BUILD_ROAD action surface,
    // but those roads are free while freeRoadsRemaining > 0.
    if (state.freeRoadsRemaining > 0 || hasResources(p, COST_ROAD)) {
      for (const e of availableRoads(board, state, seat)) out.push({ type: "BUILD_ROAD", edge: e });
    }
    // buy dev
    const devLeft = Object.values(state.devDeck).reduce((a, b) => a + b, 0);
    if (devLeft > 0 && hasResources(p, COST_DEV)) out.push({ type: "BUY_DEV_CARD" });
    // play dev (если ещё не играли)
    if (!state.hasPlayedDevCardThisTurn) {
      if ((p.devCards.knight ?? 0) > 0) {
        for (const h of board.hexes) {
          const hid = `${h.q},${h.r}`;
          if (hid !== board.robberHex) out.push({ type: "PLAY_KNIGHT", toHex: hid, stealFrom: null });
        }
      }
      if ((p.devCards.monopoly ?? 0) > 0) {
        for (const r of RESOURCES) out.push({ type: "PLAY_MONOPOLY", resource: r });
      }
      if ((p.devCards.year_of_plenty ?? 0) > 0) {
        for (const r1 of RESOURCES) for (const r2 of RESOURCES) {
          out.push({ type: "PLAY_YEAR_OF_PLENTY", resources: [r1, r2] });
        }
      }
      if ((p.devCards.road_building ?? 0) > 0) {
        // Без перечисления конкретных рёбер — бот подберёт
        out.push({ type: "PLAY_ROAD_BUILDING", edges: [] as any });
      }
    }
    // bank trade
    for (const give of RESOURCES) {
      const ratio = bankRatio(board, state, seat, give);
      if (p.resources[give] >= ratio) {
        for (const recv of RESOURCES) if (recv !== give) {
          out.push({ type: "BANK_TRADE", give, receive: recv });
        }
      }
    }
    // end turn
    out.push({ type: "END_TURN" });
  }
  return out;
}

// Хелпер — суммарные ресурсы оппонентов (для маскирования при отдаче клиенту)
export function publicPlayerView(p: PlayerState) {
  return {
    seat: p.seat,
    color: p.color,
    resourceCount: bagTotal(p.resources),
    devCardCount: Object.values(p.devCards).reduce((a, b) => a + b, 0) + Object.values(p.newDevCards).reduce((a, b) => a + b, 0),
    playedKnights: p.playedKnights,
    settlements: p.settlements,
    cities: p.cities,
    roads: p.roads,
    hasLongestRoad: p.hasLongestRoad,
    hasLargestArmy: p.hasLargestArmy,
    publicVP: p.settlements.length + p.cities.length * 2
      + (p.hasLongestRoad ? 2 : 0) + (p.hasLargestArmy ? 2 : 0),
  };
}

export { bagTotal };
