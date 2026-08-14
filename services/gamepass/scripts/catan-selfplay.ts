// Прогоняет полную партию 4 ботами в чистом движке, без БД и сокетов.
// Используется как smoke-тест: должна завершиться победителем за разумное число ходов.

import { applyAction, createInitialState } from "../src/catan/engine";
import { decideBotAction, BotLevel } from "../src/catan/bot";

function run(level: BotLevel, seed?: number): { winnerSeat: number | null; turns: number; vp: number[]; lastPhase: string } {
  // Простой seedable RNG
  let s = (seed ?? Math.floor(Math.random() * 1e9)) >>> 0;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };

  const { board, state } = createInitialState({ numPlayers: 4, rng });
  let turns = 0;
  const maxTurns = 5000;

  while (state.phase !== "GAME_OVER" && turns < maxTurns) {
    // Discard от не-текущих
    if (state.phase === "MAIN_DISCARD") {
      let did = false;
      for (const seat of Object.keys(state.mustDiscard).map(Number)) {
        if ((state.mustDiscard[seat] ?? 0) <= 0) continue;
        const action = decideBotAction(board, state, seat, level, rng);
        applyAction(board, state, seat, action, { rng });
        did = true;
        break;
      }
      if (!did) {
        // никого не осталось — phase должен был смениться
        break;
      }
      turns++;
      continue;
    }
    const cur = state.currentSeat;
    const action = decideBotAction(board, state, cur, level, rng);
    try {
      applyAction(board, state, cur, action, { rng });
    } catch (e: any) {
      console.error("Bot illegal action:", action, "phase:", state.phase, "msg:", e.message);
      throw e;
    }
    turns++;
  }
  const vp = state.players.map((p) => {
    return p.settlements.length + p.cities.length * 2
      + (p.hasLongestRoad ? 2 : 0) + (p.hasLargestArmy ? 2 : 0) + p.victoryPointsHidden;
  });
  return { winnerSeat: state.winnerSeat, turns, vp, lastPhase: state.phase };
}

const level = (process.argv[2] as BotLevel) || "medium";
const games = Number(process.argv[3] || 3);

let wins = 0;
for (let i = 0; i < games; i++) {
  const r = run(level, 12345 + i * 1000);
  console.log(`[${i + 1}/${games}] level=${level} winnerSeat=${r.winnerSeat} turns=${r.turns} phase=${r.lastPhase} vp=${JSON.stringify(r.vp)}`);
  if (r.winnerSeat !== null) wins++;
}
console.log(`Done. ${wins}/${games} games reached a winner.`);
process.exit(wins === games ? 0 : 1);
