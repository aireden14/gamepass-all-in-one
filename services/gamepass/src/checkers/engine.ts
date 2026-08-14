export type Color = "w" | "b";

export interface Piece {
  color: Color;
  king: boolean;
}

export type Board = (Piece | null)[];

export interface Capture {
  to: number;
  captured: number;
}

export interface Move {
  from: number;
  to: number;
  captured: number | null;
}

const SIZE = 8;
const DIRS: Array<[number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

export const idx = (r: number, c: number) => r * SIZE + c;
export const rc = (i: number) => [Math.floor(i / SIZE), i % SIZE] as const;
export const isDark = (r: number, c: number) => (r + c) % 2 === 1;
const inBoard = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

export function initialBoard(): Board {
  const board: Board = Array(64).fill(null);
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (!isDark(r, c)) continue;
      if (r < 3) board[idx(r, c)] = { color: "b", king: false };
      if (r > 4) board[idx(r, c)] = { color: "w", king: false };
    }
  }
  return board;
}

export function cloneBoard(board: Board): Board {
  return board.map((piece) => (piece ? { ...piece } : null));
}

export function pieceCaptures(board: Board, i: number): Capture[] {
  const piece = board[i];
  if (!piece) return [];
  const [r, c] = rc(i);
  const out: Capture[] = [];

  if (!piece.king) {
    for (const [dr, dc] of DIRS) {
      const er = r + dr;
      const ec = c + dc;
      const lr = r + 2 * dr;
      const lc = c + 2 * dc;
      if (!inBoard(lr, lc)) continue;
      const mid = board[idx(er, ec)];
      if (mid && mid.color !== piece.color && !board[idx(lr, lc)]) {
        out.push({ to: idx(lr, lc), captured: idx(er, ec) });
      }
    }
    return out;
  }

  for (const [dr, dc] of DIRS) {
    let rr = r + dr;
    let cc = c + dc;
    while (inBoard(rr, cc) && !board[idx(rr, cc)]) {
      rr += dr;
      cc += dc;
    }
    if (!inBoard(rr, cc)) continue;
    const mid = board[idx(rr, cc)];
    if (!mid || mid.color === piece.color) continue;
    const captured = idx(rr, cc);
    let lr = rr + dr;
    let lc = cc + dc;
    while (inBoard(lr, lc) && !board[idx(lr, lc)]) {
      out.push({ to: idx(lr, lc), captured });
      lr += dr;
      lc += dc;
    }
  }

  return out;
}

export function pieceSimpleMoves(board: Board, i: number): number[] {
  const piece = board[i];
  if (!piece) return [];
  const [r, c] = rc(i);
  const out: number[] = [];

  if (!piece.king) {
    const forward = piece.color === "w" ? -1 : 1;
    for (const dc of [-1, 1]) {
      const nr = r + forward;
      const nc = c + dc;
      if (inBoard(nr, nc) && !board[idx(nr, nc)]) out.push(idx(nr, nc));
    }
    return out;
  }

  for (const [dr, dc] of DIRS) {
    let rr = r + dr;
    let cc = c + dc;
    while (inBoard(rr, cc) && !board[idx(rr, cc)]) {
      out.push(idx(rr, cc));
      rr += dr;
      cc += dc;
    }
  }

  return out;
}

export function hasAnyCapture(board: Board, color: Color): boolean {
  for (let i = 0; i < 64; i += 1) {
    if (board[i]?.color === color && pieceCaptures(board, i).length) return true;
  }
  return false;
}

export function hasAnyMove(board: Board, color: Color): boolean {
  if (hasAnyCapture(board, color)) return true;
  for (let i = 0; i < 64; i += 1) {
    if (board[i]?.color === color && pieceSimpleMoves(board, i).length) return true;
  }
  return false;
}

export function allLegalMoves(board: Board, color: Color): Move[] {
  const out: Move[] = [];
  const mustCapture = hasAnyCapture(board, color);
  for (let i = 0; i < 64; i += 1) {
    if (board[i]?.color !== color) continue;
    const captures = pieceCaptures(board, i);
    if (mustCapture) {
      captures.forEach((capture) => out.push({ from: i, to: capture.to, captured: capture.captured }));
    } else {
      pieceSimpleMoves(board, i).forEach((to) => out.push({ from: i, to, captured: null }));
    }
  }
  return out;
}

function promote(board: Board, i: number): void {
  const piece = board[i];
  if (!piece || piece.king) return;
  const [r] = rc(i);
  if ((piece.color === "w" && r === 0) || (piece.color === "b" && r === SIZE - 1)) {
    piece.king = true;
  }
}

export function applyMove(
  board: Board,
  from: number,
  to: number,
  captured: number | null,
): { board: Board; mustContinue: boolean; end: number } {
  const next = cloneBoard(board);
  const piece = next[from];
  if (!piece) throw new Error("no piece");
  next[to] = piece;
  next[from] = null;
  if (captured !== null) next[captured] = null;
  promote(next, to);
  return {
    board: next,
    mustContinue: captured !== null && pieceCaptures(next, to).length > 0,
    end: to,
  };
}
