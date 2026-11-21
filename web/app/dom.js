// Tiny DOM helpers. All data is inserted as text (never innerHTML), so titles, summaries
// and transcript lines cannot inject markup.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clock(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function watchUrl(videoId, ms) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '') || !Number.isFinite(ms)) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(ms / 1000)}s`;
}

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

export function date(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', {dateStyle: 'medium', timeStyle: 'short'});
}
