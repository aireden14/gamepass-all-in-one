import { Router, Response } from "express";
import { prisma } from "../utils/prisma";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { safeJson } from "../utils/json";

export const sudokuRouter = Router();

type Difficulty = "easy" | "medium" | "hard" | "expert" | "labyrinth" | "abyss";
const DIFFS: Difficulty[] = ["easy", "medium", "hard", "expert", "labyrinth", "abyss"];
// Лабиринт и Бездна проверены логическим решателем: там гарантированно нужны
// продвинутые приёмы, поэтому и платят они заметно больше «Эксперта».
const BASE_POINTS: Record<Difficulty, number> = {
  easy: 10,
  medium: 20,
  hard: 35,
  expert: 55,
  labyrinth: 80,
  abyss: 120,
};
const HARD_PLUS: Difficulty[] = ["hard", "expert", "labyrinth", "abyss"];
// Поля крупнее классики: 144 и 256 клеток вместо 81 — и опыт за них выше.
const SIZE_FACTOR: Record<number, number> = { 9: 1, 12: 1.5, 16: 2 };
const SIZES = [9, 12, 16];
const TASK_XP = 15; // per completed daily task
const ALL_DAILY_XP = 50; // bonus for completing all daily tasks
const XP_PER_LEVEL = 100;

interface SolveResult {
  difficulty: Difficulty;
  size: number;
  mode: "classic" | "daily";
  elapsedSeconds: number;
  mistakes: number;
  hintsUsed: number;
}

const ACHIEVEMENTS = [
  { id: "first_win", title: "Первая победа", desc: "Реши первую судоку" },
  { id: "solver_10", title: "Десятка", desc: "Реши 10 судоку" },
  { id: "century", title: "Сотня", desc: "Реши 100 судоку" },
  { id: "flawless", title: "Безупречно", desc: "Реши без единой ошибки" },
  { id: "no_hints", title: "Без подсказок", desc: "Реши без подсказок" },
  { id: "speed", title: "Скорость", desc: "Реши быстрее 3 минут" },
  { id: "expert", title: "Эксперт", desc: "Реши уровень «Эксперт»" },
  { id: "labyrinth", title: "Картограф", desc: "Пройди «Лабиринт»" },
  { id: "abyss", title: "Бездна смотрит в ответ", desc: "Пройди «Бездну»" },
  { id: "size_12", title: "Размах", desc: "Реши поле 12×12" },
  { id: "size_16", title: "Гигант", desc: "Реши поле 16×16" },
  { id: "streak_7", title: "Неделя", desc: "Серия ежедневных — 7 дней" },
  { id: "streak_30", title: "Месяц подряд", desc: "Серия ежедневных — 30 дней" },
  { id: "marathon", title: "Марафон", desc: "Реши 50 судоку" },
  { id: "perfect_day", title: "Идеальный день", desc: "Выполни все задания дня" },
  { id: "level_5", title: "Уровень 5", desc: "Достигни 5 уровня" },
  { id: "level_10", title: "Уровень 10", desc: "Достигни 10 уровня" },
];

const DAILY_POOL: Array<{ id: string; title: string; check: (r: SolveResult) => boolean }> = [
  { id: "daily_solve", title: "Реши дневную судоку", check: (r) => r.mode === "daily" },
  { id: "flawless", title: "Реши без ошибок", check: (r) => r.mistakes === 0 },
  { id: "no_hints", title: "Реши без подсказок", check: (r) => r.hintsUsed === 0 },
  { id: "hard_plus", title: "Реши «Сложно» или выше", check: (r) => HARD_PLUS.includes(r.difficulty) },
  { id: "under_5", title: "Реши быстрее 5 минут", check: (r) => r.elapsedSeconds < 300 },
];

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyTasksForDate(dateKey: string) {
  let h = 0;
  for (const ch of dateKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pool = [...DAILY_POOL];
  const chosen: typeof DAILY_POOL = [];
  for (let i = 0; i < 3 && pool.length; i += 1) {
    const idx = (h + i * 7) % pool.length;
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

function levelForXp(xp: number): number {
  return Math.max(1, Math.floor(xp / XP_PER_LEVEL) + 1);
}

async function getProfile(userId: number) {
  const existing = await prisma.sudokuProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await prisma.sudokuProfile.create({ data: { userId } });
  } catch (e: any) {
    // Concurrent create race (P2002): another request created it first.
    if (e?.code === "P2002") {
      const again = await prisma.sudokuProfile.findUnique({ where: { userId } });
      if (again) return again;
    }
    throw e;
  }
}

function wrap(fn: (req: AuthedRequest, res: Response) => Promise<void>) {
  return async (req: AuthedRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error("[sudoku]", e);
      res.status(500).json({ error: e?.message || "server error" });
    }
  };
}

sudokuRouter.get(
  "/me",
  authMiddleware,
  wrap(async (req, res) => {
    const p = await getProfile(req.auth!.userId);
    res.json(safeJson(p));
  }),
);

sudokuRouter.get(
  "/achievements",
  authMiddleware,
  wrap(async (req, res) => {
    const p = await getProfile(req.auth!.userId);
    let unlocked: string[] = [];
    try {
      unlocked = JSON.parse(p.achievementsJson || "[]");
    } catch {}
    const set = new Set(unlocked);
    res.json(ACHIEVEMENTS.map((a) => ({ ...a, unlocked: set.has(a.id) })));
  }),
);

sudokuRouter.get(
  "/leaderboard",
  authMiddleware,
  wrap(async (_req, res) => {
    const rows = await prisma.sudokuProfile.findMany({
      orderBy: { rating: "desc" },
      take: 20,
      include: { user: { select: { id: true, firstName: true } } },
    });
    res.json(
      rows.map((r) => ({
        userId: r.userId,
        firstName: r.user?.firstName ?? "—",
        rating: r.rating,
        level: r.level,
        completed: r.completed,
      })),
    );
  }),
);

sudokuRouter.get(
  "/daily",
  authMiddleware,
  wrap(async (req, res) => {
    const dateKey = todayKey();
    const p = await getProfile(req.auth!.userId);
    let done: Record<string, boolean> = {};
    try {
      done = (JSON.parse(p.dailyTasksJson || "{}")[dateKey] as Record<string, boolean>) || {};
    } catch {}
    res.json({
      date: dateKey,
      allDoneBonus: ALL_DAILY_XP,
      tasks: dailyTasksForDate(dateKey).map((t) => ({
        id: t.id,
        title: t.title,
        xp: TASK_XP,
        done: !!done[t.id],
      })),
    });
  }),
);

sudokuRouter.post(
  "/complete",
  authMiddleware,
  wrap(async (req, res) => {
    const userId = req.auth!.userId;
    const difficulty: Difficulty = DIFFS.includes(req.body?.difficulty) ? req.body.difficulty : "medium";
    const size: number = SIZES.includes(Number(req.body?.size)) ? Number(req.body.size) : 9;
    const mode: "classic" | "daily" = req.body?.mode === "daily" ? "daily" : "classic";
    const elapsedSeconds = Math.max(0, Math.min(36000, Math.floor(Number(req.body?.elapsedSeconds) || 0)));
    const mistakes = Math.max(0, Math.min(999, Math.floor(Number(req.body?.mistakes) || 0)));
    const hintsUsed = Math.max(0, Math.min(999, Math.floor(Number(req.body?.hintsUsed) || 0)));
    const dailyDate = typeof req.body?.dailyDate === "string" ? req.body.dailyDate : null;

    const p = await getProfile(userId);
    const result: SolveResult = { difficulty, size, mode, elapsedSeconds, mistakes, hintsUsed };

    // Base solve points
    const base = Math.round(BASE_POINTS[difficulty] * (SIZE_FACTOR[size] ?? 1));
    const speedBonus = elapsedSeconds < 180 ? 10 : elapsedSeconds < 300 ? 5 : 0;
    const solvePoints = Math.max(Math.round(base / 3), base + speedBonus - mistakes * 2 - hintsUsed * 3);

    // Best times — у каждого размера поля свой рекорд
    let bestTimes: Record<string, number | null> = {};
    try {
      bestTimes = JSON.parse(p.bestTimesJson || "{}");
    } catch {}
    const recordKey = size === 9 ? difficulty : `${size}:${difficulty}`;
    const prevBest = bestTimes[recordKey];
    bestTimes[recordKey] = prevBest == null ? elapsedSeconds : Math.min(prevBest, elapsedSeconds);

    // Daily streak (+ best streak + streak bonus)
    let dailyStreak = p.dailyStreak;
    let lastDailyDate = p.lastDailyDate;
    if (mode === "daily" && dailyDate && lastDailyDate !== dailyDate) {
      const prev = lastDailyDate ? new Date(`${lastDailyDate}T00:00:00Z`).getTime() : null;
      const cur = new Date(`${dailyDate}T00:00:00Z`).getTime();
      const diff = prev ? Math.round((cur - prev) / 86400000) : 0;
      dailyStreak = prev && diff === 1 ? dailyStreak + 1 : 1;
      lastDailyDate = dailyDate;
    }
    const bestStreak = Math.max(p.bestStreak, dailyStreak);
    const streakBonus = mode === "daily" ? Math.min(dailyStreak, 10) * 2 : 0;

    const completed = p.completed + 1;
    const played = p.played + 1;

    // Daily tasks: grant XP once per task per day; bonus when all done
    const dateKey = todayKey();
    let dailyTasks: Record<string, Record<string, boolean>> = {};
    try {
      dailyTasks = JSON.parse(p.dailyTasksJson || "{}");
    } catch {}
    let dailyReward: Record<string, { rewarded: string[]; allDone: boolean }> = {};
    try {
      dailyReward = JSON.parse(p.dailyRewardJson || "{}");
    } catch {}
    const todays = dailyTasks[dateKey] || {};
    const rewardRec = dailyReward[dateKey] || { rewarded: [], allDone: false };
    const rewardedSet = new Set(rewardRec.rewarded);
    const todaysTasks = dailyTasksForDate(dateKey);
    let taskBonus = 0;
    const newlyCompletedTasks: Array<{ id: string; title: string; xp: number }> = [];
    for (const t of todaysTasks) {
      if (t.check(result)) {
        todays[t.id] = true;
        if (!rewardedSet.has(t.id)) {
          rewardedSet.add(t.id);
          taskBonus += TASK_XP;
          newlyCompletedTasks.push({ id: t.id, title: t.title, xp: TASK_XP });
        }
      }
    }
    const allDone = todaysTasks.every((t) => todays[t.id]);

    // Achievements
    let unlocked: string[] = [];
    try {
      unlocked = JSON.parse(p.achievementsJson || "[]");
    } catch {}
    const has = new Set(unlocked);
    const newlyUnlocked: string[] = [];
    const grant = (id: string) => {
      if (!has.has(id)) {
        has.add(id);
        newlyUnlocked.push(id);
      }
    };

    let allDoneBonus = 0;
    if (allDone && !rewardRec.allDone) {
      allDoneBonus = ALL_DAILY_XP;
      rewardRec.allDone = true;
      grant("perfect_day");
    }
    rewardRec.rewarded = [...rewardedSet];
    dailyReward[dateKey] = rewardRec;
    dailyTasks[dateKey] = todays;
    const pruneOld = (store: Record<string, unknown>) => {
      const keys = Object.keys(store).sort();
      while (keys.length > 7) delete store[keys.shift()!];
    };
    pruneOld(dailyTasks);
    pruneOld(dailyReward);

    const totalPoints = solvePoints + taskBonus + allDoneBonus + streakBonus;
    const xp = p.xp + totalPoints;
    const rating = p.rating + totalPoints;
    const level = levelForXp(xp);

    grant("first_win");
    if (completed >= 10) grant("solver_10");
    if (completed >= 50) grant("marathon");
    if (completed >= 100) grant("century");
    if (mistakes === 0) grant("flawless");
    if (hintsUsed === 0) grant("no_hints");
    if (elapsedSeconds < 180) grant("speed");
    if (difficulty === "expert") grant("expert");
    if (difficulty === "labyrinth") grant("labyrinth");
    if (difficulty === "abyss") grant("abyss");
    if (size === 12) grant("size_12");
    if (size === 16) grant("size_16");
    if (dailyStreak >= 7) grant("streak_7");
    if (dailyStreak >= 30) grant("streak_30");
    if (level >= 5) grant("level_5");
    if (level >= 10) grant("level_10");

    const updated = await prisma.sudokuProfile.update({
      where: { userId },
      data: {
        rating,
        xp,
        level,
        played,
        completed,
        bestTimesJson: JSON.stringify(bestTimes),
        dailyStreak,
        bestStreak,
        lastDailyDate,
        dailyTasksJson: JSON.stringify(dailyTasks),
        dailyRewardJson: JSON.stringify(dailyReward),
        achievementsJson: JSON.stringify([...has]),
      },
    });

    res.json({
      profile: safeJson(updated),
      gained: {
        points: totalPoints,
        base: solvePoints,
        taskBonus,
        allDoneBonus,
        streakBonus,
        leveledUp: level > p.level,
        level,
        xp,
        levelProgress: xp % XP_PER_LEVEL,
        xpToNext: XP_PER_LEVEL - (xp % XP_PER_LEVEL),
        allDailyDone: allDone,
      },
      newlyCompletedTasks,
      newlyUnlocked: newlyUnlocked
        .map((id) => ACHIEVEMENTS.find((a) => a.id === id))
        .filter(Boolean),
    });
  }),
);
