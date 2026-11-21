const reviewPath = '/api/text-review-summaries';
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function isTextReview(review) {
  return uuidPattern.test(review?.id) &&
    review.textReviewStatus === 'TEXT_CORRECTED_SOURCE_COMPARED_ASR_ONLY' &&
    review.audioVerified === false && review.ownerConfirmed === false &&
    review.summaryVerified === false && review.workflowComplete === false;
}

export function mountTextReviewPanel({ host, api, isCurrent, document: dom }) {
  function element(tag, text) {
    const node = dom.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text) {
    const node = element('button', text);
    node.type = 'button';
    node.className = 'btn secondary small';
    return node;
  }

  const status = element('p');
  status.setAttribute('role', 'status');
  const list = element('div');
  const detail = element('div');
  const refresh = button('교정본 목록 새로고침');
  const cancel = button('교정본 조회 취소');
  const actions = element('div');
  actions.className = 'library-actions';
  cancel.hidden = true;
  actions.append(refresh, cancel);
  const scope = element('p', '전사 텍스트 대조 기록입니다. 원음과 요약 정확성은 미검증 상태입니다.');
  scope.className = 'tip';
  host.append(element('h3', '텍스트 검토 교정본'), scope, actions, status, list, detail);
  let active;

  async function read(path, message, render) {
    if (!isCurrent()) return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    status.textContent = message;
    cancel.hidden = false;
    const timer = setTimeout(() => controller.abort('timeout'), 12000);
    try {
      const result = await api(path, { signal: controller.signal });
      if (active === controller && isCurrent() && !controller.signal.aborted) render(result);
    } catch {
      if (active === controller && isCurrent() && !controller.signal.aborted) {
        status.textContent = '교정본을 불러오지 못했습니다. 로그인이나 저장소 상태를 확인해 주세요.';
      }
    } finally {
      clearTimeout(timer);
      if (active === controller) {
        active = undefined;
        if (isCurrent()) {
          cancel.hidden = true;
          if (controller.signal.reason === 'timeout') status.textContent = '교정본 조회 시간이 초과됐습니다.';
        }
      }
    }
  }

  function open(id) {
    detail.replaceChildren();
    return read(reviewPath + '/' + id, '교정본 본문을 확인 중입니다…', ({ review }) => {
      if (!isTextReview(review) || review.id !== id || typeof review.text !== 'string') {
        throw Error('INVALID_REVIEW');
      }
      const counts = ['확인됨', '불일치', '불명확', '근거없음']
        .map(verdict => verdict + ' ' + review.claimVerdicts[verdict] + '건').join(' · ');
      const exportLink = element('a', '교정본 TXT 내보내기');
      exportLink.className = 'btn secondary small';
      exportLink.href = reviewPath + '/' + id + '/export';
      exportLink.download = 'corrected-review.txt';
      detail.replaceChildren(
        element('h4', review.title),
        element('p', review.reviewedSourceCount + '구간 · 주장 ' + review.reviewedClaimCount + '건 · 원음 미검증'),
        element('p', counts),
        element('pre', review.text),
        exportLink,
      );
      status.textContent = '교정본을 열었습니다.';
    });
  }

  function load() {
    list.replaceChildren();
    detail.replaceChildren();
    return read(reviewPath, '교정본 목록을 확인 중입니다…', ({ reviews }) => {
      if (!Array.isArray(reviews) || !reviews.every(isTextReview)) throw Error('INVALID_REVIEW_LIST');
      for (const review of reviews) {
        const entry = button('교정본 다시 열기 · ' + review.videoId);
        entry.onclick = () => open(review.id);
        list.append(entry);
      }
      status.textContent = reviews.length ? '교정본 ' + reviews.length + '건' : '저장된 교정본이 없습니다.';
    });
  }

  refresh.onclick = load;
  cancel.onclick = () => {
    const request = active;
    active = undefined;
    request?.abort();
    cancel.hidden = true;
    status.textContent = '교정본 조회를 취소했습니다.';
  };
  void load();
}
