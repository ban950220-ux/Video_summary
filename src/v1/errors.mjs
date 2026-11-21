// v1 error codes. Keep this list short: one code per user-visible outcome.
// Each code maps to an HTTP status and a Korean message shown in the UI.

export const ERRORS = Object.freeze({
  BAD_REQUEST: {status: 400, message: '요청 형식이 올바르지 않습니다.'},
  INVALID_URL: {status: 400, message: 'YouTube 영상 주소를 확인해 주세요.'},
  PAYLOAD_TOO_LARGE: {status: 413, message: '요청 용량이 너무 큽니다.'},
  UNAUTHORIZED: {status: 401, message: '본인 로그인이 필요합니다.'},
  FORBIDDEN_ORIGIN: {status: 403, message: '허용되지 않은 출처의 요청입니다.'},
  NOT_FOUND: {status: 404, message: '요청한 항목을 찾을 수 없습니다.'},
  PAID_API_BLOCKED: {status: 403, message: '유료 API 사용은 차단되어 있습니다.'},
  DAILY_LIMIT_REACHED: {status: 429, message: '오늘의 무료 사용 한도에 도달했습니다. 내일 다시 시도하세요.'},
  PROVIDER_KEY_MISSING: {status: 409, message: '설정에서 API 키를 먼저 등록하세요.'},
  PROVIDER_FAILED: {status: 502, message: '외부 서비스 응답에 실패했습니다.'},
  PROVIDER_RATE_LIMITED: {status: 429, message: '외부 서비스의 무료 사용 한도에 걸렸습니다. 잠시 후 다시 시도합니다.'},
  PROVIDER_INVALID_OUTPUT: {status: 502, message: '외부 서비스가 올바르지 않은 형식으로 응답했습니다.'},
  INVALID_TRANSCRIPT: {status: 400, message: '자막 또는 전사 파일 형식을 확인해 주세요.'},
  TRANSCRIPT_UNAVAILABLE: {
    status: 422,
    message: '이 영상의 자막·전사를 자동으로 가져오지 못했습니다. 자막 파일을 올리거나 PC 실행기를 사용하세요.',
  },
  PERSISTENCE_UNAVAILABLE: {status: 503, message: '저장소(D1)가 연결되어 있지 않습니다.'},
  INTERNAL: {status: 500, message: '알 수 없는 오류가 발생했습니다.'},
});

export class AppError extends Error {
  constructor(code, detail) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'INTERNAL';
    super(ERRORS[known].message);
    this.name = 'AppError';
    this.code = known;
    this.status = ERRORS[known].status;
    // detail is for logs/tests only and is never sent to the browser.
    this.detail = detail;
  }
}

export function toPublicError(error) {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL');
  return {
    status: appError.status,
    body: {error: {code: appError.code, message: appError.message}},
  };
}
