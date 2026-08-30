import { prisma } from "../utils/prisma";
import { dateKeyInTimezone, hourInTimezone, isExerciseUnlocked } from "../training/model";
import { ensureTrainingProfile } from "./trainingProfile";
import { sendTelegramMessage } from "./telegramBot";

let checking = false;

async function checkTrainingReminder() {
  if (checking) return;
  checking = true;
  try {
    // The first release is intentionally private: only @denrech receives reminders.
    const user = await prisma.user.findFirst({ where: { username: "denrech", isBot: false } });
    if (!user) return;

    const { profile, settings, state } = await ensureTrainingProfile(user.id);
    if (!settings.reminderEnabled) return;

    const now = new Date();
    const hour = hourInTimezone(settings.reminderTimezone, now);
    if (hour < settings.reminderStartHour || hour >= settings.reminderEndHour) return;

    const dateKey = dateKeyInTimezone(settings.reminderTimezone, now);
    const reminderKey = `${dateKey}:${String(hour).padStart(2, "0")}`;
    if (profile.lastReminderKey === reminderKey) return;

    const completed = await prisma.trainingSession.findUnique({
      where: { profileId_dateKey: { profileId: profile.id, dateKey } },
      select: { id: true },
    });
    if (completed) return;

    const active = state.exercises.filter(
      (exercise) => exercise.active && isExerciseUnlocked(exercise, state),
    );
    const targets = active
      .map((exercise) => `${exercise.name} — рекорд ${exercise.recordTarget}`)
      .join(" · ");
    const text = [
      "Тренировка ждёт тебя.",
      targets || "Задание дня уже готово.",
      "Выбери темп, закрой подходы — после выполнения напоминания на сегодня остановятся.",
    ].join("\n\n");

    const sent = await sendTelegramMessage(
      user.telegramId.toString(),
      text,
      "Открыть тренировку",
      "/training",
    );
    if (sent) {
      await prisma.trainingProfile.update({
        where: { id: profile.id },
        data: { lastReminderKey: reminderKey },
      });
    }
  } catch (error) {
    console.error("[training reminder]", error);
  } finally {
    checking = false;
  }
}

export function startTrainingReminderScheduler() {
  const first = setTimeout(() => void checkTrainingReminder(), 15_000);
  first.unref?.();
  const timer = setInterval(() => void checkTrainingReminder(), 60_000);
  timer.unref?.();
}

