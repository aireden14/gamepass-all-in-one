// Генератор стандартной доски Катана (19 гексов 3-4-5-4-3, токены, порты).
// Координаты hex'ов — axial (q, r). Вершины и рёбра кодируем как канонические строки.

import { Board, Hex, Port, PortKind, Resource, Terrain } from "./types";

// Стандартный набор гексов: 4 wood, 4 sheep, 4 wheat, 3 brick, 3 ore, 1 desert
const TERRAIN_BAG: Terrain[] = [
  "wood", "wood", "wood", "wood",
  "sheep", "sheep", "sheep", "sheep",
  "wheat", "wheat", "wheat", "wheat",
  "brick", "brick", "brick",
  "ore", "ore", "ore",
  "desert",
];

// Стандартный набор токенов на 18 не-пустынных гексах
const TOKEN_BAG: number[] = [
  2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12,
];

// 19 axial-координат стандартной доски (3-4-5-4-3 строки)
function standardHexCoords(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // r=-2: 3, r=-1: 4, r=0: 5, r=1: 4, r=2: 3
  const rows: Array<[number, number, number]> = [
    [-2, 0, 2],    // r, qmin, qmax
    [-1, -1, 2],
    [0, -2, 2],
    [1, -2, 1],
    [2, -2, 0],
  ];
  for (const [r, qmin, qmax] of rows) {
    for (let q = qmin; q <= qmax; q++) out.push([q, r]);
  }
  return out;
}

const HEX_ID = (q: number, r: number) => `${q},${r}`;

// 6 соседних гексов в axial-координатах
const HEX_DIRS: Array<[number, number]> = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];

// 6 вершин гекса — pointy-top axial. Canonical vertex ID:
// для каждого тройного стыка гексов берём min(id) трёх гексов + индекс вершины (N/S).
// Чтобы упростить — генерируем corners как тройки (set of 3 hex ids) → строка.
function cornersOfHex(q: number, r: number): Array<[[number, number], [number, number], [number, number]]> {
  // Для каждой из 6 вершин — три инцидентных гекса (включая сам).
  // Используем pairs соседних направлений.
  const corners: Array<[[number, number], [number, number], [number, number]]> = [];
  for (let i = 0; i < 6; i++) {
    const d1 = HEX_DIRS[i]!;
    const d2 = HEX_DIRS[(i + 1) % 6]!;
    corners.push([
      [q, r],
      [q + d1[0], r + d1[1]],
      [q + d2[0], r + d2[1]],
    ]);
  }
  return corners;
}

function vertexKey(triple: Array<[number, number]>): string {
  const ids = triple.map(([q, r]) => `${q},${r}`).sort();
  return `V|${ids.join("|")}`;
}

// Ребро — пара двух соседних гексов (или гекс + "void"). Чтобы canonical:
// определим ребро как пару двух гексов, отсортированных.
function edgesOfHex(q: number, r: number): Array<[[number, number], [number, number]]> {
  return HEX_DIRS.map((d) => [[q, r], [q + d[0], r + d[1]]]);
}

function edgeKey(pair: Array<[number, number]>): string {
  const ids = pair.map(([q, r]) => `${q},${r}`).sort();
  return `E|${ids[0]}|${ids[1]}`;
}

// Соседние вершины (через ребро) — две вершины принадлежат одному ребру, если
// пересечение их троек гексов имеет ровно два общих гекса.
// Проще: для каждого ребра (пары hex-ов A,B) две его вершины — corners(A) ∩ corners(B).

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function defaultRng(): () => number {
  return Math.random;
}

/** Раскладывает токены так, чтобы 6 и 8 не были соседями. */
function placeTokens(
  hexes: Hex[],
  hexById: Record<string, Hex>,
  rng: () => number,
): void {
  const nonDesert = hexes.filter((h) => h.terrain !== "desert");
  const neighbors = (h: Hex) =>
    HEX_DIRS
      .map(([dq, dr]) => hexById[HEX_ID(h.q + dq, h.r + dr)])
      .filter((x): x is Hex => !!x);

  for (let attempt = 0; attempt < 200; attempt++) {
    const tokens = shuffle(TOKEN_BAG, rng);
    nonDesert.forEach((h, i) => (h.token = tokens[i]!));
    let ok = true;
    for (const h of nonDesert) {
      if (h.token !== 6 && h.token !== 8) continue;
      for (const n of neighbors(h)) {
        if (n === h) continue;
        if (n.token === 6 || n.token === 8) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) return;
  }
  // fallback: оставляем как есть
}

// Стандартные порты — 9 штук вокруг внешнего периметра.
// Фиксируем координаты edge'ов от внешних гексов на "void"-соседей.
// Список из правил Катана (porty rotated for variety): 4 generic (3:1) + по 1 на каждый ресурс (2:1)
const PORT_KINDS: PortKind[] = ["any", "any", "any", "any", "wood", "brick", "sheep", "wheat", "ore"];

// Стандартные позиции портов: пары [hex_inside, hex_outside_void] на периметре
// (внешние гексы периметра + "виртуальные" соседи). Берём фиксированные позиции.
const PORT_EDGES: Array<[[number, number], [number, number]]> = [
  [[0, -2], [1, -3]],   // верх
  [[2, -2], [3, -3]],
  [[2, 0], [3, -1]],
  [[2, 1], [3, 0]],
  [[0, 2], [1, 1]],     // низ
  [[-2, 2], [-2, 3]],
  [[-2, 1], [-3, 2]],
  [[-2, -1], [-3, 0]],
  [[-1, -2], [-1, -3]],
];

export interface BoardOptions {
  rng?: () => number;
}

export function createBoard(opts: BoardOptions = {}): Board {
  const rng = opts.rng ?? defaultRng();
  const coords = standardHexCoords();
  const terrains = shuffle(TERRAIN_BAG, rng);

  const hexes: Hex[] = coords.map(([q, r], i) => ({
    q, r,
    terrain: terrains[i]!,
    token: null,
  }));
  const hexById: Record<string, Hex> = {};
  hexes.forEach((h) => (hexById[HEX_ID(h.q, h.r)] = h));

  placeTokens(hexes, hexById, rng);

  // Собираем вершины и рёбра по всем гексам, де-дуплицируем
  const vertexSet = new Set<string>();
  const edgeSet = new Set<string>();
  const hexVertices: Record<string, string[]> = {};
  const hexEdges: Record<string, string[]> = {};
  const vertexHexes: Record<string, Set<string>> = {};
  const edgeVertices: Record<string, [string, string]> = {};
  const vertexEdges: Record<string, Set<string>> = {};
  const vertexNeighbors: Record<string, Set<string>> = {};

  for (const h of hexes) {
    const hid = HEX_ID(h.q, h.r);
    const corners = cornersOfHex(h.q, h.r);
    const vs = corners.map((tr) => vertexKey(tr));
    hexVertices[hid] = vs;
    vs.forEach((v) => {
      vertexSet.add(v);
      if (!vertexHexes[v]) vertexHexes[v] = new Set();
      vertexHexes[v].add(hid);
    });

    const eds = edgesOfHex(h.q, h.r).map((pair) => edgeKey(pair));
    hexEdges[hid] = eds;
    eds.forEach((e) => edgeSet.add(e));

    // Edge i (между H и neighbor[i]) соединяет corner[i] и corner[(i-1+6)%6].
    // (corner[k] определён как стык H + neighbor[k] + neighbor[k+1]).
    for (let i = 0; i < 6; i++) {
      const v1 = vs[i]!;
      const v2 = vs[(i + 5) % 6]!;
      const e = eds[i]!;
      const prev = edgeVertices[e];
      if (!prev) edgeVertices[e] = [v1, v2];
      if (!vertexEdges[v1]) vertexEdges[v1] = new Set();
      if (!vertexEdges[v2]) vertexEdges[v2] = new Set();
      vertexEdges[v1].add(e);
      vertexEdges[v2].add(e);
      if (!vertexNeighbors[v1]) vertexNeighbors[v1] = new Set();
      if (!vertexNeighbors[v2]) vertexNeighbors[v2] = new Set();
      vertexNeighbors[v1].add(v2);
      vertexNeighbors[v2].add(v1);
    }
  }

  // Порты
  const portKinds = shuffle(PORT_KINDS, rng);
  const ports: Port[] = PORT_EDGES.map(([a, b], i) => {
    const e = edgeKey([a, b]);
    const ev = edgeVertices[e];
    // Если ребро не существовало в edgeSet (потому что внешний "void" гекс не порождал hex/edge напрямую),
    // нужно построить пару вершин вручную. Используем corners(a) ∩ corners(b).
    let vs2: [string, string];
    if (ev) {
      vs2 = ev;
    } else {
      const cornersA = cornersOfHex(a[0], a[1]).map(vertexKey);
      const cornersB = cornersOfHex(b[0], b[1]).map(vertexKey);
      const inter = cornersA.filter((v) => cornersB.includes(v));
      vs2 = [inter[0]!, inter[1]!];
    }
    return { edge: e, kind: portKinds[i]!, vertices: vs2 };
  });

  // Разбойник — на пустыне
  const desert = hexes.find((h) => h.terrain === "desert")!;
  const robberHex = HEX_ID(desert.q, desert.r);

  const toArr = <T,>(s: Record<string, Set<T>>): Record<string, T[]> => {
    const out: Record<string, T[]> = {};
    for (const k of Object.keys(s)) out[k] = Array.from(s[k]!);
    return out;
  };

  return {
    hexes,
    hexById,
    vertices: Array.from(vertexSet),
    edges: Array.from(edgeSet),
    vertexNeighbors: toArr(vertexNeighbors),
    vertexEdges: toArr(vertexEdges),
    edgeVertices,
    vertexHexes: toArr(vertexHexes),
    hexVertices,
    hexEdges,
    ports,
    robberHex,
  };
}

// Хелперы доступа
export const hexId = HEX_ID;
