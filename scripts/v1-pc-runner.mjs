// v1 PC runner: takes a job waiting for the PC, downloads its audio, transcribes it with Groq Whisper
// (free tier) and uploads the transcript. The cloud then summarizes it as usual.
//
// Run on the owner's PC (Node 24, yt-dlp and ffmpeg on PATH or given below):
//   set V1_SITE=https://holy-rice-b914.ban950220.workers.dev
//   set CF_ACCESS_CLIENT_ID=...   (PC runner service token, not the tester token)
//   set CF_ACCESS_CLIENT_SECRET=...
//   set GROQ_API_KEY=...
//   node scripts/v1-pc-runner.mjs           (one job)   |   node scripts/v1-pc-runner.mjs --watch
// Optional: YTDLP, FFMPEG (executable paths), V1_WORK_DIR (temp folder).
//
// The owner confirmed rights for each job when creating it. Secrets stay in environment variables only.
import {spawn} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {markRepeats, whisperFlags} from '../src/v1/uncertainty.mjs';

export const CHUNK_SEC = 600;
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

export function ytDlpArgs(url, outDir) {
  return ['--no-playlist', '--no-config', '--no-part', '--no-cookies-from-browser', '-f', 'bestaudio/best',
    '-o', join(outDir, 'source.%(ext)s'), '--', url];
}

export function ffmpegArgs(input, outDir) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
    '-b:a', '32k', '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-reset_timestamps', '1',
    join(outDir, 'chunk%03d.mp3')];
}

// Groq verbose_json segments (seconds within the chunk) -> transcript segments on the video timeline.
export function whisperToSegments(response, chunkIndex) {
  const offset = chunkIndex * CHUNK_SEC;
  return (response?.segments ?? [])
    .filter(s => typeof s.text === 'string' && s.text.trim())
    .map(s => ({startMs: Math.round((offset + Number(s.start)) * 1000),
      endMs: Math.round((offset + Number(s.end)) * 1000), text: s.text.trim(), flags: whisperFlags(s)}));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell: false, windowsHide: true});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${command} exit ${code}: ${stderr}`))));
  });
}

async function api(config, path, body) {
  const response = await fetch(`${config.site}/api/v1/${path}`, {method: 'POST', headers: {
    'content-type': 'application/json', origin: config.site, 'CF-Access-Client-Id': config.clientId,
    'CF-Access-Client-Secret': config.clientSecret}, body: JSON.stringify(body ?? {})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} ${response.status} ${data?.error?.code ?? ''}`);
  return data;
}

async function transcribeChunk(config, file, prompt) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(file)], {type: 'audio/mpeg'}), 'chunk.mp3');
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt.slice(0, 600));
    const response = await fetch(GROQ_URL, {method: 'POST', body: form,
      headers: {authorization: `Bearer ${config.groqKey}`}});
    if (response.ok) return response.json();
    // Free-tier limits: wait as told (max 2 retries), as in the approved retry policy.
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const wait = Math.min(60, Number(response.headers.get('retry-after')) || 20 * attempt);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      continue;
    }
    throw new Error(`groq ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  throw new Error('groq retries exhausted');
}

export async function processOne(config) {
  const {job} = await api(config, 'runner/next');
  if (!job) return null;
  const dir = mkdtempSync(join(config.workDir, 'v1-run-'));
  console.log(`job ${job.id}: ${job.url}`);
  try {
    await run(config.ytdlp, ytDlpArgs(job.url, dir));
    const source = readdirSync(dir).find(name => name.startsWith('source.'));
    if (!source) throw new Error('yt-dlp produced no audio');
    await run(config.ffmpeg, ffmpegArgs(join(dir, source), dir));
    const chunks = readdirSync(dir).filter(name => /^chunk\d{3}\.mp3$/.test(name)).sort();
    const segments = [];
    let language = null;
    for (const [index, name] of chunks.entries()) {
      console.log(`  chunk ${index + 1}/${chunks.length}`);
      const result = await transcribeChunk(config, join(dir, name), job.title ?? '');
      language ??= result.language ?? null;
      segments.push(...whisperToSegments(result, index));
    }
    const durationSec = segments.length ? Math.max(...segments.map(s => s.endMs)) / 1000 : null;
    const uploaded = await api(config, `runner/jobs/${job.id}/transcript`, {segments: markRepeats(segments), language,
      durationSec, engine: `groq ${WHISPER_MODEL}`});
    console.log(`  uploaded ${segments.length} segments, uncertain ${uploaded.uncertainSegments}`);
    return job.id;
  } catch (error) {
    const detail = String(error?.message ?? error).replace(/Bearer\s+\S+/g, '[masked]').slice(0, 240);
    await api(config, `runner/jobs/${job.id}/fail`, {code: 'PC_RUNNER_FAILED', detail}).catch(() => {});
    console.error(`  failed: ${detail}`);
    return job.id;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

export function configFromEnv(env = process.env) {
  const config = {site: (env.V1_SITE ?? '').replace(/\/$/, ''), clientId: env.CF_ACCESS_CLIENT_ID,
    clientSecret: env.CF_ACCESS_CLIENT_SECRET, groqKey: env.GROQ_API_KEY, ytdlp: env.YTDLP || 'yt-dlp',
    ffmpeg: env.FFMPEG || 'ffmpeg', workDir: env.V1_WORK_DIR || tmpdir()};
  const missing = ['site', 'clientId', 'clientSecret', 'groqKey'].filter(key => !config[key]);
  if (missing.length) throw new Error(`missing settings: ${missing.join(', ')}`);
  if (!/^https:\/\//.test(config.site)) throw new Error('V1_SITE must start with https://');
  return config;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = configFromEnv();
  const watch = process.argv.includes('--watch');
  do {
    const done = await processOne(config);
    if (!done && watch) await new Promise(resolve => setTimeout(resolve, 60_000));
    if (!done && !watch) console.log('no waiting job');
  } while (watch);
}
