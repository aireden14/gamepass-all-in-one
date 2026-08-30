import { prisma } from "../utils/prisma";
import {
  defaultTrainingSettings,
  defaultTrainingState,
  parseJson,
  sanitizeTrainingSettings,
  sanitizeTrainingState,
  type TrainingExerciseSnapshot,
  type TrainingSettings,
  type TrainingState,
} from "../training/model";

export function isDenrechUsername(username: string | null | undefined): boolean {
  return String(username || "").trim().toLowerCase() === "denrech";
}

export async function ensureTrainingProfile(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!user) throw new Error("user not found");

  const isDenrech = isDenrechUsername(user.username);
  let profile = await prisma.trainingProfile.findUnique({ where: { userId } });
  let created = false;
  if (!profile) {
    try {
      profile = await prisma.trainingProfile.create({
        data: {
          userId,
          stateJson: JSON.stringify(defaultTrainingState(isDenrech)),
          settingsJson: JSON.stringify(defaultTrainingSettings(isDenrech)),
        },
      });
      created = true;
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      profile = await prisma.trainingProfile.findUnique({ where: { userId } });
      if (!profile) throw error;
    }
  }

  const fallbackState = defaultTrainingState(isDenrech);
  const fallbackSettings = defaultTrainingSettings(isDenrech);
  const state = sanitizeTrainingState(
    parseJson<TrainingState>(profile.stateJson, fallbackState),
    fallbackState,
  );
  const settings = sanitizeTrainingSettings(
    parseJson<TrainingSettings>(profile.settingsJson, fallbackSettings),
    fallbackSettings,
  );
  const normalizedStateJson = JSON.stringify(state);
  const normalizedSettingsJson = JSON.stringify(settings);
  if (profile.stateJson !== normalizedStateJson || profile.settingsJson !== normalizedSettingsJson) {
    profile = await prisma.trainingProfile.update({
      where: { id: profile.id },
      data: { stateJson: normalizedStateJson, settingsJson: normalizedSettingsJson },
    });
  }

  if (isDenrech && created) await ensureDenrechBaseline(profile.id);
  return { profile, user, state, settings, isDenrech };
}

async function ensureDenrechBaseline(profileId: number) {
  const dateKey = "2026-08-30";
  const exercise: TrainingExerciseSnapshot = {
    exerciseId: "burpee",
    name: "Берпи",
    plannedSets: [13, 8, 9],
    actualSets: [13, 8, 9],
  };
  await prisma.trainingSession.upsert({
    where: { profileId_dateKey: { profileId, dateKey } },
    update: {},
    create: {
      profileId,
      dateKey,
      mode: "record",
      planJson: JSON.stringify([exercise]),
      actualJson: JSON.stringify([exercise]),
      totalPlanned: 30,
      totalActual: 30,
      completedAt: new Date("2026-08-30T12:49:00.000Z"),
    },
  });
}
