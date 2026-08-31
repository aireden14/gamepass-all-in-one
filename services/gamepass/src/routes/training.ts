import { Router, Response } from "express";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { ensureTrainingProfile } from "../services/trainingProfile";
import {
  clampInt,
  computeStreaks,
  dateKeyInTimezone,
  isValidDateKey,
  parseJson,
  sanitizeTrainingSettings,
  sanitizeTrainingState,
  type TrainingExerciseSnapshot,
  type TrainingMode,
  type TrainingSettings,
  type TrainingState,
} from "../training/model";
import { prisma } from "../utils/prisma";

export const trainingRouter = Router();
const MODES = new Set<TrainingMode>(["sick", "light", "medium", "record"]);

function wrap(fn: (req: AuthedRequest, res: Response) => Promise<void>) {
  return async (req: AuthedRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (error: any) {
      console.error("[training]", error);
      res.status(500).json({ error: error?.message || "server error" });
    }
  };
}

function intArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => clampInt(item, 0, 100000, 0));
}

function parseExerciseSnapshots(value: unknown): TrainingExerciseSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((raw) => {
    const item = raw && typeof raw === "object" ? (raw as any) : {};
    return {
      exerciseId: String(item.exerciseId || "").trim().slice(0, 48),
      name: String(item.name || "Упражнение").trim().slice(0, 40) || "Упражнение",
      plannedSets: intArray(item.plannedSets),
      actualSets: intArray(item.actualSets),
    };
  }).filter((item) => item.exerciseId && item.plannedSets.length > 0);
}

async function dashboard(userId: number, requestedDate?: unknown) {
  const ensured = await ensureTrainingProfile(userId);
  const { profile, state, settings, isDenrech } = ensured;
  const dateKey = isValidDateKey(requestedDate)
    ? requestedDate
    : dateKeyInTimezone(settings.reminderTimezone);
  const rows = await prisma.trainingSession.findMany({
    where: { profileId: profile.id },
    orderBy: { dateKey: "desc" },
    take: 400,
  });
  const history = rows.map((row) => ({
    id: row.id,
    dateKey: row.dateKey,
    mode: row.mode,
    plan: parseJson<TrainingExerciseSnapshot[]>(row.planJson, []),
    actual: parseJson<TrainingExerciseSnapshot[]>(row.actualJson, []),
    totalPlanned: row.totalPlanned,
    totalActual: row.totalActual,
    goalCompleted: row.goalCompleted,
    recordProgressApplied: row.recordProgressApplied,
    completedAt: row.completedAt.toISOString(),
  }));
  const streaks = computeStreaks(history.map((item) => item.dateKey), dateKey);
  return {
    profileId: profile.id,
    dateKey,
    state,
    settings,
    today: history.find((item) => item.dateKey === dateKey) || null,
    history,
    stats: {
      ...streaks,
      totalWorkouts: history.length,
      totalReps: history.reduce((sum, item) => sum + item.totalActual, 0),
      recordWorkouts: history.filter((item) => item.recordProgressApplied).length,
    },
    remindersPrivate: isDenrech,
  };
}

trainingRouter.get(
  "/me",
  authMiddleware,
  wrap(async (req, res) => {
    res.json(await dashboard(req.auth!.userId, req.query.date));
  }),
);

trainingRouter.patch(
  "/settings",
  authMiddleware,
  wrap(async (req, res) => {
    const userId = req.auth!.userId;
    const ensured = await ensureTrainingProfile(userId);
    const state = sanitizeTrainingState(req.body?.state, ensured.state);
    const settings = sanitizeTrainingSettings(req.body?.settings, ensured.settings);
    settings.reminderEnabled = false;
    await prisma.trainingProfile.update({
      where: { id: ensured.profile.id },
      data: {
        stateJson: JSON.stringify(state),
        settingsJson: JSON.stringify(settings),
      },
    });
    res.json(await dashboard(userId, req.body?.dateKey));
  }),
);

trainingRouter.post(
  "/complete",
  authMiddleware,
  wrap(async (req, res) => {
    const userId = req.auth!.userId;
    const dateKey = req.body?.dateKey;
    if (!isValidDateKey(dateKey)) {
      res.status(400).json({ error: "bad dateKey" });
      return;
    }
    const mode = String(req.body?.mode || "") as TrainingMode;
    if (!MODES.has(mode)) {
      res.status(400).json({ error: "bad mode" });
      return;
    }
    const snapshots = parseExerciseSnapshots(req.body?.exercises);
    if (snapshots.length === 0) {
      res.status(400).json({ error: "empty workout" });
      return;
    }

    const totalPlanned = snapshots.reduce(
      (sum, exercise) => sum + exercise.plannedSets.reduce((inner, reps) => inner + reps, 0),
      0,
    );
    const totalActual = snapshots.reduce(
      (sum, exercise) => sum + exercise.actualSets.reduce((inner, reps) => inner + reps, 0),
      0,
    );
    if (totalPlanned <= 0 || totalActual <= 0) {
      res.status(400).json({ error: "empty workout" });
      return;
    }
    const goalCompleted = snapshots.every(
      (exercise) => exercise.actualSets.reduce((sum, reps) => sum + reps, 0)
        >= exercise.plannedSets.reduce((sum, reps) => sum + reps, 0),
    );

    const ensured = await ensureTrainingProfile(userId);
    const allowed = new Set(ensured.state.exercises.map((exercise) => exercise.id));
    if (snapshots.some((exercise) => !allowed.has(exercise.exerciseId))) {
      res.status(400).json({ error: "unknown exercise" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      const existing = await tx.trainingSession.findUnique({
        where: { profileId_dateKey: { profileId: ensured.profile.id, dateKey } },
      });
      const previousProgress = existing
        ? parseJson<Array<{ exerciseId: string; previousTarget: number }>>(existing.recordProgressJson, [])
        : [];
      const shouldApplyProgress = mode === "record" && goalCompleted;
      let recordProgress = previousProgress;
      let nextState = ensured.state;

      if (previousProgress.length > 0 && !shouldApplyProgress) {
        const previousById = new Map(previousProgress.map((item) => [item.exerciseId, item.previousTarget]));
        nextState = {
          ...nextState,
          exercises: nextState.exercises.map((exercise) => previousById.has(exercise.id)
            ? { ...exercise, recordTarget: previousById.get(exercise.id)! }
            : exercise),
        };
        recordProgress = [];
      } else if (previousProgress.length === 0 && shouldApplyProgress) {
        const completedIds = new Set(snapshots.map((item) => item.exerciseId));
        recordProgress = nextState.exercises
          .filter((exercise) => completedIds.has(exercise.id)
            && (exercise.recordCap == null || exercise.recordTarget < exercise.recordCap))
          .map((exercise) => ({ exerciseId: exercise.id, previousTarget: exercise.recordTarget }));
        const progressIds = new Set(recordProgress.map((item) => item.exerciseId));
        nextState = {
          ...nextState,
          exercises: nextState.exercises.map((exercise) => {
            if (!progressIds.has(exercise.id)) return exercise;
            const next = exercise.recordTarget + exercise.recordStep;
            return {
              ...exercise,
              recordTarget: exercise.recordCap == null ? next : Math.min(next, exercise.recordCap),
            };
          }),
        };
      }

      await tx.trainingSession.upsert({
        where: { profileId_dateKey: { profileId: ensured.profile.id, dateKey } },
        update: {
          mode,
          planJson: JSON.stringify(snapshots.map((item) => ({ ...item, actualSets: [] }))),
          actualJson: JSON.stringify(snapshots),
          totalPlanned,
          totalActual,
          goalCompleted,
          recordProgressApplied: recordProgress.length > 0,
          recordProgressJson: JSON.stringify(recordProgress),
          completedAt: new Date(),
        },
        create: {
          profileId: ensured.profile.id,
          dateKey,
          mode,
          planJson: JSON.stringify(snapshots.map((item) => ({ ...item, actualSets: [] }))),
          actualJson: JSON.stringify(snapshots),
          totalPlanned,
          totalActual,
          goalCompleted,
          recordProgressApplied: recordProgress.length > 0,
          recordProgressJson: JSON.stringify(recordProgress),
        },
      });

      if (JSON.stringify(nextState) !== JSON.stringify(ensured.state)) {
        await tx.trainingProfile.update({
          where: { id: ensured.profile.id },
          data: { stateJson: JSON.stringify(nextState) },
        });
      }
    });

    res.json(await dashboard(userId, dateKey));
  }),
);

trainingRouter.delete(
  "/day/:dateKey",
  authMiddleware,
  wrap(async (req, res) => {
    const userId = req.auth!.userId;
    const dateKey = req.params.dateKey;
    if (!isValidDateKey(dateKey)) {
      res.status(400).json({ error: "bad dateKey" });
      return;
    }
    const ensured = await ensureTrainingProfile(userId);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.trainingSession.findUnique({
        where: { profileId_dateKey: { profileId: ensured.profile.id, dateKey } },
      });
      if (!existing) return;
      const previousProgress = parseJson<Array<{ exerciseId: string; previousTarget: number }>>(
        existing.recordProgressJson,
        [],
      );
      if (previousProgress.length > 0) {
        const previousById = new Map(previousProgress.map((item) => [item.exerciseId, item.previousTarget]));
        const nextState: TrainingState = {
          ...ensured.state,
          exercises: ensured.state.exercises.map((exercise) => previousById.has(exercise.id)
            ? { ...exercise, recordTarget: previousById.get(exercise.id)! }
            : exercise),
        };
        await tx.trainingProfile.update({
          where: { id: ensured.profile.id },
          data: { stateJson: JSON.stringify(nextState) },
        });
      }
      await tx.trainingSession.delete({ where: { id: existing.id } });
    });
    res.json(await dashboard(userId, dateKey));
  }),
);
