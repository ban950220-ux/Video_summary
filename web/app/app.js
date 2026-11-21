// v1 PWA: hash routes #new, #library, #legacy, #settings, #job/<id>.
import {date, h, toast} from './dom.js';
import {ERROR_TEXT, renderResult} from './result.js';

const view = document.getElementById('view');
const POLL_MS = 3000;
let pollTimer = null;

async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch(path, {method, credentials: 'same-origin',
    headers: body || method !== 'GET' ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `요청 실패 (${response.status})`);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

function show(...nodes) {
  view.replaceChildren(...nodes.flat());
}

function newView() {
  const url = h('input', {type: 'url', name: 'url', required: true, placeholder: 'https://www.youtube.com/watch?v=…',
    'aria-label': 'YouTube 주소'});
  const geminiOnly = h('input', {type: 'checkbox', name: 'geminiOnly'});
  const geminiLabel = h('label', {class: 'muted check'}, geminiOnly,
    ' 기존 자막 건너뛰고 Gemini로 전사 (시험용, 무료 한도에서 영상 길이만큼 사용)');
  const pcMode = h('input', {type: 'checkbox', name: 'pcMode'});
  const pcLabel = h('label', {class: 'muted check'}, pcMode,
    ' PC 실행기로 전사 (내 PC에서 음성을 받아 Groq Whisper로 전사, 권리가 있는 영상만)');
  geminiOnly.addEventListener('change', () => { if (geminiOnly.checked) pcMode.checked = false; });
  pcMode.addEventListener('change', () => { if (pcMode.checked) geminiOnly.checked = false; });
  const submit = h('button', {type: 'submit'}, '요약 시작');
  const urlForm = h('form', {id: 'url-form', onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      if (pcMode.checked && !confirm('YouTube 영상의 음성을 내 PC로 내려받는 것은 YouTube 이용약관에 걸릴 수 있습니다.\n'
        + '이 영상에 대한 권리가 있거나 허용된 범위에서만 사용하는 것이 맞습니까?')) {
        submit.disabled = false;
        return;
      }
      const mode = pcMode.checked ? {transcriptMode: 'pc', rightsConfirmed: true}
        : geminiOnly.checked ? {transcriptMode: 'gemini'} : {};
      const body = {url: url.value.trim(), ...mode};
      const {job, reused} = await api('/api/v1/jobs', {method: 'POST', body});
      if (reused) toast('이미 요약한 영상이라 기존 결과를 엽니다.');
      location.hash = `#job/${job.id}`;
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  }}, url, geminiLabel, pcLabel, submit);

  const file = h('input', {type: 'file', accept: '.srt,.vtt,.txt', 'aria-label': '자막 파일'});
  const fileUrl = h('input', {type: 'url', placeholder: '영상 주소 (선택)', 'aria-label': '영상 주소 (선택)'});
  const title = h('input', {type: 'text', placeholder: '제목 (선택)', maxlength: 300, 'aria-label': '제목 (선택)'});
  const upload = h('button', {type: 'submit', class: 'secondary'}, '자막 파일로 요약');
  const uploadForm = h('form', {id: 'upload-form', onsubmit: async event => {
    event.preventDefault();
    const picked = file.files?.[0];
    if (!picked) return toast('자막 파일을 선택하세요.');
    if (picked.size > 2_000_000) return toast('파일이 너무 큽니다 (2MB 이하).');
    upload.disabled = true;
    try {
      const {job} = await api('/api/v1/jobs/upload', {method: 'POST', body: {filename: picked.name,
        text: await picked.text(), url: fileUrl.value.trim() || null, title: title.value.trim() || null}});
      location.hash = `#job/${job.id}`;
    } catch (error) {
      toast(error.message);
      upload.disabled = false;
    }
  }}, file, fileUrl, title, upload);

  show(
    h('section', {class: 'card'}, h('h1', {}, '새 요약'),
      h('p', {class: 'muted'}, 'YouTube 주소를 넣으면 자막·전사를 확보해 핵심 결론과 챕터를 만듭니다. 무료 범위에서만 처리합니다.'),
      urlForm),
    h('section', {class: 'card'}, h('h2', {}, '자막 파일로 요약'),
      h('p', {class: 'muted'}, '자동으로 가져오지 못한 영상은 SRT·VTT·TXT 파일을 올리세요.'), uploadForm),
  );
}

async function jobView(id) {
  const render = async () => {
    const detail = await api(`/api/v1/jobs/${encodeURIComponent(id)}`);
    show(renderResult(detail, {onCrossCheck: async () => {
      try {
        await api(`/api/v1/jobs/${encodeURIComponent(id)}/crosscheck`, {method: 'POST', body: {}});
        await render();
      } catch (error) {
        toast(error.message);
      }
    }, onAnalyze: async () => {
      try {
        await api(`/api/v1/jobs/${encodeURIComponent(id)}/analysis`, {method: 'POST', body: {}});
        await render();
      } catch (error) {
        toast(error.message);
      }
    }, onDelete: async () => {
      if (!confirm('이 요약을 삭제할까요?')) return;
      await api(`/api/v1/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'});
      toast('삭제했습니다.');
      location.hash = '#library';
    }}));
    const busy = !['DONE', 'FAILED'].includes(detail.job.status) || detail.summary?.analysis?.status === 'RUNNING'
      || detail.summary?.crossCheck?.status === 'RUNNING';
    if (busy) pollTimer = setTimeout(() => render().catch(fail), POLL_MS);
  };
  await render();
}

async function libraryView() {
  const list = h('ul', {class: 'list', id: 'library-list'});
  const search = h('input', {type: 'search', placeholder: '제목 또는 영상 ID 검색', 'aria-label': '검색'});
  const load = async () => {
    const {jobs} = await api(`/api/v1/jobs?q=${encodeURIComponent(search.value.trim())}`);
    list.replaceChildren(...(jobs.length ? jobs.map(job => h('li', {}, h('a', {href: `#job/${job.id}`},
      h('span', {}, job.title ?? job.videoId ?? job.id), h('span', {class: `badge status-${job.status}`},
        job.status)))) : [h('li', {class: 'muted'}, '저장된 요약이 없습니다.')]));
  };
  search.addEventListener('input', () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(() => load().catch(fail), 300);
  });
  show(h('section', {class: 'card'}, h('h1', {}, '라이브러리'), search, list));
  await load();
}

function legacySourceItem(source) {
  const button = h('button', {type: 'button', class: 'secondary', onclick: async () => {
    button.disabled = true;
    try {
      const {job} = await api('/api/v1/jobs/from-legacy', {method: 'POST', body: {legacyJobId: source.legacyJobId}});
      location.hash = `#job/${job.id}`;
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }}, '이 전사로 v1 요약');
  const label = source.title ?? source.videoId ?? (source.sourceType === 'audio' ? 'MP3 업로드 전사' : source.legacyJobId);
  return h('li', {class: 'row'}, h('span', {}, label), h('span', {class: 'muted'},
    `${date(source.createdAt)} · ${Math.round(source.bytes / 1024)}KB`), button);
}

async function legacyView() {
  const [{jobs}, {sources}] = await Promise.all([api('/api/jobs?limit=50'), api('/api/v1/legacy-sources')]);
  show(h('section', {class: 'card'}, h('h1', {}, '저장된 기존 전사'),
    h('p', {class: 'muted'}, 'v0.7에서 전사해 둔 원문입니다. 다시 전사하지 않고 v1으로 요약할 수 있습니다.'),
    h('ul', {class: 'list', id: 'legacy-sources'}, sources.length ? sources.map(legacySourceItem)
      : h('li', {class: 'muted'}, '저장된 전사가 없습니다.'))),
  h('section', {class: 'card'}, h('h1', {}, '이전 보고서 (v0.7)'),
    h('p', {class: 'muted'}, '기존 앱에서 만든 보고서입니다. 읽기 전용이며 열면 기존 화면으로 이동합니다.'),
    h('ul', {class: 'list', id: 'legacy-list'}, jobs.length ? jobs.map(job => h('li', {}, h('a', {href: '/#library'},
      h('span', {}, job.title ?? job.video_id ?? job.id), h('span', {class: 'muted'}, date(job.created_at)))))
      : h('li', {class: 'muted'}, '이전 보고서가 없습니다.'))));
}

async function settingsView() {
  const [{usage, keys}, health] = await Promise.all([api('/api/v1/usage'), api('/api/v1/health')]);
  const LABEL = {supadataCalls: 'Supadata 자막 조회', geminiCalls: 'Gemini 호출', geminiVideoSeconds: 'Gemini 영상(초)',
    groqCalls: 'Groq 호출'};
  show(
    h('section', {class: 'card'}, h('h1', {}, '설정'),
      h('p', {}, health.paidApiAllowed ? '유료 API 허용' : '유료 API 차단됨 (무료 전용)'),
      h('p', {class: health.liveProvidersEnabled ? '' : 'warn'}, health.liveProvidersEnabled
        ? '외부 서비스 호출 사용 중' : '외부 서비스 호출이 꺼져 있습니다 (자막 업로드만 가능).')),
    h('section', {class: 'card', id: 'keys'}, h('h2', {}, 'API 키 등록 상태'),
      h('ul', {}, Object.entries(keys).map(([name, ok]) => h('li', {}, `${name}: ${ok ? '등록됨' : '없음'}`))),
      h('p', {class: 'muted'}, '키 등록·교체는 ', h('a', {href: '/#settings'}, '기존 설정 화면'), '에서 합니다. 키 값은 표시하지 않습니다.')),
    h('section', {class: 'card', id: 'usage'}, h('h2', {}, `오늘 사용량 (${usage.day}, UTC)`),
      usage.items.map(item => h('div', {}, h('p', {class: 'muted'}, `${LABEL[item.key] ?? item.key}: ${item.used} / `
        + `${item.limit}`), h('div', {class: 'meter'}, meterBar(item.used, item.limit))))),
  );
}

// CSSOM width (not a style attribute) so the site CSP `style-src 'self'` allows it.
function meterBar(used, limit) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, limit ? (used / limit) * 100 : 0)}%`;
  return bar;
}

function fail(error) {
  show(h('section', {class: 'card'}, h('h1', {}, '불러오지 못했습니다'),
    h('p', {}, ERROR_TEXT[error.code] ?? error.message)));
}

async function route() {
  clearTimeout(pollTimer);
  const hash = location.hash.slice(1) || 'new';
  const tab = hash.startsWith('job/') ? 'library' : hash;
  for (const link of document.querySelectorAll('[data-tab]')) link.classList.toggle('active', link.dataset.tab === tab);
  try {
    if (hash.startsWith('job/')) await jobView(hash.slice(4));
    else if (hash === 'library') await libraryView();
    else if (hash === 'legacy') await legacyView();
    else if (hash === 'settings') await settingsView();
    else newView();
  } catch (error) {
    fail(error);
  }
}

window.addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', {scope: './'}).catch(() => {});
