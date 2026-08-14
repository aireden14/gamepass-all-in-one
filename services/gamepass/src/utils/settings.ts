export interface GameSettings {
  timeControl: number;
  increment: number;
  colorChoice: "random" | "white" | "black";
}

const DEFAULT_SETTINGS: GameSettings = {
  timeControl: 600,
  increment: 0,
  colorChoice: "random",
};

export function parseSettings(raw: unknown): GameSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  if (typeof obj !== "object" || obj === null) return DEFAULT_SETTINGS;
  const timeControl = Number(obj.timeControl ?? DEFAULT_SETTINGS.timeControl) || 0;
  const increment = Number(obj.increment ?? DEFAULT_SETTINGS.increment) || 0;
  const colorChoice =
    obj.colorChoice === "white" || obj.colorChoice === "black" ? obj.colorChoice : "random";
  return { timeControl, increment, colorChoice };
}

export function serializeSettings(settings: Partial<GameSettings>): string {
  return JSON.stringify({ ...DEFAULT_SETTINGS, ...settings });
}
