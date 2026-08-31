export type TrainingMode = "sick" | "light" | "medium" | "record";

export interface TrainingExerciseState {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  active: boolean;
  recordTarget: number;
  recordStep: number;
  recordCap: number | null;
  leadSet: number;
  restSecondsPerRep: number;
  levels: {
    sick: number;
    light: number;
    medium: number;
  };
  unlockAfterExerciseId: string | null;
  unlockAtTarget: number | null;
}

export interface TrainingState {
  version: 1;
  exercises: TrainingExerciseState[];
}

export interface TrainingSettings {
  reminderEnabled: boolean;
  reminderStartHour: number;
  reminderEndHour: number;
  reminderTimezone: string;
}

export interface TrainingExerciseSnapshot {
  exerciseId: string;
  name: string;
  plannedSets: number[];
  actualSets: number[];
}

const DEFAULT_ACCENTS = ["#ff6b45", "#4f8cff", "#34c58a", "#af6bff", "#f1ad3d"];

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function defaultTrainingState(isDenrech: boolean): TrainingState {
  return {
    version: 1,
    exercises: [
      {
        id: "burpee",
        name: "Берпи",
        emoji: "↗",
        accent: "#ff6b45",
        active: true,
        // @denrech already completed 30 on 30.08.2026, so the next record task is 31.
        recordTarget: isDenrech ? 31 : 30,
        recordStep: 1,
        recordCap: null,
        leadSet: 13,
        restSecondsPerRep: 6,
        levels: { sick: 7, light: 15, medium: 23 },
        unlockAfterExerciseId: null,
        unlockAtTarget: null,
      },
    ],
  };
}

export function defaultTrainingSettings(_isDenrech: boolean): TrainingSettings {
  return {
    reminderEnabled: false,
    reminderStartHour: 9,
    reminderEndHour: 23,
    reminderTimezone: "Asia/Nicosia",
  };
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    const parsed = JSON.parse(raw || "");
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || fallback;
}

function cleanId(value: unknown, fallback: string): string {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return id || fallback;
}

function cleanAccent(value: unknown, fallback: string): string {
  const accent = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(accent) ? accent : fallback;
}

export function sanitizeTrainingState(value: unknown, fallback: TrainingState): TrainingState {
  const source = value && typeof value === "object" ? (value as Partial<TrainingState>) : fallback;
  const incoming = Array.isArray(source.exercises) ? source.exercises.slice(0, 20) : fallback.exercises;
  const used = new Set<string>();
  const exercises: TrainingExerciseState[] = incoming.map((raw, index) => {
    const candidate = raw && typeof raw === "object" ? (raw as Partial<TrainingExerciseState>) : {};
    let id = cleanId(candidate.id, `exercise-${index + 1}`);
    while (used.has(id)) id = `${id}-${index + 1}`.slice(0, 48);
    used.add(id);
    const old = fallback.exercises.find((item) => item.id === id);
    const base = old || fallback.exercises[index] || fallback.exercises[0];
    const capValue: unknown = (candidate as any).recordCap;
    const recordCap = capValue === null || capValue === "" || capValue === undefined
      ? null
      : clampInt(capValue, 1, 100000, base.recordCap ?? 100);
    const accentFallback = base?.accent || DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length];
    return {
      id,
      name: cleanText(candidate.name, base?.name || `Упражнение ${index + 1}`, 40),
      emoji: cleanText(candidate.emoji, base?.emoji || "●", 4),
      accent: cleanAccent(candidate.accent, accentFallback),
      active: candidate.active !== false,
      recordTarget: clampInt(candidate.recordTarget, 1, 100000, base?.recordTarget || 10),
      recordStep: clampInt(candidate.recordStep, 1, 1000, base?.recordStep || 1),
      recordCap,
      leadSet: clampInt(candidate.leadSet, 1, 100000, base?.leadSet || 5),
      restSecondsPerRep: clampInt(candidate.restSecondsPerRep, 0, 120, base?.restSecondsPerRep || 6),
      levels: {
        sick: clampInt(candidate.levels?.sick, 1, 100000, base?.levels.sick || 5),
        light: clampInt(candidate.levels?.light, 1, 100000, base?.levels.light || 10),
        medium: clampInt(candidate.levels?.medium, 1, 100000, base?.levels.medium || 15),
      },
      unlockAfterExerciseId: candidate.unlockAfterExerciseId
        ? cleanId(candidate.unlockAfterExerciseId, "") || null
        : null,
      unlockAtTarget: (candidate as any).unlockAtTarget == null || (candidate as any).unlockAtTarget === ""
        ? null
        : clampInt(candidate.unlockAtTarget, 1, 100000, 10),
    };
  });

  if (exercises.length === 0) return fallback;
  const ids = new Set(exercises.map((exercise) => exercise.id));
  for (const exercise of exercises) {
    if (exercise.unlockAfterExerciseId && !ids.has(exercise.unlockAfterExerciseId)) {
      exercise.unlockAfterExerciseId = null;
      exercise.unlockAtTarget = null;
    }
  }
  return { version: 1, exercises };
}

export function sanitizeTrainingSettings(
  value: unknown,
  fallback: TrainingSettings,
): TrainingSettings {
  const source = value && typeof value === "object" ? (value as Partial<TrainingSettings>) : fallback;
  let timezone = cleanText(source.reminderTimezone, fallback.reminderTimezone, 64);
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    timezone = fallback.reminderTimezone;
  }
  const start = clampInt(source.reminderStartHour, 0, 23, fallback.reminderStartHour);
  let end = clampInt(source.reminderEndHour, 1, 24, fallback.reminderEndHour);
  if (end <= start) end = Math.min(24, start + 1);
  return {
    reminderEnabled: source.reminderEnabled === true,
    reminderStartHour: start,
    reminderEndHour: end,
    reminderTimezone: timezone,
  };
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function dateKeyInTimezone(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function hourInTimezone(timezone: string, date = new Date()): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return clampInt(value, 0, 23, 0);
}

export function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function computeStreaks(dateKeys: string[], todayKey: string) {
  const dates = [...new Set(dateKeys.filter(isValidDateKey))].sort();
  let bestStreak = 0;
  let running = 0;
  let previous: string | null = null;
  for (const dateKey of dates) {
    running = previous && shiftDateKey(previous, 1) === dateKey ? running + 1 : 1;
    bestStreak = Math.max(bestStreak, running);
    previous = dateKey;
  }

  const dateSet = new Set(dates);
  const latest = dates[dates.length - 1] || null;
  const anchor = latest === todayKey || latest === shiftDateKey(todayKey, -1) ? latest : null;
  let currentStreak = 0;
  if (anchor) {
    let cursor = anchor;
    while (dateSet.has(cursor)) {
      currentStreak += 1;
      cursor = shiftDateKey(cursor, -1);
    }
  }
  return { currentStreak, bestStreak };
}

export function isExerciseUnlocked(exercise: TrainingExerciseState, state: TrainingState): boolean {
  if (!exercise.unlockAfterExerciseId) return true;
  const previous = state.exercises.find((item) => item.id === exercise.unlockAfterExerciseId);
  if (!previous) return true;
  const threshold = exercise.unlockAtTarget ?? previous.recordCap;
  return threshold != null && previous.recordTarget >= threshold;
}

export function targetForMode(exercise: TrainingExerciseState, mode: TrainingMode): number {
  if (mode === "record") return exercise.recordTarget;
  return exercise.levels[mode];
}
