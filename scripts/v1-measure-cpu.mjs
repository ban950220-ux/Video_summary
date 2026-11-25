// Reads CPU time of the production Worker from Cloudflare's account analytics (GraphQL) and prints
// only aggregate numbers: per-status totals and the 15-minute buckets. Never prints the account ID,
// the token or the raw API response. Used by .github/workflows/measure-cpu.yml.
// Needs a token with "Account Analytics: Read". Values appear 1-2 minutes after the requests.
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const WORKER = 'holy-rice-b914';
export const FREE_CPU_MS = 10;

export function buildQuery() {
  return `query ($account: String!, $script: String!, $since: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 1000,
      filter: {scriptName: $script, datetime_geq: $since}, orderBy: [datetimeFifteenMinutes_ASC]) {
      dimensions { datetimeFifteenMinutes status }
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP75 cpuTimeP99 }
      max { cpuTime }
    } } } }`;
}

const ms = micro => Number((Number(micro ?? 0) / 1000).toFixed(1));

// rows: workersInvocationsAdaptive groups. Returns printable buckets and per-status totals.
export function summarize(rows) {
  const buckets = rows.map(r => ({
    time: String(r.dimensions.datetimeFifteenMinutes).slice(5, 16).replace('T', ' '),
    status: r.dimensions.status,
    requests: r.sum.requests,
    subrequests: r.sum.subrequests,
    p50: ms(r.quantiles.cpuTimeP50), p75: ms(r.quantiles.cpuTimeP75), p99: ms(r.quantiles.cpuTimeP99),
    max: ms(r.max.cpuTime),
  }));
  const byStatus = {};
  for (const b of buckets) {
    const s = byStatus[b.status] ??= {requests: 0, max: 0, bucketsOverLimit: 0};
    s.requests += b.requests;
    s.max = Math.max(s.max, b.max);
    if (b.max >= FREE_CPU_MS) s.bucketsOverLimit += 1;
  }
  return {buckets, byStatus, exceededResources: byStatus.exceededResources?.requests ?? 0,
    maxCpuMs: Math.max(0, ...buckets.map(b => b.max))};
}

export function report({buckets, byStatus, exceededResources, maxCpuMs}, hours) {
  const lines = [`Worker ${WORKER}, last ${hours}h (UTC). CPU in ms, Free limit ${FREE_CPU_MS}ms.`, '',
    `max CPU: ${maxCpuMs}ms · exceededResources: ${exceededResources}`, '', 'By status:'];
  for (const [status, s] of Object.entries(byStatus)) {
    lines.push(`- ${status}: ${s.requests} requests, max ${s.max}ms, 15-min buckets at/over limit: ${s.bucketsOverLimit}`);
  }
  lines.push('', 'time(UTC)   | status | req | subreq | p50 | p75 | p99 | max');
  for (const b of buckets) {
    lines.push(`${b.time} | ${b.status} | ${b.requests} | ${b.subrequests} | ${b.p50} | ${b.p75} | ${b.p99} | ${b.max}`
      + (b.max >= FREE_CPU_MS ? '  <-- over' : ''));
  }
  if (!buckets.length) lines.push('(no requests in this window)');
  return lines.join('\n');
}

// Error text from the API may echo identifiers; keep it short and strip the account ID.
export function safeError(message, account) {
  return String(message ?? 'unknown error').split(account).join('<account>').slice(0, 200);
}

export async function measure({token, account, hours = 24, fetchFn = fetch, now = Date.now()}) {
  const since = new Date(now - hours * 3_600_000).toISOString();
  const response = await fetchFn(ENDPOINT, {method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({query: buildQuery(), variables: {account, script: WORKER, since}})});
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    const reason = body?.errors?.map(e => e.message).join('; ') ?? `HTTP ${response.status}`;
    throw new Error(`analytics query failed: ${safeError(reason, account)}`);
  }
  return summarize(body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const {CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account} = process.env;
  const hours = Math.min(168, Math.max(1, Number(process.env.HOURS) || 24));
  if (!token || !account) { console.error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID'); process.exit(1); }
  try {
    console.log(report(await measure({token, account, hours}), hours));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
