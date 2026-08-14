import { Chess, Move } from "chess.js";

const PIECE_VALUE: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

function evaluate(chess: Chess): number {
  // Положительная оценка — для белых
  if (chess.isCheckmate()) return chess.turn() === "w" ? -100000 : 100000;
  if (chess.isDraw() || chess.isStalemate()) return 0;
  let score = 0;
  const board = chess.board();
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUE[sq.type] ?? 0;
      score += sq.color === "w" ? v : -v;
    }
  }
  return score;
}

function minimax(
  chess: Chess,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
): number {
  if (depth === 0 || chess.isGameOver()) return evaluate(chess);
  const moves = chess.moves({ verbose: true }) as Move[];
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      const score = minimax(chess, depth - 1, alpha, beta, false);
      chess.undo();
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      chess.move(m);
      const score = minimax(chess, depth - 1, alpha, beta, true);
      chess.undo();
      best = Math.min(best, score);
      beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
    return best;
  }
}

/**
 * Возвращает ход для бота.
 *  easy   — случайный (с лёгким уклоном в "взять что-то крупное" — 30% берём максимально ценный)
 *  medium — minimax depth 2 (alpha-beta) + случайность среди топ-ходов
 */
export function pickBotMove(
  fen: string,
  difficulty: "easy" | "medium",
): { from: string; to: string; promotion?: string } | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true }) as Move[];
  if (moves.length === 0) return null;

  if (difficulty === "easy") {
    // 30% — лучший по захвату, 70% — случайный
    if (Math.random() < 0.3) {
      const captures = moves.filter((m) => m.captured);
      if (captures.length > 0) {
        captures.sort(
          (a, b) => (PIECE_VALUE[b.captured!] ?? 0) - (PIECE_VALUE[a.captured!] ?? 0),
        );
        const m = captures[0];
        return { from: m.from, to: m.to, promotion: m.promotion };
      }
    }
    const m = moves[Math.floor(Math.random() * moves.length)];
    return { from: m.from, to: m.to, promotion: m.promotion };
  }

  // medium: minimax depth 2
  const isWhite = chess.turn() === "w";
  let bestScore = isWhite ? -Infinity : Infinity;
  const scored: { m: Move; s: number }[] = [];
  for (const m of moves) {
    chess.move(m);
    const s = minimax(chess, 2, -Infinity, Infinity, !isWhite);
    chess.undo();
    scored.push({ m, s });
    if (isWhite ? s > bestScore : s < bestScore) bestScore = s;
  }
  // top-3 в пределах 30 очков
  const top = scored
    .filter((x) => Math.abs(x.s - bestScore) <= 30)
    .map((x) => x.m);
  const choice = top[Math.floor(Math.random() * top.length)] ?? scored[0].m;
  return { from: choice.from, to: choice.to, promotion: choice.promotion };
}
