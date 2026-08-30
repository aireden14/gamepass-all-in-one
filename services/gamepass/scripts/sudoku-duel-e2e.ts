// Сквозной тест судоку-дуэли: живой socket.io и два клиента.
// Главное, что проверяем: оба получают ОДИН расклад, клетку забирает первый,
// решение наружу не уходит, промах морозит, обрыв связи держит место.

import { createServer } from "node:http";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { Server as IOServer } from "socket.io";
import { signToken, verifyToken } from "../src/utils/jwt";
import { registerSudokuDuelSocket } from "../src/socket/sudokuDuel";
import { CELLS, candidateCount, claimCell, createDuel, isValidSolution, validatePuzzle } from "../src/sudoku/duel";

const PORT = 4603;
const URL = `http://localhost:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (c: boolean, m: string) => { if (!c) throw new Error(m); };

/** Готовое решение 9×9 сдвигами — чтобы не тащить генератор на сервер. */
function makeSolution(): number[] {
  const base = (r: number, c: number) => ((r % 3) * 3 + Math.floor(r / 3) + c) % 9 + 1;
  const solution: number[] = [];
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) solution.push(base(r, c));
  return solution;
}

function makePuzzle(holes = 40) {
  const solution = makeSolution();
  const givens: Array<number | null> = [...solution];
  for (let i = 0; i < holes; i += 1) givens[i * 2 % CELLS] = null;
  return { givens, solution };
}

class Duelist {
  socket: ClientSocket;
  room: any = null;
  cells: any[] = [];
  errors: string[] = [];
  over: any = null;

  constructor(public userId: number, public name: string) {
    this.socket = connect(URL, {
      auth: { token: signToken({ userId, telegramId: String(userId) }) },
      transports: ["websocket"], forceNew: true,
    });
    this.socket.on("SD_STATE", ({ room }: any) => { this.room = room; });
    this.socket.on("SD_CELL", (p: any) => { this.cells.push(p); });
    this.socket.on("SD_OVER", (p: any) => { this.over = p; });
    this.socket.on("SD_ERROR", ({ message }: any) => { this.errors.push(message); });
  }
  ready(): Promise<void> {
    return new Promise((r) => this.socket.connected ? r() : this.socket.once("connect", () => r()));
  }
  claim(index: number, digit: number): Promise<any> {
    return new Promise((r) => this.socket.emit("SD_CLAIM", { index, digit }, r));
  }
}

function checkEngine(): void {
  const puzzle = makePuzzle();
  check(isValidSolution(puzzle.solution), "сгенерированное решение должно быть законным");
  check(validatePuzzle(puzzle) !== null, "честный расклад должен проходить проверку");

  const broken = { givens: [...puzzle.givens], solution: [...puzzle.solution] };
  broken.solution[5] = broken.solution[5] % 9 + 1;
  check(validatePuzzle(broken) === null, "битое решение обязано отбраковываться");

  const lying = { givens: [...puzzle.givens], solution: [...puzzle.solution] };
  const hole = lying.givens.findIndex((g) => g !== null);
  lying.givens[hole] = (lying.solution[hole] % 9) + 1;
  check(validatePuzzle(lying) === null, "подсказка, противоречащая решению, недопустима");
  check(validatePuzzle({ givens: puzzle.solution, solution: puzzle.solution }) === null, "полностью решённый расклад — не задача");

  // Цена клетки падает по мере заполнения соседей.
  const empty: Array<number | null> = Array.from({ length: CELLS }, () => null);
  check(candidateCount(empty, 0) === 9, "в пустой сетке в клетку влезают все девять цифр");
  empty[1] = 5; empty[2] = 6;
  check(candidateCount(empty, 0) === 7, "две занятые соседки убирают два варианта");
  console.log("duel engine: проверка расклада и цены клетки — ок");

  // Гонка: вторая попытка по той же клетке проигрывает, даже если цифра верная.
  const state = createDuel(puzzle, 1);
  state.players.push({ userId: 2, score: 0, cells: 0, mistakes: 0, frozenUntil: 0 });
  state.status = "playing";
  const target = state.entries.findIndex((v) => v === null);
  const first = claimCell(state, 1, target, puzzle.solution[target]);
  const second = claimCell(state, 2, target, puzzle.solution[target]);
  check(first.result === "taken", "первый должен забрать клетку");
  check(second.result === "blocked", "второму та же клетка недоступна");
  check(state.owners[target] === 1, "владелец — первый");
  console.log("duel engine: гонка за клетку — ок");
}

async function main(): Promise<void> {
  checkEngine();

  const httpServer = createServer();
  const io = new IOServer(httpServer, { cors: { origin: true } });
  io.use((socket, next) => {
    const payload = verifyToken(socket.handshake.auth?.token as string);
    if (!payload) return next(new Error("invalid token"));
    (socket.data as any) = { userId: payload.userId, telegramId: payload.telegramId };
    next();
  });
  registerSudokuDuelSocket(io);
  await new Promise<void>((r) => httpServer.listen(PORT, r));
  console.log(`сервер поднят на ${PORT}`);

  const puzzle = makePuzzle();
  const a = new Duelist(201, "Первый");
  const b = new Duelist(202, "Второй");
  await Promise.all([a.ready(), b.ready()]);

  // Кривой расклад сервер не принимает.
  const bad: any = await new Promise((r) => a.socket.emit("SD_CREATE", { puzzle: { givens: [1], solution: [1] } }, r));
  check(bad?.ok === false, "сервер не должен принимать мусор вместо расклада");

  const created: any = await new Promise((r) =>
    a.socket.emit("SD_CREATE", { puzzle, name: "Первый", password: "дуэль" }, r));
  check(created?.ok === true, `комната не создалась: ${created?.error}`);
  const code = created.room.code;
  check(created.room.solution === undefined, "решение не должно уходить клиенту");
  console.log("duel: комната создана, решение серверу — ок");

  const denied: any = await new Promise((r) => b.socket.emit("SD_JOIN", { code, name: "Второй" }, r));
  check(denied?.ok === false, "без пароля пускать нельзя");

  const joined: any = await new Promise((r) =>
    b.socket.emit("SD_JOIN", { code, name: "Второй", password: "дуэль" }, r));
  check(joined?.ok === true, "с паролем должен пускать");
  await wait(200);
  check(a.room.status === "playing", "после входа второго дуэль начинается");
  check(JSON.stringify(a.room.givens) === JSON.stringify(b.room.givens), "оба обязаны решать ОДИН расклад");
  check(b.room.solution === undefined, "решение не уходит и второму");
  console.log("duel: оба получили один расклад — ок");

  // Настоящая гонка через сокеты.
  const target = a.room.entries.findIndex((v: any) => v === null);
  const digit = puzzle.solution[target];
  const [ra, rb] = await Promise.all([a.claim(target, digit), b.claim(target, digit)]);
  const taken = [ra, rb].filter((x) => x.result === "taken");
  const blocked = [ra, rb].filter((x) => x.result === "blocked");
  check(taken.length === 1 && blocked.length === 1, `клетку должен получить ровно один: ${JSON.stringify([ra, rb])}`);
  await wait(200);
  check(a.room.entries[target] === digit, "цифра должна появиться на доске у обоих");
  check(a.cells.length === 1 && b.cells.length === 1, "событие о взятии видят оба");
  console.log("duel: гонка за клетку по сети — ок");

  // Промах морозит и не пишется в сетку.
  const free = a.room.entries.findIndex((v: any) => v === null);
  const wrong = (puzzle.solution[free] % 9) + 1;
  const miss = await a.claim(free, wrong);
  check(miss.result === "miss", "неверная цифра — промах");
  await wait(150);
  check(a.room.entries[free] === null, "промах не пишется в сетку");
  const blockedByFreeze = await a.claim(free, puzzle.solution[free]);
  check(blockedByFreeze.result === "blocked", "после промаха игрок заморожен");
  const rivalStillPlays = await b.claim(free, puzzle.solution[free]);
  check(rivalStillPlays.result === "taken", "заморозка касается только промахнувшегося");
  console.log("duel: промах, заморозка и её границы — ок");

  // Обрыв связи держит место, возврат отдаёт ту же доску.
  const filledBefore = a.room.entries.filter((v: any) => v !== null).length;
  b.socket.disconnect();
  await wait(300);
  const backB = new Duelist(202, "Второй");
  await backB.ready();
  const rejoined: any = await new Promise((r) =>
    backB.socket.emit("SD_JOIN", { code, name: "Второй", password: "дуэль" }, r));
  check(rejoined?.ok === true && rejoined.reconnected === true, "возврат в свою дуэль");
  check(backB.room.entries.filter((v: any) => v !== null).length === filledBefore, "доска после возврата та же");
  console.log("duel: обрыв связи и возврат — ок");

  // Соперник ушёл насовсем: сервер обязан сам сообщить, что дуэль окончена.
  if (Number(process.env.ROOM_GRACE_MS) > 0) {
    const grace = Number(process.env.ROOM_GRACE_MS);
    backB.socket.disconnect();
    await wait(grace + 400);
    check(a.room.status === "finished", "после ухода соперника дуэль должна закрыться");
    check(a.over !== null, "оставшийся игрок обязан получить SD_OVER, а не гадать");
    check(a.over.reason === "opponent_left", "в событии должна быть причина");
    console.log("duel: уход соперника закрывает дуэль и рассылается всем — ок");
  }

  [a, b, backB].forEach((c) => c.socket.close());
  io.close(); httpServer.close();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => { console.error("ПРОВАЛ:", e.message); process.exit(1); });
