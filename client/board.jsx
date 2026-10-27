import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, Clock3, Maximize2, Minimize2, Pause, Play, Radio, RefreshCw, ShieldCheck, Users, WifiOff, X } from "lucide-react";
import { getLanguage, LanguageSwitcher, t, useLanguage } from "./i18n.jsx";
import BoardJoin, { boardJoinUrl } from "./board-qr.jsx";
import "./board.css";

const AUTO_PAGE_MS = 12_000;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const stamp = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const presenceOf = (participant, now) => {
  if (participant.status !== "active") return "finished";
  const lastSeen = stamp(participant.presence?.lastSeenAt);
  if (lastSeen == null || now - lastSeen >= 35_000) return "offline";
  const status = participant.presence?.status;
  return status === "active" || status === "away" ? status : "offline";
};
const duration = (value) => {
  const seconds = Math.max(0, Math.floor(finite(value)));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const time = (value) => new Date(value).toLocaleTimeString(getLanguage() === "kk" ? "kk-KZ" : "ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pageSizeFor = () => {
  // Begin with one projector row; the visible layout determines its capacity.
  if (window.innerWidth >= 1180) return 1;
  return window.innerWidth >= 760 && window.innerHeight < 850 ? 2 : 4;
};

function usePublicBoard(code, retry) {
  const [state, setState] = useState({ resourceCode: code, data: null, loading: true, connected: false, error: "", unavailable: false, receivedAt: null, offset: 0 });
  const refreshRef = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let revoked = false;
    let fetching = false;
    let pending = false;
    let stream = null;
    let streamReady = false;
    let scheduled = null;
    let controller = null;
    setState({ resourceCode: code, data: null, loading: true, connected: false, error: "", unavailable: false, receivedAt: null, offset: 0 });
    const unavailable = () => {
      if (disposed) return;
      revoked = true;
      streamReady = false;
      clearTimeout(scheduled);
      controller?.abort();
      stream?.close();
      setState({ resourceCode: code, data: null, loading: false, connected: false, error: "", unavailable: true, receivedAt: null, offset: 0 });
    };
    const load = async () => {
      scheduled = null;
      if (disposed || revoked) return;
      if (fetching) { pending = true; return; }
      fetching = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/public/boards/${encodeURIComponent(code)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal, referrerPolicy: "no-referrer" });
        if (disposed || revoked) return;
        if (response.status === 404 || response.status === 410 || response.status === 403) { unavailable(); return; }
        if (!response.ok) throw new Error("network");
        const data = await response.json();
        if (disposed || revoked) return;
        const serverNow = stamp(data.serverNow);
        setState((previous) => ({ ...previous, data, loading: false, connected: streamReady, error: "", receivedAt: Date.now(), offset: serverNow == null ? previous.offset : serverNow - Date.now() }));
      } catch (error) {
        if (!disposed && !revoked && error.name !== "AbortError") setState((previous) => ({ ...previous, loading: false, connected: false, error: "Не удалось обновить табло. Проверяем соединение…" }));
      } finally {
        fetching = false;
        if (!disposed && !revoked && pending) { pending = false; schedule(); }
      }
    };
    const schedule = () => { if (!disposed && !revoked && !scheduled) scheduled = setTimeout(load, 500); };
    refreshRef.current = load;
    if (typeof EventSource !== "undefined") {
      stream = new EventSource(`/api/public/boards/${encodeURIComponent(code)}/live`, { withCredentials: false });
      stream.addEventListener("ready", () => { if (disposed || revoked) return; streamReady = true; setState((previous) => ({ ...previous, connected: true })); schedule(); });
      stream.addEventListener("update", schedule);
      stream.addEventListener("revoked", unavailable);
      stream.addEventListener("disabled", unavailable);
      stream.onerror = () => { if (disposed || revoked) return; streamReady = false; setState((previous) => ({ ...previous, connected: false })); schedule(); };
    }
    load();
    const poll = setInterval(() => { if (!streamReady) schedule(); }, 10_000);
    const visible = () => { if (!document.hidden) schedule(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearTimeout(scheduled);
      clearInterval(poll);
      controller?.abort();
      stream?.close();
      document.removeEventListener("visibilitychange", visible);
      refreshRef.current = () => {};
    };
  }, [code, retry]);
  const visible = state.resourceCode === code ? state : { data: null, loading: true, connected: false, error: "", unavailable: false, receivedAt: null, offset: 0 };
  return { ...visible, refresh: () => refreshRef.current() };
}

function QuestionProgress({ participant }) {
  const questions = participant.questions || [];
  const currentIndex = Math.max(0, questions.findIndex((question) => question.current));
  const start = questions.length > 8 ? Math.max(0, Math.min(questions.length - 8, currentIndex - 3)) : 0;
  const visible = questions.slice(start, start + 8);
  return <div className="board-question-progress" aria-label={t("Прогресс по вопросам")}>
    <div className="board-question-dots">{start > 0 && <span className="board-question-ellipsis" aria-hidden="true">…</span>}{visible.map((question, index) => {
      const number = question.number ?? start + index + 1;
      const current = participant.status === "active" && question.current;
      const label = t(question.answerable === false ? "Страница {number}: информационный блок" : question.checked ? "Вопрос {number}: ответ зафиксирован" : current ? "Вопрос {number}: сейчас открыт" : question.answered ? "Вопрос {number}: ответ сохранён" : "Вопрос {number}: без ответа", { number });
      return <span key={number} className={`board-question-dot ${question.answerable === false ? "information" : ""} ${question.answered ? "answered" : ""} ${question.checked ? "checked" : ""} ${current ? "current" : ""}`} title={label} aria-label={label}>{number}</span>;
    })}{start + visible.length < questions.length && <span className="board-question-ellipsis" aria-hidden="true">…</span>}</div>
    {questions.length > 8 && <span className="board-question-window">{t("Страницы {from}–{to} из {total}", { from: start + 1, to: start + visible.length, total: questions.length })}</span>}
  </div>;
}

function ParticipantCard({ participant: p, now, showNames, showScores }) {
  const active = p.status === "active";
  const presence = presenceOf(p, now);
  const status = active ? presence === "active" ? "focused" : presence === "away" ? "away" : "offline" : p.status;
  const label = { focused: "Во вкладке", away: "Вне вкладки", offline: "Нет связи", submitted: "Завершено", invalidated: "Аннулировано", expired: "Время истекло" }[status] || "В работе";
  const total = Math.max(0, finite(p.answerableCount ?? p.totalQuestions ?? p.progress?.total ?? p.questions?.filter((question) => question.answerable !== false).length));
  const answered = Math.max(0, Math.min(total, finite(p.answeredCount ?? p.progress?.answered ?? p.questions?.filter((question) => question.answered).length)));
  const started = stamp(p.startedAt);
  const finished = stamp(p.finishedAt);
  const expires = stamp(p.expiresAt);
  const elapsed = started == null ? finite(p.durationSeconds) : ((active ? now : finished ?? now) - started) / 1000;
  const hasScore = showScores && ["submitted", "expired"].includes(p.status) && typeof p.score === "number" && Number.isFinite(p.score) && typeof p.maxScore === "number" && Number.isFinite(p.maxScore);
  const percent = hasScore ? p.maxScore > 0 ? Math.max(0, Math.min(100, p.score / p.maxScore * 100)) : 0 : total ? Math.round(answered / total * 100) : 0;
  const codeLabel = p.boardCode ? `#${p.boardCode}` : p.label || "—";
  const name = showNames && typeof p.name === "string" ? p.name.trim() : "";
  return <article className={`board-participant ${status}`}>
    <div className="board-participant-top"><h2 className={name ? "board-participant-name" : ""} title={name || codeLabel} aria-label={name || t("Участник #{code}", { code: p.boardCode || "—" })}>{name || codeLabel}</h2><span className={`board-status ${status}`}>{status === "submitted" ? <Check size={16} /> : status === "invalidated" ? <X size={16} /> : status === "offline" ? <WifiOff size={15} /> : <i />}{t(label)}</span></div>
    <div className={`board-progress-cell ${hasScore ? "board-score-cell" : ""}`}><div className="board-participant-progress"><span>{t(hasScore ? "Баллы" : "Ответы")}</span><strong>{hasScore ? p.score : answered}<span> / {hasScore ? p.maxScore : total}</span></strong></div>
    <div className="board-progress-track" role="progressbar" aria-label={t(hasScore ? "Итоговый результат" : "Сохранено ответов")} aria-valuenow={hasScore ? p.score : answered} aria-valuemin={0} aria-valuemax={(hasScore ? p.maxScore : total) || 1}><i style={{ width: `${percent}%` }} /></div></div>
    <QuestionProgress participant={p} />
    <dl className="board-participant-meta"><div><dt>{t("Прошло")}</dt><dd>{duration(elapsed)}</dd></div><div><dt>{t(active ? "Осталось" : "Завершение")}</dt><dd>{active ? expires == null ? "—" : duration((expires - now) / 1000) : finished == null ? "—" : new Date(finished).toLocaleTimeString(getLanguage() === "kk" ? "kk-KZ" : "ru-RU", { hour: "2-digit", minute: "2-digit" })}</dd></div><div><dt>{t("IP · маска")}</dt><dd className="board-ip">{p.maskedIp || "—"}</dd></div></dl>
  </article>;
}

export default function PublicBoard() {
  useLanguage();
  const { code } = useParams();
  const [retry, setRetry] = useState(0);
  const { data, loading, connected, error, unavailable, receivedAt, offset, refresh } = usePublicBoard(code, retry);
  const joinUrl = boardJoinUrl(data?.joinPath);
  const [localNow, setLocalNow] = useState(Date.now());
  const [pageSize, setPageSize] = useState(pageSizeFor);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const [auto, setAuto] = useState(true);
  const [identityMode, setIdentityMode] = useState("names");
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [fullscreenError, setFullscreenError] = useState(false);
  const mainRef = useRef(null);
  const participantsRef = useRef(null);
  const paginationRef = useRef(null);
  const footerRef = useRef(null);
  const pageChangedAt = useRef(Date.now());
  const now = localNow + offset;
  const participants = data?.participants || [];
  const namesAllowed = data?.presentation?.showNames === true;
  const scoresAllowed = data?.presentation?.showScores === true;
  const showNames = namesAllowed && identityMode === "names";
  const shown = participants.filter((participant) => filter === "all" || participant.status === filter);
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageParticipants = shown.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const presenceCounts = participants.reduce((counts, participant) => { const state = presenceOf(participant, now); if (state !== "finished") counts[state]++; return counts; }, { active: 0, away: 0, offline: 0 });
  const summary = { ...data?.summary, online: presenceCounts.active, away: presenceCounts.away, offline: presenceCounts.offline };
  const pollingHealthy = !connected && !error && receivedAt != null && localNow - receivedAt < 15_000;
  useEffect(() => { const interval = setInterval(() => setLocalNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  useLayoutEffect(() => {
    let frame = null;
    const measure = () => {
      frame = null;
      if (window.innerWidth < 1180) { setPageSize(pageSizeFor()); return; }
      const list = participantsRef.current;
      const pagination = paginationRef.current;
      const footer = footerRef.current;
      if (!list || !pagination || !footer) return;
      const heights = [...list.children].map((row) => row.getBoundingClientRect().height);
      const rowHeight = Math.max(0, ...heights);
      if (!rowHeight) return;
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const controls = getComputedStyle(pagination);
      const reserved = pagination.getBoundingClientRect().height
        + (parseFloat(controls.marginTop) || 0) + (parseFloat(controls.marginBottom) || 0)
        + footer.getBoundingClientRect().height
        + (parseFloat(getComputedStyle(mainRef.current).paddingBottom) || 0);
      const available = window.innerHeight - (list.getBoundingClientRect().top + window.scrollY) - reserved - 2;
      const capacity = Math.max(1, Math.min(12, Math.floor((available + gap) / (rowHeight + gap))));
      setPageSize((previous) => previous === capacity ? previous : capacity);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    for (const element of [mainRef.current, mainRef.current?.querySelector(".board-overview"),
      mainRef.current?.querySelector(".board-list-toolbar"), participantsRef.current, paginationRef.current, footerRef.current])
      if (element) observer.observe(element);
    window.addEventListener("resize", schedule);
    measure();
    return () => { if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); };
  }, [data, currentPage, filter, identityMode, joinUrl]);
  useEffect(() => { const change = () => setFullscreen(!!document.fullscreenElement); document.addEventListener("fullscreenchange", change); return () => document.removeEventListener("fullscreenchange", change); }, []);
  useEffect(() => { setPage(0); setFilter("all"); setIdentityMode("names"); pageChangedAt.current = Date.now(); }, [code]);
  useEffect(() => { if (page >= pages) setPage(pages - 1); }, [page, pages]);
  useEffect(() => { if (!auto || pages < 2 || !data || unavailable || document.hidden) return; if (localNow - pageChangedAt.current >= AUTO_PAGE_MS) { setPage((value) => (value + 1) % pages); pageChangedAt.current = localNow; } }, [localNow, auto, pages, data, unavailable]);
  const turn = (delta) => { setPage((value) => (value + delta + pages) % pages); pageChangedAt.current = Date.now(); };
  const toggleFullscreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); setFullscreenError(false); } catch { setFullscreenError(true); } };
  const stats = [["Всего участников", summary.total], ["В работе", summary.active], ["Завершили", summary.submitted], ["Аннулированы", summary.invalidated], ["Время истекло", summary.expired], ["Во вкладке", summary.online]];
  return <div className="public-board">
    <header className="board-header"><div className="board-brand">FORMA <span>{t("Лекционное табло")}</span></div><div className="board-header-tools"><time className="board-clock" dateTime={new Date(now).toISOString()}>{time(now)}</time><LanguageSwitcher />{typeof document.documentElement.requestFullscreen === "function" && <button className="board-icon-button" onClick={toggleFullscreen} aria-label={t(fullscreen ? "Выйти из полноэкранного режима" : "На весь экран")} title={t(fullscreen ? "Выйти из полноэкранного режима" : "На весь экран")} aria-pressed={fullscreen}>{fullscreen ? <Minimize2 size={22} /> : <Maximize2 size={22} />}</button>}</div></header>
    <main className="board-main" ref={mainRef}>
      {unavailable ? <section className="board-state"><ShieldCheck size={48} /><h1>{t("Табло недоступно")}</h1><p>{t("Ссылка выключена, заменена или больше не существует.")}</p><button className="board-button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={18} />{t("Проверить снова")}</button></section> : loading && !data ? <section className="board-state" role="status"><Radio className="board-loading-icon" size={48} /><h1>{t("Подключаем табло…")}</h1><p>{t("Загружаем участников и ход прохождения.")}</p></section> : !data ? <section className="board-state"><WifiOff size={48} /><h1>{t("Нет связи с табло")}</h1><p>{t("Проверьте интернет. Подключение восстановится автоматически.")}</p><button className="board-button" onClick={refresh}><RefreshCw size={18} />{t("Обновить")}</button></section> : <>
        <div className={`board-overview ${joinUrl ? "has-join" : ""}`}><div className="board-overview-main"><div className="board-title-row"><div><div className="board-eyebrow"><span className="board-live-mark">LIVE</span><span>{t({ published: "Квиз открыт", closed: "Приём закрыт", draft: "Ожидает публикации" }[data.status || data.quiz?.status] || "Ход прохождения")}</span></div><h1>{data.title || data.quiz?.title || t("Ход прохождения")}</h1></div><div className={`board-connection ${connected ? "connected" : ""}`} role="status">{connected ? <Radio size={18} /> : pollingHealthy ? <Clock3 size={18} /> : <WifiOff size={18} />}<span>{t(connected ? "Обновляется в реальном времени" : pollingHealthy ? "Обновление каждые 10 секунд" : "Восстанавливаем связь…")}{!connected && receivedAt && <small>{t("Последнее обновление: {seconds} сек. назад", { seconds: Math.max(0, Math.floor((localNow - receivedAt) / 1000)) })}</small>}</span></div></div>
        {(error || fullscreenError) && <p className="board-notice" role="status">{t(fullscreenError ? "Полноэкранный режим недоступен в этом браузере." : error)}</p>}
        <section className="board-stats" aria-label={t("Статистика прохождения")}>{stats.map(([label, value]) => <div className="board-stat" key={label}><span>{t(label)}</span><strong>{finite(value)}</strong></div>)}</section>
        </div>{joinUrl && <BoardJoin url={joinUrl} closed={(data.status || data.quiz?.status) === "closed"} />}</div>
        <div className="board-list-toolbar"><div className="board-toolbar-left"><h2><Users size={21} />{t("Участники")}</h2><label className="board-filter"><span className="sr-only">{t("Показать участников")}</span><select aria-label={t("Показать участников")} value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); pageChangedAt.current = Date.now(); }}>{[["all", "Все статусы"], ["active", "В работе"], ["submitted", "Завершили"], ["invalidated", "Аннулированы"], ["expired", "Время истекло"]].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></div><div className="board-toolbar-right">{namesAllowed && <div className="board-identity-switch" role="group" aria-label={t("Отображение участников")}>{[["names", "Имена"], ["codes", "Коды"]].map(([value, label]) => <button key={value} type="button" aria-pressed={identityMode === value} onClick={() => setIdentityMode(value)}>{t(label)}</button>)}</div>}<div className="board-presence-summary"><span><i className="board-away-dot" />{t("Вне вкладки: {count}", { count: finite(summary.away) })}</span><span><i className="board-offline-dot" />{t("Нет связи: {count}", { count: finite(summary.offline) })}</span></div></div></div>
        {!shown.length ? <section className="board-empty"><Users size={42} /><h2>{t(participants.length ? "Участников с таким статусом пока нет" : "Ожидаем участников")}</h2><p>{t(participants.length ? "Выберите другой статус, чтобы увидеть остальные работы." : "Когда участники начнут квиз, они появятся здесь автоматически.")}</p></section> : <section className="board-participants" ref={participantsRef} aria-label={t("Ход прохождения участников")}>{pageParticipants.map((participant) => <ParticipantCard key={participant.boardCode || participant.label} participant={participant} now={now} showNames={showNames} showScores={scoresAllowed} />)}</section>}
        <div className="board-pagination" ref={paginationRef}><div className="board-question-legend"><span><i className="answered" />{t("Ответ сохранён")}</span><span><i className="checked" />{t("Ответ зафиксирован")}</span><span><i className="current" />{t("Сейчас открыт")}</span><span><i />{t("Без ответа")}</span><span><i className="information" />{t("Информационный блок")}</span></div>{pages > 1 && <div className="board-page-controls"><button className="board-auto-button" aria-pressed={auto} onClick={() => { setAuto((value) => !value); pageChangedAt.current = Date.now(); }}>{auto ? <Pause size={16} /> : <Play size={16} />}{t("Автосмена")}</button><button className="board-icon-button" onClick={() => turn(-1)} aria-label={t("Предыдущая страница")}><ChevronLeft size={20} /></button><span>{currentPage + 1} / {pages}</span><button className="board-icon-button" onClick={() => turn(1)} aria-label={t("Следующая страница")}><ChevronRight size={20} /></button></div>}</div>
      </>}
    </main>
    <footer className="board-footer" ref={footerRef}><span><ShieldCheck size={16} />{t("IP маскируются. Имена и баллы — по настройкам автора. Ответы и ключи скрыты.")}</span><span className="board-footer-note"><Clock3 size={15} />{t("Время на экране обновляется автоматически")}</span></footer>
  </div>;
}
