// Сериализатор для BigInt — Prisma возвращает telegramId как BigInt
export function safeJson<T>(obj: T): any {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
