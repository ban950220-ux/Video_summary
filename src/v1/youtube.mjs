import {AppError} from './errors.mjs';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Accepts watch, youtu.be, shorts and live links. Returns the video ID and a canonical URL.
export function parseYouTubeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new AppError('INVALID_URL');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('INVALID_URL');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(host)) {
    throw new AppError('INVALID_URL');
  }
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else if (/^\/(shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split('/')[2];
  if (!id || !VIDEO_ID.test(id)) throw new AppError('INVALID_URL');
  return {videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`};
}

export function watchUrlAt(videoId, seconds) {
  if (!VIDEO_ID.test(videoId)) throw new AppError('INVALID_URL');
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://www.youtube.com/watch?v=${videoId}&t=${t}s`;
}
