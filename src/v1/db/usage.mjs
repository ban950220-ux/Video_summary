// D1-backed daily usage caps with the same interface as createMemoryUsage().
// Each key is reserved with a conditional UPDATE, so two parallel jobs cannot both pass the cap.
// If a later key in the same consume() call fails, earlier reservations are given back.
import {AppError} from '../errors.mjs';
import {ensureV1Schema} from './schema.mjs';

export function usageDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function costMilliKrw(budget, promptTokens, outputTokens) {
  const usd = ((promptTokens ?? 0) * budget.usdPerMInput + (outputTokens ?? 0) * budget.usdPerMOutput) / 1e6;
  return Math.ceil(usd * budget.krwPerUsd * 1000);
}

const SPEND_KEY = 'geminiMilliKrw';

export function createD1Usage(db, limits, {now = () => new Date(), budget = null} = {}) {
  const month = () => new Date(now()).toISOString().slice(0, 7);
  const spentMilli = async () => {
    const row = await db.prepare('SELECT units FROM v1_usage WHERE day = ? AND key = ?').bind(month(), SPEND_KEY)
      .first();
    const [offsetMonth, offsetKrw] = (budget?.offset ?? ':0').split(':');
    return Number(row?.units ?? 0) + (offsetMonth === month() ? Number(offsetKrw) * 1000 : 0);
  };
  // One statement: insert or add, only while the total stays within the limit (changes = 0 otherwise).
  const reserve = async (day, key, amount) => {
    if (amount > limits[key]) return false;
    const result = await db.prepare(`INSERT INTO v1_usage(day, key, units) VALUES(?, ?, ?)
      ON CONFLICT(day, key) DO UPDATE SET units = units + excluded.units WHERE units + excluded.units <= ?`)
      .bind(day, key, amount, limits[key]).run();
    return Number(result?.meta?.changes ?? 0) === 1;
  };
  const release = (day, key, amount) => db.prepare('UPDATE v1_usage SET units = units - ? WHERE day = ? AND key = ?')
    .bind(amount, day, key).run();

  return {
    // Called after every Gemini response with the tokens it reported.
    async charge({promptTokens, outputTokens}) {
      if (!budget) return;
      await ensureV1Schema(db);
      const cost = costMilliKrw(budget, promptTokens, outputTokens);
      await db.prepare(`INSERT INTO v1_usage(day, key, units) VALUES(?, ?, ?)
        ON CONFLICT(day, key) DO UPDATE SET units = units + excluded.units`).bind(month(), SPEND_KEY, cost).run();
    },
    async consume(units) {
      await ensureV1Schema(db);
      // One call can cost up to about the reserve, so Gemini stops that far below the budget.
      if (budget && Object.keys(units).some(key => key.startsWith('gemini'))
          && (await spentMilli()) / 1000 > budget.monthlyKrw - budget.reserveKrw) {
        throw new AppError('MONTHLY_BUDGET_REACHED', `${month()} gemini`);
      }
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
      const spend = budget ? {month: month(), spentKrw: Math.round((await spentMilli()) / 10) / 100,
        budgetKrw: budget.monthlyKrw, estimated: true} : null;
      return {day, items: Object.entries(limits).map(([key, limit]) => ({key, used: used[key] ?? 0, limit})), spend};
    },
  };
}
