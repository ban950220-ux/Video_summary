// Daily in-app usage caps. consume() is called BEFORE each provider request and throws
// DAILY_LIMIT_REACHED instead of exceeding a cap. This in-memory version is for tests and a
// single request; stage 4 adds a D1-backed implementation with the same interface.
import {AppError} from './errors.mjs';

export function createMemoryUsage(limits, used = {}) {
  const totals = {...used};
  return {
    totals,
    async consume(units) {
      for (const [key, amount] of Object.entries(units)) {
        if (!Object.hasOwn(limits, key)) throw new AppError('INTERNAL', `unknown usage key ${key}`);
        if ((totals[key] ?? 0) + amount > limits[key]) throw new AppError('DAILY_LIMIT_REACHED', key);
      }
      for (const [key, amount] of Object.entries(units)) totals[key] = (totals[key] ?? 0) + amount;
    },
  };
}
