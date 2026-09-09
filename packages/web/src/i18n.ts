// Minimal en/ko i18n. No library, no routing, no SEO: a reactive dictionary
// switched client-side. All UI strings live here; user data (titles) and API
// error messages are never translated.
import { createSignal } from "solid-js";

export type Locale = "en" | "ko";
export const LOCALES: readonly Locale[] = ["en", "ko"];

const en = {
  status: {
    todo: "Todo",
    doing: "Doing",
    done: "Done",
    archive: "Archive",
  },
  untitled: "Untitled",
  localeToggle: {
    label: "KO",
    title: "한국어로 전환",
  },
  home: {
    titlePlaceholder: "New project title…",
    newProject: "New project",
    recent: "Recent",
  },
  board: {
    reconnecting: "Reconnecting…",
    loading: "Loading…",
    invalidLink: "This link is invalid.",
    createNewProject: "Create new project",
    loadFailed: "Failed to load. Check your connection.",
    retry: "Retry",
    renameProject: "Rename project",
    copyLink: "Copy link",
    copied: "Copied",
  },
  column: {
    add: "+ Add",
    newTodoPlaceholder: "New todo, Enter to add…",
  },
  hud: {
    new: "new",
    board: "board",
    edit: "edit",
    move: "move",
    column: "column",
    reorder: "reorder",
    archive: "archive",
    delete: "delete",
    save: "save",
    cancel: "cancel",
  },
};

export type Dict = typeof en;

const ko: Dict = {
  status: {
    todo: "할 일",
    doing: "진행 중",
    done: "완료",
    archive: "보관",
  },
  untitled: "제목 없음",
  localeToggle: {
    label: "EN",
    title: "Switch to English",
  },
  home: {
    titlePlaceholder: "새 프로젝트 이름…",
    newProject: "새 프로젝트",
    recent: "최근",
  },
  board: {
    reconnecting: "다시 연결 중…",
    loading: "불러오는 중…",
    invalidLink: "유효하지 않은 링크입니다.",
    createNewProject: "새 프로젝트 만들기",
    loadFailed: "불러오지 못했습니다. 연결을 확인하세요.",
    retry: "다시 시도",
    renameProject: "프로젝트 이름 바꾸기",
    copyLink: "링크 복사",
    copied: "복사됨",
  },
  column: {
    add: "+ 추가",
    newTodoPlaceholder: "새 할 일, Enter로 추가…",
  },
  hud: {
    new: "새로 만들기",
    board: "보드 진입",
    edit: "편집",
    move: "이동",
    column: "열 이동",
    reorder: "순서 변경",
    archive: "보관",
    delete: "삭제",
    save: "저장",
    cancel: "취소",
  },
};

const dicts: Record<Locale, Dict> = { en, ko };

/** Exported for the parity test: every locale must share en's key shape. */
export const dictionaries: Record<Locale, Dict> = dicts;
const STORAGE_KEY = "todo.locale";

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ko") return stored;
  } catch {
    // Private mode: fall through to navigator detection.
  }
  try {
    if (navigator.language.toLowerCase().startsWith("ko")) return "ko";
  } catch {
    // Non-browser (SSR/tests without navigator): fall through.
  }
  return "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(detectLocale());
if (typeof document !== "undefined") {
  document.documentElement.lang = locale();
}

export { locale };

export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Persistence is a nicety; the switch itself always applies.
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
  setLocaleSignal(next);
}

/** Reactive dictionary accessor. Call as `t().board.retry` inside JSX. */
export function t(): Dict {
  return dicts[locale()];
}
