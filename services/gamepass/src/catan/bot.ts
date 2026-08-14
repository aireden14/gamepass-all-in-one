// Catan боты: easy / medium / hard. Используют legalActions + heuristics.

import {
  bagTotal, computeVictoryPoints, legalActions, publicPlayerView,
} from "./engine";
import {
  Board, CatanAction, DevCardType, GameState, Resource, RESOURCES,
} from "./types";

export type BotLevel = "easy" | "medium" | "hard";

const PIP: Record<number, number> = {
  2: 1, 12: 1, 3: 2, 11: 2, 4: 3, 10: 3, 5: 4, 9: 4, 6: 5, 8: 5,
};

function rand<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function vertexValue(board: Board, state: GameState, vertex: string): number {
  let v = 0;
  const seenRes = new Set<Resource>();
  for (const hid of board.vertexHexes[vertex] ?? []) {
    const h = board.hexById[hid]!;
    if (h.terrain === "desert") continue;
    const pip = h.token ? PIP[h.token] ?? 0 : 0;
    v += pip;
    seenRes.add(h.terrain as Resource);
  }
  v += seenRes.size; // diversity
  // Бонус если порт рядом
  for (const port of board.ports) {
    if (port.vertices.includes(vertex)) v += port.kind === "any" ? 1 : 2;
  }
  return v;
}

function chooseDiscard(state: GameState, seat: number, need: number): Partial<Record<Resource, number>> {
  // Сначала отдаём избытки наиболее многочисленных ресурсов
  const p = state.players[seat]!;
  const res: Partial<Record<Resource, number>> = {};
  const counts: Array<[Resource, number]> = RESOURCES.map((r) => [r, p.resources[r]]);
  counts.sort((a, b) => b[1] - a[1]);
  let remaining = need;
  for (const [r, c] of counts) {
    if (remaining <= 0) break;
    const take = Math.min(c, remaining);
    if (take > 0) {
      res[r] = take;
      remaining -= take;
    }
  }
  return res;
}

function pickRobberHex(board: Board, state: GameState, seat: number): { hex: string; victim: number | null } {
  // Цель — забрать у самого сильного оппонента; не блокировать себя.
  let best = { hex: "", score: -1, victim: null as number | null };
  const myVertices = new Set([...state.players[seat]!.settlements, ...state.players[seat]!.cities]);
  for (const h of board.hexes) {
    const hid = `${h.q},${h.r}`;
    if (hid === board.robberHex) continue;
    const occupants = new Map<number, number>(); // seat -> total resources
    let blocksSelf = false;
    let hasVictim = false;
    for (const v of board.hexVertices[hid] ?? []) {
      for (const p of state.players) {
        if (p.settlements.includes(v) || p.cities.includes(v)) {
          if (p.seat === seat) {
            blocksSelf = true;
          } else {
            const total = bagTotal(p.resources);
            occupants.set(p.seat, Math.max(occupants.get(p.seat) ?? 0, total));
            if (total > 0) hasVictim = true;
          }
        }
      }
    }
    if (blocksSelf) continue;
    let score = 0;
    let victim: number | null = null;
    let victimTotal = -1;
    for (const [s, total] of occupants) {
      const vp = computeVictoryPoints(state, s);
      score += vp * 2 + total;
      if (total > victimTotal) {
        victimTotal = total;
        victim = s;
      }
    }
    if (!hasVictim && occupants.size === 0) score = 0.1; // лучше пустой, чем свой
    if (score > best.score) best = { hex: hid, score, victim };
  }
  if (!best.hex) {
    // fallback: любой не-текущий гекс
    for (const h of board.hexes) {
      const hid = `${h.q},${h.r}`;
      if (hid !== board.robberHex) return { hex: hid, victim: null };
    }
  }
  return { hex: best.hex, victim: best.victim };
}

/** Возвращает следующее действие бота. Если нужно сложное решение (где взять ход) — вычисляет сам. */
export function decideBotAction(
  board: Board,
  state: GameState,
  seat: number,
  level: BotLevel,
  rng: () => number = Math.random,
): CatanAction {
  // 1) Discard phase — независимо от currentSeat
  if (state.phase === "MAIN_DISCARD" && (state.mustDiscard[seat] ?? 0) > 0) {
    const need = state.mustDiscard[seat]!;
    return { type: "DISCARD", resources: chooseDiscard(state, seat, need) };
  }

  // 2) Robber
  if (state.phase === "MAIN_ROBBER" && state.currentSeat === seat) {
    if (level === "easy") {
      const candidates = board.hexes
        .map((h) => `${h.q},${h.r}`)
        .filter((hid) => hid !== board.robberHex);
      return { type: "MOVE_ROBBER", toHex: rand(candidates, rng), stealFrom: null };
    }
    const pick = pickRobberHex(board, state, seat);
    return { type: "MOVE_ROBBER", toHex: pick.hex, stealFrom: pick.victim };
  }

  // 3) SETUP_SETTLEMENT — выбираем лучшую вершину
  if (state.phase === "SETUP_R1_SETTLEMENT" || state.phase === "SETUP_R2_SETTLEMENT") {
    const acts = legalActions(board, state, seat);
    const settles = acts.filter((a) => a.type === "BUILD_SETTLEMENT") as Extract<CatanAction, { type: "BUILD_SETTLEMENT" }>[];
    if (settles.length === 0) throw new Error("no setup settlement available");
    if (level === "easy") return rand(settles, rng);
    let best = settles[0]!;
    let bestScore = -1;
    for (const s of settles) {
      const sc = vertexValue(board, state, s.vertex);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return best;
  }

  // 4) SETUP_ROAD — направим к лучшей соседней вершине
  if (state.phase === "SETUP_R1_ROAD" || state.phase === "SETUP_R2_ROAD") {
    const acts = legalActions(board, state, seat).filter((a) => a.type === "BUILD_ROAD") as Extract<CatanAction, { type: "BUILD_ROAD" }>[];
    if (acts.length === 0) throw new Error("no setup road available");
    if (level === "easy") return rand(acts, rng);
    const p = state.players[seat]!;
    const lastSettle = p.settlements[p.settlements.length - 1]!;
    let best = acts[0]!;
    let bestScore = -1;
    for (const a of acts) {
      const [v1, v2] = board.edgeVertices[a.edge]!;
      const other = v1 === lastSettle ? v2 : v1;
      const sc = vertexValue(board, state, other);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    return best;
  }

  // 5) MAIN_ROLL — бросаем (рыцарь до броска — опционально для hard)
  if (state.phase === "MAIN_ROLL" && state.currentSeat === seat) {
    if (level === "hard" && !state.hasPlayedDevCardThisTurn && (state.players[seat]!.devCards.knight ?? 0) > 0) {
      // если разбойник стоит на нашем гексе — играем рыцаря заранее
      const myHexes = new Set<string>();
      const p = state.players[seat]!;
      for (const v of [...p.settlements, ...p.cities]) {
        for (const hid of board.vertexHexes[v] ?? []) myHexes.add(hid);
      }
      if (myHexes.has(board.robberHex)) {
        const pick = pickRobberHex(board, state, seat);
        return { type: "PLAY_KNIGHT", toHex: pick.hex, stealFrom: pick.victim };
      }
    }
    return { type: "ROLL_DICE" };
  }

  // 6) MAIN_TURN
  if (state.phase === "MAIN_TURN" && state.currentSeat === seat) {
    return chooseMainTurn(board, state, seat, level, rng);
  }

  // fallback
  return { type: "END_TURN" };
}

function chooseMainTurn(board: Board, state: GameState, seat: number, level: BotLevel, rng: () => number): CatanAction {
  const p = state.players[seat]!;
  const acts = legalActions(board, state, seat);

  // Priorities: build city > build settlement > buy dev (если ≥7VP) > build road (longest road если близко) > trade

  const cities = acts.filter((a) => a.type === "BUILD_CITY") as Extract<CatanAction, { type: "BUILD_CITY" }>[];
  if (cities.length > 0) return rand(cities, rng);

  if (level === "hard" && !state.hasPlayedDevCardThisTurn) {
    const tactical = pickTacticalDevCard(board, state, seat);
    if (tactical) return tactical;
  }

  const settles = acts.filter((a) => a.type === "BUILD_SETTLEMENT") as Extract<CatanAction, { type: "BUILD_SETTLEMENT" }>[];
  if (settles.length > 0) {
    if (level === "easy") return rand(settles, rng);
    let best = settles[0]!; let bs = -1;
    for (const s of settles) {
      const v = vertexValue(board, state, s.vertex);
      if (v > bs) { bs = v; best = s; }
    }
    return best;
  }

  // Play dev cards (medium/hard)
  if (level !== "easy" && !state.hasPlayedDevCardThisTurn) {
    if ((p.devCards.monopoly ?? 0) > 0) {
      // монополия выгодна, если у оппонентов суммарно ≥3 этого ресурса
      let best: Resource | null = null; let bestTotal = 2;
      for (const r of RESOURCES) {
        let t = 0;
        for (const other of state.players) if (other.seat !== seat) t += other.resources[r];
        if (t > bestTotal) { bestTotal = t; best = r; }
      }
      if (best) return { type: "PLAY_MONOPOLY", resource: best };
    }
    if ((p.devCards.year_of_plenty ?? 0) > 0) {
      // тянем недостающие до settlement/city
      const need = needForNextBuild(p);
      const picks: Resource[] = [];
      for (const r of RESOURCES) {
        const lack = (need[r] ?? 0) - (p.resources[r] ?? 0);
        for (let i = 0; i < Math.min(lack, 2 - picks.length); i++) picks.push(r);
        if (picks.length >= 2) break;
      }
      while (picks.length < 2) picks.push("wheat");
      return { type: "PLAY_YEAR_OF_PLENTY", resources: [picks[0]!, picks[1]!] };
    }
    if ((p.devCards.road_building ?? 0) > 0) {
      const edges = pickTwoRoadsForRoadBuilding(board, state, seat);
      if (edges.length > 0) return { type: "PLAY_ROAD_BUILDING", edges: edges as any };
    }
    if ((p.devCards.knight ?? 0) > 0) {
      const pick = pickRobberHex(board, state, seat);
      return { type: "PLAY_KNIGHT", toHex: pick.hex, stealFrom: pick.victim };
    }
  }

  // Buy dev card
  const devLeft = Object.values(state.devDeck).reduce((a, b) => a + b, 0);
  if (devLeft > 0 && hasFor(p, "dev")) {
    return { type: "BUY_DEV_CARD" };
  }

  // Build road (если близко к longest road или есть ресурсы и место)
  const roads = acts.filter((a) => a.type === "BUILD_ROAD") as Extract<CatanAction, { type: "BUILD_ROAD" }>[];
  if (roads.length > 0 && p.roads.length < 13 && level !== "easy") {
    // Стройка к ближайшей перспективной вершине
    let best = roads[0]!; let bs = -1;
    for (const r of roads) {
      const [v1, v2] = board.edgeVertices[r.edge]!;
      const score = Math.max(vertexValue(board, state, v1), vertexValue(board, state, v2));
      if (score > bs) { bs = score; best = r; }
    }
    if (bs >= 5) return best;
  } else if (roads.length > 0 && level === "easy" && rng() < 0.3) {
    return rand(roads, rng);
  }

  // Bank trade — если близко к постройке
  const tradeAct = pickBankTrade(board, state, seat);
  if (tradeAct) return tradeAct;

  return { type: "END_TURN" };
}

function pickTacticalDevCard(board: Board, state: GameState, seat: number): CatanAction | null {
  const p = state.players[seat]!;

  if ((p.devCards.road_building ?? 0) > 0 && !p.hasLongestRoad) {
    const edges = pickTwoRoadsForRoadBuilding(board, state, seat);
    if (edges.length > 0 && (p.roads.length >= 3 || state.longestRoadOwner !== seat)) {
      return { type: "PLAY_ROAD_BUILDING", edges: edges as any };
    }
  }

  if ((p.devCards.knight ?? 0) > 0) {
    const canClaimArmy = !p.hasLargestArmy && p.playedKnights >= 2;
    const leaderSeat = state.players
      .filter((other) => other.seat !== seat)
      .sort((a, b) => computeVictoryPoints(state, b.seat) - computeVictoryPoints(state, a.seat))[0]?.seat;
    const leaderHasCards = typeof leaderSeat === "number" && bagTotal(state.players[leaderSeat]!.resources) >= 5;
    if (canClaimArmy || leaderHasCards) {
      const pick = pickRobberHex(board, state, seat);
      return { type: "PLAY_KNIGHT", toHex: pick.hex, stealFrom: pick.victim };
    }
  }

  if ((p.devCards.monopoly ?? 0) > 0) {
    let best: Resource | null = null;
    let bestTotal = 3;
    for (const r of RESOURCES) {
      let total = 0;
      for (const other of state.players) if (other.seat !== seat) total += other.resources[r];
      if (total > bestTotal) { bestTotal = total; best = r; }
    }
    if (best) return { type: "PLAY_MONOPOLY", resource: best };
  }

  return null;
}

function pickTwoRoadsForRoadBuilding(board: Board, state: GameState, seat: number): string[] {
  const p = state.players[seat]!;
  // Соберём кандидатов жадно
  const built: string[] = [];
  const tempRoads = new Set(p.roads);
  function canHere(edge: string): boolean {
    if (tempRoads.has(edge)) return false;
    for (const otherP of state.players) {
      if (otherP.seat !== seat && otherP.roads.includes(edge)) return false;
    }
    const [v1, v2] = board.edgeVertices[edge]!;
    for (const v of [v1, v2]) {
      const occ = state.players.find((pl) => pl.settlements.includes(v) || pl.cities.includes(v));
      if (occ && occ.seat !== seat) continue;
      if (p.settlements.includes(v) || p.cities.includes(v)) return true;
      for (const e2 of board.vertexEdges[v] ?? []) {
        if (tempRoads.has(e2)) return true;
      }
    }
    return false;
  }
  for (let step = 0; step < 2; step++) {
    let pick: string | null = null; let bs = -1;
    for (const e of board.edges) {
      if (!canHere(e)) continue;
      const [v1, v2] = board.edgeVertices[e]!;
      const sc = Math.max(vertexValue(board, state, v1), vertexValue(board, state, v2));
      if (sc > bs) { bs = sc; pick = e; }
    }
    if (!pick) break;
    built.push(pick);
    tempRoads.add(pick);
  }
  return built;
}

function hasFor(p: { resources: Record<Resource, number> }, what: "dev" | "settle" | "city" | "road"): boolean {
  switch (what) {
    case "dev": return p.resources.sheep >= 1 && p.resources.wheat >= 1 && p.resources.ore >= 1;
    case "settle": return p.resources.brick >= 1 && p.resources.wood >= 1 && p.resources.sheep >= 1 && p.resources.wheat >= 1;
    case "city": return p.resources.ore >= 3 && p.resources.wheat >= 2;
    case "road": return p.resources.brick >= 1 && p.resources.wood >= 1;
  }
}

function needForNextBuild(p: { resources: Record<Resource, number> }): Partial<Record<Resource, number>> {
  const targets: Array<[string, Partial<Record<Resource, number>>]> = [
    ["city", { ore: 3, wheat: 2 }],
    ["settle", { brick: 1, wood: 1, sheep: 1, wheat: 1 }],
    ["road", { brick: 1, wood: 1 }],
    ["dev", { sheep: 1, wheat: 1, ore: 1 }],
  ];
  for (const [, cost] of targets) {
    let missing = 0;
    for (const r of RESOURCES) {
      const lack = (cost[r] ?? 0) - p.resources[r];
      if (lack > 0) missing += lack;
    }
    if (missing > 0 && missing <= 3) return cost;
  }
  return targets[1]![1]!;
}

function pickBankTrade(board: Board, state: GameState, seat: number): CatanAction | null {
  const p = state.players[seat]!;
  // Хотим что-то построить — если не хватает 1 ресурса, и есть избыток другого по курсу.
  const wantList = [
    { name: "city", cost: { ore: 3, wheat: 2 } as Record<Resource, number> },
    { name: "settle", cost: { brick: 1, wood: 1, sheep: 1, wheat: 1 } as Record<Resource, number> },
    { name: "road", cost: { brick: 1, wood: 1 } as Record<Resource, number> },
    { name: "dev", cost: { sheep: 1, wheat: 1, ore: 1 } as Record<Resource, number> },
  ];
  for (const w of wantList) {
    const lack: Resource[] = [];
    for (const r of RESOURCES) {
      const need = w.cost[r] ?? 0;
      const have = p.resources[r];
      for (let i = 0; i < need - have; i++) lack.push(r);
    }
    if (lack.length !== 1) continue;
    const needRes = lack[0]!;
    // Ищем ресурс, которого у нас «лишнего» по курсу
    for (const give of RESOURCES) {
      if (give === needRes) continue;
      const ratio = bankRatioInline(board, state, seat, give);
      const need = w.cost[give] ?? 0;
      if (p.resources[give] >= need + ratio) {
        return { type: "BANK_TRADE", give, receive: needRes };
      }
    }
  }
  return null;
}

function bankRatioInline(board: Board, state: GameState, seat: number, give: Resource): 2 | 3 | 4 {
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

// Эти экспорт нужен для прохода тестов — переиспользует publicPlayerView
export { publicPlayerView };
