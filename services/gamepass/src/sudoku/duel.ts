// Судоку-дуэль: два игрока на одной сетке, клетку забирает тот, кто первым
// поставил в неё верную цифру. Правила чистые, без сокетов.
//
// Решение хранится только здесь, на сервере: клиентам оно не уходит, иначе
// дуэль превращается в соревнование по чтению собственной памяти.

export const CELLS = 81;
export const FREEZE_MS = 3000;

export interface DuelPuzzle {
  givens: Array<number | null>;
  solution: number[];
}

export interface DuelPlayerState {
  userId: number;
  score: number;
  cells: number;
  mistakes: number;
  frozenUntil: number;
}

export interface DuelState {
  givens: Array<number | null>;
  solution: number[];
  entries: Array<number | null>;
  /** userId владельца клетки или null */
  owners: Array<number | null>;
  players: DuelPlayerState[];
  status: "waiting" | "playing" | "finished";
  startedAt: number | null;
}

/** Проверяем присланный расклад: сервер не верит клиенту на слово. */
export function validatePuzzle(raw: any): DuelPuzzle | null {
  if (!raw || !Array.isArray(raw.givens) || !Array.isArray(raw.solution)) return null;
  if (raw.givens.length !== CELLS || raw.solution.length !== CELLS) return null;

  const solution: number[] = [];
  for (const value of raw.solution) {
    const digit = Number(value);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
    solution.push(digit);
  }
  if (!isValidSolution(solution)) return null;

  const givens: Array<number | null> = [];
  for (let i = 0; i < CELLS; i += 1) {
    const value = raw.givens[i];
    if (value === null || value === undefined) { givens.push(null); continue; }
    const digit = Number(value);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
    if (digit !== solution[i]) return null;      // подсказка обязана совпадать с решением
    givens.push(digit);
  }
  if (givens.every((g) => g !== null)) return null; // решать нечего
  return { givens, solution };
}

/** Полное решение обязано быть законным судоку. */
export function isValidSolution(solution: number[]): boolean {
  const groups: number[][] = [];
  for (let r = 0; r < 9; r += 1) groups.push(Array.from({ length: 9 }, (_, c) => solution[r * 9 + c]));
  for (let c = 0; c < 9; c += 1) groups.push(Array.from({ length: 9 }, (_, r) => solution[r * 9 + c]));
  for (let b = 0; b < 9; b += 1) {
    const r0 = Math.floor(b / 3) * 3;
    const c0 = (b % 3) * 3;
    const box: number[] = [];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) box.push(solution[(r0 + r) * 9 + c0 + c]);
    groups.push(box);
  }
  return groups.every((group) => new Set(group).size === 9);
}

/** Сколько цифр вообще влезает в клетку — это и есть её цена. */
export function candidateCount(entries: Array<number | null>, index: number): number {
  if (entries[index] !== null) return 0;
  const row = Math.floor(index / 9);
  const col = index % 9;
  const used = new Set<number>();
  for (let c = 0; c < 9; c += 1) { const v = entries[row * 9 + c]; if (v) used.add(v); }
  for (let r = 0; r < 9; r += 1) { const v = entries[r * 9 + col]; if (v) used.add(v); }
  const r0 = Math.floor(row / 3) * 3;
  const c0 = Math.floor(col / 3) * 3;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = entries[(r0 + r) * 9 + c0 + c];
      if (v) used.add(v);
    }
  }
  return Math.max(1, 9 - used.size);
}

export function createDuel(puzzle: DuelPuzzle, hostId: number): DuelState {
  return {
    givens: [...puzzle.givens],
    solution: [...puzzle.solution],
    entries: [...puzzle.givens],
    owners: Array.from({ length: CELLS }, () => null),
    players: [makePlayer(hostId)],
    status: "waiting",
    startedAt: null,
  };
}

export function makePlayer(userId: number): DuelPlayerState {
  return { userId, score: 0, cells: 0, mistakes: 0, frozenUntil: 0 };
}

export type ClaimOutcome =
  | { result: "taken"; points: number; digit: number }
  | { result: "miss"; frozenUntil: number }
  | { result: "blocked"; reason: string };

/**
 * Попытка забрать клетку. Гонка решается здесь: кто пришёл вторым, получает
 * «занято», даже если цифра верная.
 */
export function claimCell(
  state: DuelState,
  userId: number,
  index: number,
  digit: number,
  now = Date.now(),
): ClaimOutcome {
  if (state.status !== "playing") return { result: "blocked", reason: "дуэль ещё не идёт" };
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { result: "blocked", reason: "не участник" };
  if (now < player.frozenUntil) return { result: "blocked", reason: "заморозка после промаха" };
  if (!Number.isInteger(index) || index < 0 || index >= CELLS) return { result: "blocked", reason: "нет такой клетки" };
  if (state.entries[index] !== null) return { result: "blocked", reason: "клетка уже занята" };
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return { result: "blocked", reason: "не цифра" };

  if (digit !== state.solution[index]) {
    player.mistakes += 1;
    player.frozenUntil = now + FREEZE_MS;
    return { result: "miss", frozenUntil: player.frozenUntil };
  }

  // Цену считаем до записи цифры, иначе клетка обесценится сама собой.
  const points = candidateCount(state.entries, index);
  state.entries[index] = digit;
  state.owners[index] = userId;
  player.score += points;
  player.cells += 1;
  if (state.entries.every((value) => value !== null)) state.status = "finished";
  return { result: "taken", points, digit };
}

/** Состояние для клиента: без решения, только то, что уже на доске. */
export function publicDuel(state: DuelState) {
  return {
    givens: state.givens,
    entries: state.entries,
    owners: state.owners,
    status: state.status,
    startedAt: state.startedAt,
    players: state.players.map((p) => ({
      userId: p.userId,
      score: p.score,
      cells: p.cells,
      mistakes: p.mistakes,
      frozenUntil: p.frozenUntil,
    })),
  };
}

export function duelWinner(state: DuelState): number | "draw" | null {
  if (state.status !== "finished") return null;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted.length < 2) return sorted[0]?.userId ?? null;
  if (sorted[0].score === sorted[1].score) return "draw";
  return sorted[0].userId;
}
