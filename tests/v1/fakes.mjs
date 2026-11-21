// Test doubles for v1: a scripted fetch and a minimal D1 binding over node:sqlite.
import {DatabaseSync} from 'node:sqlite';

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: {'content-type': 'application/json', ...headers},
  });
}

// handlers: array of (url, init) => Response | Error, consumed in order (last one repeats).
export function scriptedFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({url: String(url), init, body: init.body ? JSON.parse(init.body) : null});
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    const result = typeof handler === 'function' ? handler(String(url), init) : handler;
    if (result instanceof Error) throw result;
    return result;
  };
  return {fetchFn, calls};
}

export const noSleep = async () => {};

export function d1(db) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({results: db.prepare(sql).all(...params)}),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return {meta: {changes: Number(info.changes)}};
    },
  });
  return {prepare: sql => statement(sql)};
}

export function memoryDb() {
  return new DatabaseSync(':memory:');
}

export function geminiBody(payload, {finishReason = 'STOP', usage = {promptTokenCount: 100}} = {}) {
  return {
    candidates: [{finishReason, content: {parts: [{text: JSON.stringify(payload)}]}}],
    usageMetadata: usage,
  };
}
