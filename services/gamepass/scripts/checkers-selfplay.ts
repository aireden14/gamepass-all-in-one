// Хедлесс-смоук шашек: партии бот-против-бота в чистом движке + проверки ядра комнат.
// Ловит зависшие партии, невалидные ходы и поломки удержания места при обрыве связи.

import { Board, Color, allLegalMoves, applyMove, hasAnyMove, initialBoard } from "../src/checkers/engine";
import { RoomRegistry } from "../src/multiplayer/rooms";

const other = (c: Color): Color => (c === "w" ? "b" : "w");

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface GameResult {
  winner: Color | "draw";
  plies: number;
}

function playGame(seed: number, maxPlies = 400): GameResult {
  const rng = makeRng(seed);
  let board: Board = initialBoard();
  let turn: Color = "w";
  let chainFrom: number | null = null;
  let plies = 0;

  while (plies < maxPlies) {
    if (!hasAnyMove(board, turn)) return { winner: other(turn), plies };

    let moves = allLegalMoves(board, turn);
    if (chainFrom !== null) moves = moves.filter((m) => m.from === chainFrom);
    if (moves.length === 0) throw new Error(`нет ходов при незакрытой цепочке: seed=${seed} ply=${plies}`);

    // Предпочитаем взятия — иначе боты топчутся и партия не заканчивается.
    const captures = moves.filter((m) => m.captured !== null);
    const pool = captures.length > 0 ? captures : moves;
    const move = pool[Math.floor(rng() * pool.length)];

    const before = board.filter(Boolean).length;
    const result = applyMove(board, move.from, move.to, move.captured);
    const after = result.board.filter(Boolean).length;
    if (move.captured !== null && after !== before - 1) {
      throw new Error(`взятие не сняло шашку: seed=${seed} ply=${plies}`);
    }
    if (move.captured === null && after !== before) {
      throw new Error(`тихий ход изменил число шашек: seed=${seed} ply=${plies}`);
    }

    board = result.board;
    if (result.mustContinue) {
      chainFrom = result.end;
    } else {
      chainFrom = null;
      turn = other(turn);
    }
    plies += 1;
  }
  return { winner: "draw", plies };
}

// --- Проверки ядра комнат -------------------------------------------------

type FakeSocket = { id: string; join: (room: string) => void };
const fakeSocket = (id: string): FakeSocket => ({ id, join: () => {} });
const fakeIo = { to: () => ({ emit: () => {} }) };

function checkRoomCore(): void {
  const abandoned: string[] = [];
  const registry = new RoomRegistry<{ n: number }>({
    channel: "test",
    idPrefix: "TT",
    seatOrder: ["w", "b"],
    graceMs: 40,
    onSeatAbandoned: (_room, seat) => abandoned.push(seat),
  });

  const room = registry.create(1, { n: 0 });
  registry.join(room.id, 1, fakeSocket("s1") as any);
  const joined = registry.join(room.id, 2, fakeSocket("s2") as any);
  if (joined?.seat !== "b") throw new Error("второй игрок должен сесть на место b");
  if (joined?.reconnected) throw new Error("первый вход не должен считаться возвратом");

  const full = registry.join(room.id, 3, fakeSocket("s3") as any);
  if (full?.seat !== null) throw new Error("третий игрок не должен получать место");

  // Обрыв связи: место держится, партия ждёт.
  registry.detach(2, "s2", fakeIo as any);
  if (registry.seatOf(room, 2) !== "b") throw new Error("место должно удерживаться сразу после обрыва");
  if (registry.isOnline(room, "b")) throw new Error("отвалившийся игрок не может быть онлайн");
  const deadline = registry.presence(room).find((p) => p.seat === "b")?.reconnectDeadline;
  if (!deadline || deadline <= Date.now()) throw new Error("не выставлен дедлайн возврата");

  // Возврат внутри окна.
  const back = registry.join(room.id, 2, fakeSocket("s2b") as any);
  if (!back?.reconnected || back.seat !== "b") throw new Error("возврат должен вернуть то же место");
  if (registry.presence(room).find((p) => p.seat === "b")?.reconnectDeadline !== null) {
    throw new Error("дедлайн должен сниматься при возврате");
  }
  console.log("room core: места, заполненность и возврат в окне — ок");

  // Комната под паролем.
  const locked = registry.create(20, { n: 0 }, "  hunter2 ");
  if (!registry.hasPassword(locked)) throw new Error("пароль не выставился");
  if ((locked as any).password?.hash === "hunter2") throw new Error("пароль не должен храниться открытым текстом");
  registry.join(locked.id, 20, fakeSocket("o1") as any);

  const wrong = registry.join(locked.id, 21, fakeSocket("w1") as any, "hunter3");
  if (wrong?.error !== "wrong_password" || wrong.seat !== null) throw new Error("неверный пароль должен отклоняться");
  const empty = registry.join(locked.id, 21, fakeSocket("w2") as any);
  if (empty?.error !== "wrong_password") throw new Error("вход без пароля должен отклоняться");
  const right = registry.join(locked.id, 21, fakeSocket("w3") as any, "hunter2");
  if (right?.error !== null || right.seat !== "b") throw new Error("верный пароль должен пускать");

  // Вернувшийся игрок пароль не вводит заново.
  registry.detach(21, "w3", fakeIo as any);
  const backLocked = registry.join(locked.id, 21, fakeSocket("w4") as any);
  if (backLocked?.error !== null || !backLocked.reconnected) throw new Error("возврат не должен требовать пароль");

  // Открытая комната пускает без пароля.
  const open = registry.create(30, { n: 0 });
  if (registry.hasPassword(open)) throw new Error("открытая комната не должна иметь пароль");
  if (registry.join(open.id, 31, fakeSocket("f1") as any)?.error !== null) throw new Error("открытая комната должна пускать");
  console.log("room core: пароль комнаты — ок");

  // Невозврат: место освобождается по истечении окна.
  const late = registry.create(10, { n: 0 });
  registry.join(late.id, 10, fakeSocket("a") as any);
  registry.join(late.id, 11, fakeSocket("b") as any);
  registry.detach(11, "b", fakeIo as any);
  setTimeout(() => {
    if (registry.seatOf(late, 11) !== null) throw new Error("место не освободилось после окна");
    if (!abandoned.includes("b")) throw new Error("не сработал onSeatAbandoned");
    console.log("room core: освобождение места после истечения окна — ок");
    runGames();
  }, 90);
}

function runGames(): void {
  const games = Number(process.argv[2] || 200);
  let decided = 0;
  let maxPlies = 0;
  for (let i = 0; i < games; i += 1) {
    const r = playGame(7919 + i * 31);
    if (r.winner !== "draw") decided += 1;
    maxPlies = Math.max(maxPlies, r.plies);
  }
  console.log(`checkers selfplay: ${decided}/${games} партий дошли до победителя, максимум ${maxPlies} полуходов`);
  if (decided < games * 0.8) {
    console.error("слишком много партий не завершилось — похоже на зависание");
    process.exit(1);
  }
  console.log("Done.");
  process.exit(0);
}

checkRoomCore();
