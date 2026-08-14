// Стандартный Elo, K=32
export function computeElo(
  ratingA: number,
  ratingB: number,
  scoreA: 0 | 0.5 | 1,
  K = 32,
): { newA: number; newB: number; deltaA: number; deltaB: number } {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = (1 - scoreA) as 0 | 0.5 | 1;
  const deltaA = Math.round(K * (scoreA - expectedA));
  const deltaB = Math.round(K * (scoreB - expectedB));
  const newA = Math.max(100, ratingA + deltaA);
  const newB = Math.max(100, ratingB + deltaB);
  return { newA, newB, deltaA, deltaB };
}
