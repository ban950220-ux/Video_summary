// D1-backed daily usage caps with the same interface as createMemoryUsage().
// Each key is reserved with a conditional UPDATE, so two parallel jobs cannot both pass the cap.
// If a later key in the same consume() call fails, earlier reservations are given back.
import {AppError} from '../errors.mjs';
import {ensureV1Schema} from './schema.mjs';

export function usageDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function createD1Usage(db, limits, {now = () => new Date()} = {}) {
  const reserve = async (day, key, amount) => {
    await db.prepare('INSERT INTO v1_usage(day, key, units) VALUES(?, ?, 0) ON CONFLICT(day, key) DO NOTHING')
      .bind(day, key).run();
    const result = await db.prepare(
      'UPDATE v1_usage SET units = units + ? WHERE day = ? AND key = ? AND units + ? <= ?')
      .bind(amount, day, key, amount, limits[key]).run();
    return Number(result?.meta?.changes ?? 0) === 1;
  };
  const release = (day, key, amount) => db.prepare('UPDATE v1_usage SET units = units - ? WHERE day = ? AND key = ?')
    .bind(amount, day, key).run();

  return {
    async consume(units) {
      await ensureV1Schema(db);
      const day = usageDay(new Date(now()));
      const done = [];
      for (const [key, amount] of Object.entries(units)) {
        if (!Object.hasOwn(limits, key)) throw new AppError('INTERNAL', `unknown usage key ${key}`);
        if (!(await reserve(day, key, amount))) {
          for (const [doneKey, doneAmount] of done) await release(day, doneKey, doneAmount);
          throw new AppError('DAILY_LIMIT_REACHED', key);
        }
        done.push([key, amount]);
      }
    },
    async snapshot() {
      await ensureV1Schema(db);
      const day = usageDay(new Date(now()));
      const {results = []} = await db.prepare('SELECT key, units FROM v1_usage WHERE day = ?').bind(day).all();
      const used = Object.fromEntries(results.map(r => [r.key, Number(r.units)]));
      return {day, items: Object.entries(limits).map(([key, limit]) => ({key, used: used[key] ?? 0, limit}))};
    },
  };
}
