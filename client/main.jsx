import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  LayoutGrid,
  Settings,
  BarChart3,
  LogOut,
  Search,
  MoreHorizontal,
  Copy,
  Trash2,
  Pencil,
  Link2,
  Clock3,
  ShieldCheck,
  ShieldAlert,
  Users,
  FileText,
  ImagePlus,
  Download,
  LockKeyhole,
  CheckCircle2,
  Circle,
  Save,
  Eye,
  Menu,
  AlertTriangle,
  RefreshCw,
  WifiOff,
  Maximize2,
  ListChecks,
  GripVertical,
  ExternalLink,
  BookOpen,
  Info,
  CheckSquare,
  Square,
  LoaderCircle,
  Radio,
  ClipboardList,
} from "lucide-react";
import "./styles.css";
const SurveyList = lazy(() => import("./surveys.jsx").then((module) => ({ default: module.SurveyList })));
const SurveyEditor = lazy(() => import("./surveys.jsx").then((module) => ({ default: module.SurveyEditor })));
const SurveyReport = lazy(() => import("./surveys.jsx").then((module) => ({ default: module.SurveyReport })));
const SurveyResponsePage = lazy(() => import("./surveys.jsx").then((module) => ({ default: module.SurveyResponsePage })));
const PublicSurvey = lazy(() => import("./surveys.jsx").then((module) => ({ default: module.PublicSurvey })));
const QuizAttemptPage = lazy(() => import("./quiz-response.jsx"));
import {
  LanguageProvider,
  useLanguage,
  LanguageSwitcher,
  t,
  getLanguage,
} from "./i18n.jsx";
const uid = () => crypto.randomUUID();
const utc = (value) =>
  value
    ? new Date(value).toLocaleString(
        getLanguage() === "kk" ? "kk-KZ" : "ru-RU",
        {
          timeZone: "UTC",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        },
      ) + " UTC"
    : "—";
const date = (value) =>
  value
    ? new Date(value).toLocaleDateString(
        getLanguage() === "kk" ? "kk-KZ" : "ru-RU",
        {
          day: "numeric",
          month: "short",
        },
      )
    : "—";
const duration = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const seconds = Math.max(0, Math.floor(n));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const statusLabel = {
  draft: "Черновик",
  published: "Опубликован",
  closed: "Закрыт",
  active: "Проходит",
  submitted: "Завершён",
  expired: "Время истекло",
  invalidated: "Аннулирован",
};
const typeLabels = {
  single: "Один ответ",
  multiple: "Несколько ответов",
  short: "Короткий ответ",
  matching: "Соответствие",
  content: "Инфостраница",
  truefalse: "Верно / неверно",
  number: "Числовой ответ",
  ordering: "Порядок элементов",
};
const defaults = {
  requireName: true,
  rosterEnabled: false,
  requireStudentCode: true,
  timeLimitMinutes: 0,
  deadline: null,
  antiCheat: false,
  oneAttemptPerIp: false,
  maxWarnings: 3,
  shuffleQuestions: true,
  shuffleOptions: true,
  showScore: true,
  showCorrectAnswersAfterTest: false,
  feedbackMode: "end",
  blockPaste: false,
};
async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body || (options.method && options.method !== "GET")
          ? {
              "Content-Type": "application/json",
            }
          : {}),
        ...(options.method && options.method !== "GET"
          ? {
              "X-Quiz-Request": "1",
            }
          : {}),
        ...options.headers,
      },
      ...(options.body && typeof options.body !== "string"
        ? {
            body: JSON.stringify(options.body),
          }
        : {}),
    });
  } catch {
    const e = new Error(
      "Нет связи с сервером. Проверьте подключение и повторите.",
    );
    e.network = true;
    throw e;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(
      payload.error || `Не удалось выполнить запрос (${response.status})`,
    );
    e.status = response.status;
    throw e;
  }
  return payload;
}
function useAdminLive(refresh, quizId, resourceId) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setConnected(false);
    let disposed = false;
    let stream;
    let streamReady = false;
    let timer;
    let fetching = false;
    let pending = false;
    const run = async () => {
      timer = null;
      if (disposed) return;
      if (fetching) {
        pending = true;
        return;
      }
      fetching = true;
      try {
        await refreshRef.current();
      } finally {
        fetching = false;
        if (!disposed && pending) {
          pending = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (!disposed && !timer) timer = setTimeout(run, 600);
    };
    const update = (event) => {
      if (quizId) {
        try {
          const data = JSON.parse(event.data);
          const changedId = data.quizId || data.surveyId;
          if (changedId && changedId !== quizId) return;
        } catch {}
      }
      schedule();
    };
    if (typeof EventSource !== "undefined") {
      stream = new EventSource("/api/admin/live");
      stream.addEventListener("ready", () => {
        streamReady = true;
        setConnected(true);
        schedule();
      });
      stream.addEventListener("update", update);
      stream.onerror = () => {
        streamReady = false;
        setConnected(false);
      };
    }
    run();
    const poll = setInterval(() => {
      if (!streamReady) schedule();
    }, 10000);
    const clock = setInterval(() => setNow(Date.now()), 5000);
    const visible = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      stream?.close();
      clearTimeout(timer);
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [quizId, resourceId]);
  return { connected, now };
}
const presenceStatus = (attempt, now) => {
  if (attempt.status !== "active") return "finished";
  const seen = Date.parse(attempt.presence?.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen > 35000) return "offline";
  return attempt.presence?.status === "away" ? "away" : "active";
};
const presenceLabel = {
  active: "Во вкладке",
  away: "Вне вкладки",
  offline: "Нет связи",
  finished: "Завершено",
};
const actionLabels = {
  start: "Начало попытки",
  rules_accepted: "Правила приняты",
  presence: "Обновление присутствия",
  heartbeat: "Обновление присутствия",
  question: "Переход к вопросу",
  answers: "Ответы сохранены",
  answer: "Ответы сохранены",
  check: "Ответ проверен",
  visibility: "Уход со страницы",
  hidden: "Уход со страницы",
  blur: "Потеря фокуса окна",
  focus: "Возврат во вкладку",
  visible: "Возврат во вкладку",
  leave: "Страница закрыта",
  paste: "Вставка из буфера",
  fullscreen: "Выход из полного экрана",
  submit: "Отправка ответов",
  submitted: "Отправка ответов",
  retake_granted: "Пересдача разрешена",
  retake_started: "Начало пересдачи",
  expired: "Время истекло",
  invalidated: "Попытка аннулирована",
  submitted_survey: "Ответы отправлены",
};
function PresenceBadge({ attempt, now }) {
  const status = presenceStatus(attempt, now);
  return (
    <span className={`presence-badge ${status}`}>
      <i />{t(presenceLabel[status])}
    </span>
  );
}
function LiveConnection({ connected }) {
  return (
    <span className={`live-connection ${connected ? "connected" : ""}`} role="status">
      {connected ? <span className="live-dot" /> : <RefreshCw size={14} />}
      {t(connected ? "Обновляется в реальном времени" : "Обновление каждые 10 секунд")}
    </span>
  );
}
function AttemptProgress({ attempt }) {
  const presence = attempt.presence || {};
  const questions = attempt.questions || [];
  const total = presence.totalQuestions ?? questions.filter((q) => q.type !== "content").length;
  const questionIndex = questions.findIndex((q) => q.id === presence.questionId);
  const questionNumber = presence.questionNumber ?? (questionIndex >= 0 ? questionIndex + 1 : null);
  return (
    <div className="attempt-progress">
      <span>{t("Ответов: {count} / {total}", { count: presence.answeredCount || 0, total })}</span>
      {questionNumber != null && <small>{t("Сейчас: страница {number}", { number: questionNumber })}</small>}
    </div>
  );
}
function LiveParticipants({ participants, connected, now, loading, error, onSelect, onDelete, showQuiz = false }) {
  return (
    <section className="panel live-participants">
      <div className="section-heading">
        <div>
          <h2>{t("Сейчас проходят")} <span className="count-pill">{participants.length}</span></h2>
          <p className="muted">{t("Вкладка, прогресс и последние действия участников.")}</p>
        </div>
        <LiveConnection connected={connected} />
      </div>
      <p className="live-explainer">{t("Статус показывает связь и фокус браузера. Без сигнала более 35 секунд — «Нет связи».")}</p>
      {error && <div className="inline-alert" role="status">{t(error)}</div>}
      {loading ? <Loading /> : !participants.length ? (
        <p className="live-empty">{t("Сейчас никто не проходит квизы.")}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>{t("Участник")}</th>
              {showQuiz && <th>{t("Квиз")}</th>}
              <th>{t("Присутствие")}</th>
              <th>{t("Прогресс")}</th>
              <th>{t("Предупреждения")}</th>
              <th>{t("Последнее действие")}</th>
              {onDelete && <th>{t("Действия")}</th>}
            </tr></thead>
            <tbody>{participants.map((a) => (
              <tr key={a.id} tabIndex={0} onClick={() => onSelect(a)} onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(a); }
              }} aria-label={t("Подробности: {name}", { name: a.name || t("Без имени") })}>
                <td><div className="participant-name"><div><strong>{a.name || t("Без имени")}</strong><small>{a.group || t("Без группы")}</small></div></div></td>
                {showQuiz && <td className="live-quiz-title">{a.quizTitle}</td>}
                <td><PresenceBadge attempt={a} now={now} /><small className="live-time">{a.presence?.lastSeenAt ? utc(a.presence.lastSeenAt) : "—"}</small></td>
                <td><AttemptProgress attempt={a} /></td>
                <td>{a.warnings || 0}</td>
                <td><span>{t(actionLabels[a.presence?.lastAction] || a.presence?.lastAction || "Нет действий")}</span><small className="live-time">{a.presence?.lastActionAt ? utc(a.presence.lastActionAt) : "—"}</small></td>
                {onDelete && <td><button className="icon-button danger-text" title={t("Удалить результат")} aria-label={t("Удалить результат: {name}", { name: a.name || t("Без имени") })} onClick={(e) => { e.stopPropagation(); onDelete(a); }} onKeyDown={(e) => e.stopPropagation()}><Trash2 size={17} /></button></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function AttemptDeleteDialog({ attempt, busy, onClose, onConfirm }) {
  return (
    <Modal title={t("Удалить результат участника?")} onClose={onClose}>
      <p>{t("Попытка участника «{name}», ответы и журнал событий будут удалены. Он сможет начать квиз заново. Действие необратимо.", { name: attempt.name || t("Без имени") })}</p>
      {attempt.status === "active" && <p className="inline-alert">{t("Участник сейчас проходит квиз. Удаление прервёт его попытку.")}</p>}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t("Отмена")}</Button>
        <Button variant="danger" loading={busy} onClick={onConfirm}>{t("Удалить результат")}</Button>
      </div>
    </Modal>
  );
}
function CloneDialog({ title, busy, onClose, onConfirm }) {
  return <Modal title={t("Создать копию?")} onClose={onClose}><p>{t("Создать отдельную копию «{title}» без результатов участников?", { title })}</p><p className="muted clone-note">{t("Копируется последняя сохранённая версия.")}</p><div className="modal-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t("Отмена")}</Button><Button loading={busy} onClick={onConfirm}><Copy size={17} />{t("Создать копию")}</Button></div></Modal>;
}
function ExportDialog({ kind = "quizzes", id, onClose }) {
  return <Modal title={t("Скачать отчёт Excel")} onClose={onClose}><p className="muted">{t("Выберите состав отчёта перед скачиванием.")}</p><div className="export-options">
    <a className="export-option" href={`/api/admin/${kind}/${id}/export.xlsx?variant=public`} onClick={onClose}><ShieldCheck size={24} /><div><strong>{t("Публичный отчёт")}</strong><p>{t("Имена, ID, сохранённые IP, результаты, вопросы и события. Без ответов участников и ключей проверки.")}</p></div><Download size={20} /></a>
    <a className="export-option" href={`/api/admin/${kind}/${id}/export.xlsx?variant=private`} onClick={onClose}><LockKeyhole size={24} /><div><strong>{t("Полный отчёт")}</strong><p>{t(kind === "surveys" ? "Все собранные данные, включая ответы участников. Настройки анонимности сохраняются." : "Все данные, включая ответы участников и правильные ответы. Для администратора.")}</p></div><Download size={20} /></a>
  </div></Modal>;
}
function LivePage() {
  const [monitoring, setMonitoring] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const load = useCallback(() => api("/api/admin/monitoring").then((r) => { setMonitoring(r); setError(""); }).catch((e) => setError(e.message)), []);
  const { connected, now } = useAdminLive(load);
  const all = monitoring?.participants || monitoring?.attempts || [];
  const participants = all.filter((a) => (filter === "all" || a.kind === filter) && `${a.name || ""} ${a.title || a.quizTitle || a.surveyTitle || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const count = (status) => all.filter((a) => presenceStatus(a, now) === status).length;
  const route = (a) => `/admin/${a.kind === "survey" ? "surveys" : "quizzes"}/${a.formId || a.surveyId || a.quizId}/report/${a.kind === "survey" ? "responses" : "attempts"}/${encodeURIComponent(a.id)}`;
  return <AdminShell section="live"><main className="workspace"><div className="page-heading"><div><h1>{t("Live-мониторинг")}</h1><p>{t("Активные участники квизов и опросов в одном месте.")}</p></div><LiveConnection connected={connected} /></div>
    <div className="stat-grid four">{[["Сейчас проходят",all.length], ["Во вкладке",count("active")], ["Вне вкладки",count("away")], ["Нет связи",count("offline")]].map(([label,n]) => <div className="stat" key={label}><span>{t(label)}</span><strong>{monitoring ? n : "—"}</strong><small>{t("Участники квизов и опросов")}</small></div>)}</div>
    <div className="collection-toolbar"><div className="tabs">{[["all","Все"],["quiz","Квизы"],["survey","Опросы"]].map(([key,label])=><button key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{t(label)}</button>)}</div><label className="search"><Search size={17}/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={t("Участник или название…")} aria-label={t("Поиск в мониторинге")}/></label></div>
    {error && <div className="inline-alert">{t(error)}</div>}
    {!monitoring ? <Loading/> : <section className="panel monitoring-panel"><p className="live-explainer">{t("Статус показывает связь и фокус браузера. Без сигнала более 35 секунд — «Нет связи».")}</p>{!participants.length ? <Empty icon={Radio} title={t("Нет активных участников")}>{t("Когда участники начнут квиз или опрос, они появятся здесь.")}</Empty> : <div className="table-scroll"><table><thead><tr>{["Участник","Квиз / опрос","Присутствие","Прошло / осталось","Прогресс","Последнее действие"].map((label)=><th key={label}>{t(label)}</th>)}</tr></thead><tbody>{participants.map((a)=><tr key={`${a.kind}-${a.id}`} tabIndex={0} onClick={()=>navigate(route(a))} onKeyDown={(e)=>e.key==="Enter"&&navigate(route(a))}><td><div className="participant-name"><div><strong>{a.name||t("Без имени")}</strong><small>{a.group||"—"}</small></div></div></td><td className="live-form-title"><strong>{a.title||a.quizTitle||a.surveyTitle}</strong><small className="live-time">{t(a.kind==="survey"?"Опрос":"Квиз")}</small></td><td><PresenceBadge attempt={a} now={now}/><small className="live-time">{utc(a.presence?.lastSeenAt)}</small></td><td className="tabular">{duration(Math.max(0,(now-Date.parse(a.startedAt))/1000))}<small className="live-time">{a.expiresAt?t("Осталось: {time}",{time:duration(Math.max(0,(Date.parse(a.expiresAt)-now)/1000))}):t("Без таймера")}</small></td><td><AttemptProgress attempt={a}/></td><td>{t(actionLabels[a.presence?.lastAction]||a.presence?.lastAction||"Нет действий")}<small className="live-time">{utc(a.presence?.lastActionAt)}</small>{a.warnings>0&&<small className="live-time">{t("Предупреждения: {count}",{count:a.warnings})}</small>}</td></tr>)}</tbody></table></div>}</section>}
  </main></AdminShell>;
}
function ReportsCenter() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [exportItem,setExportItem] = useState(null);
  const load = useCallback(async()=>{
    try { const [quizzes,surveys]=await Promise.all([api("/api/admin/quizzes"),api("/api/admin/surveys")]); setItems([...(quizzes.quizzes||[]).map((q)=>({...q,kind:"quiz"})),...(surveys.surveys||[]).map((s)=>({...s,kind:"survey"}))]);setError(""); } catch(e){setError(e.message);}
  },[]);
  useAdminLive(load);
  const filtered=(items||[]).filter((item)=>(filter==="all"||item.kind===filter)&&item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <AdminShell section="reports"><main className="workspace"><div className="page-heading"><div><h1>{t("Отчёты")}</h1><p>{t("Результаты квизов и опросов, подробности участников и выгрузки.")}</p></div></div><div className="collection-toolbar"><div className="tabs">{[["all","Все"],["quiz","Квизы"],["survey","Опросы"]].map(([key,label])=><button key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{t(label)}</button>)}</div><label className="search"><Search size={17}/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={t("Найти отчёт…")} aria-label={t("Поиск отчёта")}/></label></div>{error&&<div className="inline-alert">{t(error)}</div>}{!items?<Loading/>:!filtered.length?<Empty icon={BarChart3} title={t("Нет отчётов")}>{t("Отчёты появятся после создания квиза или опроса.")}</Empty>:<div className="reports-list">{filtered.map((item)=><article className="panel report-list-item" key={`${item.kind}-${item.id}`}><span className="round-icon"><BarChart3 size={22}/></span><div><small className="eyebrow">{t(item.kind==="survey"?"Опрос":"Квиз")}</small><h2><Link to={`/admin/${item.kind==="survey"?"surveys":"quizzes"}/${item.id}/report`}>{item.title}</Link></h2><p>{t("Участников: {count}",{count:item.attemptCount??item.responseCount??0})}</p></div><div className="heading-actions"><Link className="button secondary" to={`/admin/${item.kind==="survey"?"surveys":"quizzes"}/${item.id}/report`}>{t("Открыть отчёт")}<ArrowUpRight size={16}/></Link><Button variant="secondary" onClick={()=>setExportItem(item)}><Download size={17}/>{t("Excel")}</Button></div></article>)}</div>}</main>{exportItem&&<ExportDialog kind={exportItem.kind==="survey"?"surveys":"quizzes"} id={exportItem.id} onClose={()=>setExportItem(null)}/>}</AdminShell>;
}
const ToastContext = createContext(() => {});
function ToastProvider({ children }) {
  const [notice, setNotice] = useState(null);
  const timer = useRef();
  const show = (message, error = false) => {
    clearTimeout(timer.current);
    setNotice({
      message,
      error,
    });
    timer.current = setTimeout(() => setNotice(null), 5500);
  };
  return (
    <ToastContext.Provider value={show}>
      {children}
      {notice && (
        <div className={`toast ${notice.error ? "error" : ""}`} role="status">
          {notice.error ? (
            <AlertTriangle size={19} />
          ) : (
            <CheckCircle2 size={19} />
          )}
          <span>{t(notice.message)}</span>
          <button
            className="icon-button"
            onClick={() => setNotice(null)}
            aria-label={t("Закрыть уведомление")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
function Brand() {
  return (
    <Link className="brand" to="/" aria-label={t("Forma, главная")}>
      FORMA
    </Link>
  );
}
function Button({
  children,
  variant = "primary",
  className = "",
  loading,
  ...props
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`button ${variant} ${className}`}
    >
      {loading && <LoaderCircle size={17} className="spin" />}
      {children}
    </button>
  );
}
function Badge({ status }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {t(statusLabel[status] || status)}
    </span>
  );
}
function Field({ label, hint, children, className = "" }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Toggle({ label, description, checked, onChange, disabled }) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span>
        <strong>{t(label)}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}
function Empty({ icon: Icon = BookOpen, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={27} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={25} />
      <span>{t("Загрузка…")}</span>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  variant = "",
  headerExtra = null,
  footer = null,
}) {
  const box = useRef();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus({ preventScroll: true });
    const handle = (e) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        const list = [
          ...box.current.querySelectorAll(
            "button,input,textarea,select,a[href],[tabindex]",
          ),
        ].filter(
          (element) =>
            !element.disabled &&
            element.tabIndex >= 0 &&
            element.getClientRects().length > 0,
        );
        if (!list.length) {
          e.preventDefault();
          box.current.focus();
          return;
        }
        const focused = list.indexOf(document.activeElement);
        if (
          focused === -1 ||
          (e.shiftKey && focused === 0) ||
          (!e.shiftKey && focused === list.length - 1)
        ) {
          e.preventDefault();
          (e.shiftKey ? list[list.length - 1] : list[0]).focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      document.body.style.overflow = previousBodyOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className={`modal-backdrop ${variant ? `${variant}-backdrop` : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={`modal ${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          {headerExtra}
          <button
            className="icon-button"
            aria-label={t("Закрыть")}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="modal-body" role="region" aria-label={title} tabIndex={0}>
          {children}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </section>
    </div>,
    document.body,
  );
}
function Footer() {
  return (
    <footer className="site-footer">
      <span>© {new Date().getFullYear()} Forma</span>
      <a href="https://abzalnurlanuly.com" rel="noreferrer" target="_blank">
        abzalnurlanuly.com <ArrowUpRight size={16} />
      </a>
    </footer>
  );
}
function Home() {
  return (
    <div className="home">
      <header className="public-header">
        <Brand />
        <div className="public-header-tools">
          <LanguageSwitcher />
          <Link className="text-link" to="/admin" aria-label={t("Вход администратора")}>
            <span className="public-admin-label">{t("Вход администратора")}</span>
            <span className="public-admin-short">{t("Вход")}</span>
            <ArrowUpRight size={20} />
          </Link>
        </div>
      </header>
      <main className="home-main">
        <h1>{t("Квизы")}</h1>
        <p className="home-lead">
          {t(" Откройте ссылку от администратора, чтобы пройти квиз. ")}
        </p>
      </main>
      <Footer />
    </div>
  );
}
function AdminShell({ children, section = "quizzes" }) {
  const [menu, setMenu] = useState(false);
  const sidebar = useRef();
  const navigate = useNavigate();
  const notify = useContext(ToastContext);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector("button")?.focus({ preventScroll: true });
    const close = () => setMenu(false);
    const resize = () => { if (innerWidth > 1099) close(); };
    const handle = (event) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const controls = [...sidebar.current.querySelectorAll("a[href],button")].filter((element) => element.getClientRects().length && !element.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handle);
    window.addEventListener("resize", resize);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handle);
      window.removeEventListener("resize", resize);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [menu]);
  const logout = async () => {
    try {
      await api("/api/auth/logout", {
        method: "POST",
      });
      navigate("/admin", {
        replace: true,
      });
      location.reload();
    } catch (e) {
      notify(e.message, true);
    }
  };
  return (
    <div className="admin-shell">
      <aside ref={sidebar} id="admin-navigation" className={`sidebar ${menu ? "open" : ""}`}>
        <div className="sidebar-heading"><Brand /><button className="icon-button mobile-menu sidebar-close" onClick={() => setMenu(false)} aria-label={t("Закрыть меню")}><X size={22} /></button></div>

        <nav>
          {[["quizzes", "/admin", "Квизы", LayoutGrid], ["surveys", "/admin/surveys", "Опросы", ClipboardList], ["live", "/admin/live", "Live-мониторинг", Radio], ["reports", "/admin/reports", "Отчёты", BarChart3]].map(([key, path, label, Icon]) => <Link key={key} className={section === key ? "active" : ""} to={path} onClick={() => setMenu(false)}><Icon size={19} />{t(label)}</Link>)}
        </nav>
        <div className="sidebar-bottom">
          <div>
            <strong>{t("Администратор")}</strong>
            <small>Abzal Nurlanuly</small>
          </div>
          <button
            className="icon-button"
            aria-label={t("Выйти из аккаунта")}
            onClick={logout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {menu && (
        <div className="sidebar-backdrop" onClick={() => setMenu(false)} />
      )}
      <div className="admin-content">
        <header className="admin-topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMenu(!menu)}
            aria-label={t("Открыть меню")}
            aria-expanded={menu}
            aria-controls="admin-navigation"
          >
            <Menu size={21} />
          </button>
          <span className="admin-mobile-brand"><Brand /></span>
          <span className="admin-topbar-label">{t("Панель администратора")}</span>
          <LanguageSwitcher />
        </header>
        {children}
      </div>
    </div>
  );
}
function AdminGate({ children }) {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    api("/api/auth/status")
      .then(setAuth)
      .catch((e) => setError(e.message));
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(auth.setupRequired ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        body: {
          username,
          password,
        },
      });
      setAuth(await api("/api/auth/status"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (auth?.authenticated) return children;
  if (!auth && !error) return <Loading />;
  return (
    <div className="auth-page">
      <header className="public-header">
        <Brand />
        <div className="public-header-tools">
          <LanguageSwitcher />
          <Link to="/" className="text-link">
            {t(" На главную ")}
            <ArrowUpRight size={16} />
          </Link>
        </div>
      </header>
      <main className="auth-layout">
        <section className="auth-card">
          <div className="round-icon">
            <LockKeyhole size={23} />
          </div>
          <h2>
            {auth?.setupRequired
              ? t("Создание администратора")
              : t("Вход администратора")}
          </h2>
          <p>
            {auth?.setupRequired
              ? t("Создайте первый аккаунт администратора.")
              : t("Войдите, чтобы управлять квизами.")}
          </p>
          <form onSubmit={submit}>
            <Field label={t("Логин")}>
              <input
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </Field>
            <Field
              label={t("Пароль")}
              hint={
                auth?.setupRequired
                  ? t("Не менее 12 символов. Используйте уникальный пароль.")
                  : null
              }
            >
              <input
                type="password"
                required
                minLength={auth?.setupRequired ? 12 : undefined}
                autoComplete={
                  auth?.setupRequired ? "new-password" : "current-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <div className="inline-alert" role="alert">
                <AlertTriangle size={17} />
                {t(error)}
              </div>
            )}
            <Button loading={busy} className="full-width">
              {auth?.setupRequired ? t("Создать аккаунт") : t("Войти")}
              <ArrowRight size={18} />
            </Button>
          </form>
          {auth?.setupRequired && (
            <p className="setup-note">
              {t(
                " Если регистрация отключена, создайте администратора командой",
              )}{" "}
              <code>npm run admin:create</code>
              {t(" внутри контейнера. ")}
            </p>
          )}
          <div className="auth-safe">
            <ShieldCheck size={15} />
            {t(" Только для администратора ")}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
function Dashboard() {
  const [quizzes, setQuizzes] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const notify = useContext(ToastContext);
  const load = useCallback(() => api("/api/admin/quizzes")
    .then((r) => { setQuizzes(r.quizzes); setError(""); })
    .catch((e) => setError(e.message)), []);
  useAdminLive(load);
  const [toClone, setToClone] = useState(null);
  const create = async () => {
    setBusy(true);
    try {
      const q = await api("/api/admin/quizzes", {
        method: "POST",
        body: {
          title: "Новый квиз",
        },
      });
      navigate(`/admin/quizzes/${q.id}`);
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const clone = async (q) => {
    setBusy(true);
    try {
      const created = await api(`/api/admin/quizzes/${q.id}/clone`, {
        method: "POST",
      });
      setToClone(null);
      notify("Копия создана. Теперь её можно отредактировать.");
      navigate(`/admin/quizzes/${created.id}`);
    } catch (e) {
      notify(e.message, true);
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/quizzes/${toDelete.id}`, {
        method: "DELETE",
      });
      setToDelete(null);
      await load();
      notify("Квиз удалён");
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const filtered = (quizzes || []).filter(
    (q) =>
      (filter === "all" || q.status === filter) &&
      `${q.title} ${q.description || ""}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  return (
    <AdminShell>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <h1>{t("Квизы")}</h1>
            <p>{t("Создавайте квизы и управляйте доступом.")}</p>
          </div>
          <Button onClick={create} loading={busy}>
            <Plus size={18} />
            {t(" Создать квиз ")}
          </Button>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span>
              {t(" Всего квизов ")}
              <LayoutGrid size={17} />
            </span>
            <strong>{quizzes?.length ?? "—"}</strong>
            <small>{t("Создано всего")}</small>
          </div>
          <div className="stat">
            <span>
              {t(" Опубликованы ")}
              <span className="live-dot" />
            </span>
            <strong>
              {quizzes?.filter((q) => q.status === "published").length ?? "—"}
            </strong>
            <small>{t("Доступны по приглашению")}</small>
          </div>
          <div className="stat">
            <span>
              {t(" Участников ")}
              <Users size={18} />
            </span>
            <strong>
              {quizzes?.reduce((n, q) => n + (q.attemptCount || 0), 0) ?? "—"}
            </strong>
            <small>{t("Попытки во всех квизах")}</small>
          </div>
        </div>
        <div className="collection-toolbar">
          <div className="tabs">
            {[
              ["all", t("Все квизы")],
              ["published", t("Опубликованные")],
              ["draft", t("Черновики")],
              ["closed", t("Закрытые")],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
                {key === "all" && <span>{quizzes?.length || 0}</span>}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={17} />
            <input
              placeholder={t("Найти квиз…")}
              aria-label={t("Поиск квизов")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        {error ? (
          <div className="inline-alert">
            {t(error)}
            <button onClick={load} className="text-link">
              {t(" Повторить ")}
            </button>
          </div>
        ) : !quizzes ? (
          <Loading />
        ) : !filtered.length ? (
          <Empty
            title={
              search || filter !== "all"
                ? t("Ничего не найдено")
                : t("Нет квизов")
            }
            action={
              !search &&
              filter === "all" && (
                <Button onClick={create}>
                  <Plus size={17} />
                  {t(" Создать первый квиз ")}
                </Button>
              )
            }
          >
            {search || filter !== "all"
              ? t("Попробуйте изменить запрос или фильтр.")
              : t(
                  "Создайте квиз, добавьте вопросы и поделитесь ссылкой со студентами.",
                )}
          </Empty>
        ) : (
          <div className="quiz-grid">
            {filtered.map((q, i) => (
              <article className="quiz-card" key={q.id}>
                <div className="quiz-card-top">
                  <span className="quiz-number">
                    {String(i + 1).padStart(2, "0")} <span>/ QUIZ</span>
                  </span>
                  <Badge status={q.status} />
                </div>
                <Link to={`/admin/quizzes/${q.id}`} className="quiz-card-title">
                  <h2>{q.title}</h2>
                  <ArrowUpRight size={22} />
                </Link>
                <p>{q.description || t("Описание не добавлено.")}</p>
                <div className="quiz-card-meta">
                  <span>
                    <ListChecks size={15} />
                    {q.questionCount ??
                      q.questions?.filter((q) => q.type !== "content").length ??
                      "—"}{" "}
                    {t(" вопросов ")}
                  </span>
                  <span>
                    <Users size={15} />
                    {q.attemptCount || 0}
                    {t(" участников ")}
                  </span>
                </div>
                <div className="quiz-card-footer">
                  <Link
                    to={`/admin/quizzes/${q.id}/report`}
                    className="text-link"
                  >
                    <BarChart3 size={16} />
                    {t(" Результаты ")}
                  </Link>
                  <div>
                    <button
                      className="icon-button"
                      aria-label={t("Копировать квиз {value0}", {
                        value0: q.title,
                      })}
                      onClick={() => setToClone(q)}
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={q.status === "published"}
                      title={
                        q.status === "published"
                          ? t("Сначала закройте квиз")
                          : t("Удалить квиз")
                      }
                      aria-label={t("Удалить квиз {value0}", {
                        value0: q.title,
                      })}
                      onClick={() => setToDelete(q)}
                    >
                      <Trash2 size={16} />
                    </button>
                    <Link
                      className="icon-button"
                      to={`/admin/quizzes/${q.id}`}
                      aria-label={t("Редактировать {value0}", {
                        value0: q.title,
                      })}
                    >
                      <Pencil size={16} />
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
      {toClone && <CloneDialog title={toClone.title} busy={busy} onClose={() => !busy && setToClone(null)} onConfirm={() => clone(toClone)} />}
      {toDelete && (
        <Modal title={t("Удалить квиз?")} onClose={() => setToDelete(null)}>
          <p>
            {t(" Квиз «")}
            {toDelete.title}
            {t(
              "» и его результаты будут удалены без возможности восстановления. Сначала скачайте Excel, если он нужен. ",
            )}
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setToDelete(null)}>
              {t(" Отмена ")}
            </Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              {t(" Удалить навсегда ")}
            </Button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
function makeQuestion(type) {
  const opts = [
    {
      id: uid(),
      text: "",
    },
    {
      id: uid(),
      text: "",
    },
  ];
  return {
    id: uid(),
    type,
    text: "",
    image: null,
    points: type === "content" ? 0 : 1,
    options: type === "truefalse" ? [{ id: "true", text: t("Верно") }, { id: "false", text: t("Неверно") }] : ["single", "multiple", "ordering"].includes(type) ? opts : [],
    correct: type === "short" ? "" : type === "number" ? 0 : type === "ordering" ? opts.map((o) => o.id) : type === "truefalse" ? ["true"] : [],
    ...(type === "number" ? { tolerance: 0 } : {}),
    pairs:
      type === "matching"
        ? [
            {
              id: uid(),
              left: "",
              right: "",
            },
            {
              id: uid(),
              left: "",
              right: "",
            },
          ]
        : [],
  };
}
function QuizEditor() {
  const { id } = useParams();
  const [quiz, setQuiz] = useState(null);
  const [tab, setTab] = useState("questions");
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [busyImage, setBusyImage] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const notify = useContext(ToastContext);
  const navigate = useNavigate();
  useEffect(() => {
    setQuiz(null);
    api(`/api/admin/quizzes/${id}`)
      .then((q) => {
        setQuiz({
          ...q,
          settings: {
            ...defaults,
            ...q.settings,
          },
        });
      })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    const warn = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const update = (patch) => {
    setQuiz((q) => ({
      ...q,
      ...patch,
    }));
    setDirty(true);
  };
  const settings = (patch) =>
    update({
      settings: {
        ...quiz.settings,
        ...patch,
      },
    });
  const question = quiz?.questions[selected];
  const updateQuestion = (patch) =>
    update({
      questions: quiz.questions.map((q, i) =>
        i === selected
          ? {
              ...q,
              ...patch,
            }
          : q,
      ),
    });
  const changeQuestionType = (type) => {
    if (type === question.type) return;
    const next = { ...makeQuestion(type), id: question.id, text: question.text, image: question.image, points: type === "content" ? 0 : question.points || 1 };
    if (["single", "multiple", "ordering"].includes(type) && ["single", "multiple", "ordering"].includes(question.type)) {
      next.options = question.options;
      const valid = Array.isArray(question.correct) ? question.correct.filter((key) => next.options.some((option) => option.id === key)) : [];
      next.correct = type === "ordering" ? next.options.map((option) => option.id) : type === "single" ? valid.slice(0, 1) : valid;
    }
    updateQuestion(next);
  };
  const save = async (status) => {
    setSaving(true);
    setError("");
    try {
      const q = await api(`/api/admin/quizzes/${id}`, {
        method: "PUT",
        body: {
          ...quiz,
          ...(status
            ? {
                status,
              }
            : {}),
        },
      });
      setQuiz({
        ...q,
        settings: {
          ...defaults,
          ...q.settings,
        },
      });
      setDirty(false);
      notify(
        status === "published"
          ? "Квиз опубликован. Поделитесь ссылкой."
          : status === "closed"
            ? "Новые попытки закрыты"
            : "Изменения сохранены",
      );
    } catch (e) {
      setError(e.message);
      notify(e.message, true);
    } finally {
      setSaving(false);
    }
  };
  const add = (type) => {
    update({
      questions: [...quiz.questions, makeQuestion(type)],
    });
    setSelected(quiz.questions.length);
    setAddOpen(false);
  };
  const removeQuestion = () => {
    update({
      questions: quiz.questions.filter((q, i) => i !== selected),
    });
    setSelected(Math.max(0, selected - 1));
  };
  const move = (delta) => {
    const list = [...quiz.questions];
    [list[selected], list[selected + delta]] = [
      list[selected + delta],
      list[selected],
    ];
    update({
      questions: list,
    });
    setSelected(selected + delta);
  };
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.type,
      ) ||
      file.size > 3 * 1024 * 1024
    ) {
      notify("Выберите PNG, JPEG, WebP или GIF до 3 МБ.", true);
      return;
    }
    setBusyImage(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const result = await api("/api/admin/uploads", {
        method: "POST",
        body: {
          data,
        },
      });
      updateQuestion({
        image: result.url,
      });
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusyImage(false);
    }
  };
  const invite = async () => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(`${location.origin}/q/${quiz.slug}`);
      notify("Ссылка скопирована");
    } catch {
      notify("Не удалось скопировать. Выделите ссылку вручную.", true);
    }
  };
  const clone = async () => {
    setCloning(true);
    try {
      const q = await api(`/api/admin/quizzes/${id}/clone`, {
        method: "POST",
      });
      navigate(`/admin/quizzes/${q.id}`);
      setCloneOpen(false);
    } catch (e) {
      notify(e.message, true);
    } finally { setCloning(false); }
  };
  if (!quiz)
    return (
      <AdminShell>
        {error ? (
          <div className="workspace">
            <div className="inline-alert">{t(error)}</div>
            <Link to="/admin" className="text-link">
              {t(" Вернуться к квизам ")}
            </Link>
          </div>
        ) : (
          <Loading />
        )}
      </AdminShell>
    );
  return (
    <AdminShell>
      <main className="workspace editor-workspace">
        <div className="breadcrumb">
          <Link to="/admin">{t("Квизы")}</Link>
          <ChevronRight size={14} />
          <span>{t("Редактор квиза")}</span>
        </div>
        <div className="editor-heading">
          <div>
            <Badge status={quiz.status} /><span className="content-revision">{t("Версия вопросов: {number}", { number: quiz.contentRevision || 1 })}</span>
            <h1>{quiz.title}</h1>
            <span className="save-state">
              {dirty
                ? t("Есть несохранённые изменения")
                : t("Все изменения сохранены")}
            </span>
          </div>
          <div className="heading-actions">
            <Link
              className="button secondary icon-only"
              to={`/admin/quizzes/${id}/report`}
              title={t("Результаты")}
            >
              <BarChart3 size={18} />
            </Link>
            <Button variant="secondary" onClick={() => save()} loading={saving}>
              <Save size={17} />
              <span>{t("Сохранить")}</span>
            </Button>
            {quiz.status === "published" ? (
              <Button onClick={() => save("closed")} loading={saving}>
                {t(" Закрыть приём ")}
              </Button>
            ) : (
              <Button onClick={() => save("published")} loading={saving}>
                {t(" Опубликовать ")}
                <ArrowUpRight size={17} />
              </Button>
            )}
          </div>
        </div>
        <div className="editor-tabs tabs">
          <button
            className={tab === "questions" ? "active" : ""}
            onClick={() => setTab("questions")}
          >
            <ListChecks size={17} />
            {t(" Вопросы")}
            <span>{quiz.questions.length}</span>
          </button>
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            <Settings size={17} />
            {t(" Настройки ")}
          </button>
          <button
            className={tab === "groups" ? "active" : ""}
            onClick={() => setTab("groups")}
          >
            <Users size={17} />
            {t(" Группы ")}
          </button>
          <button
            className={tab === "share" ? "active" : ""}
            onClick={() => setTab("share")}
          >
            <Link2 size={17} />
            {t(" Приглашение ")}
          </button>
        </div>
        {error && (
          <div className="inline-alert" role="alert">
            <AlertTriangle size={17} />
            {t(error)}
          </div>
        )}
        {(quiz.status !== "draft" || (quiz.attemptCount || 0) > 0) && (
          <div className="info-banner">
            <LockKeyhole size={18} />
            <div>
              {t(
                "Вопросы можно менять в любой момент. Новые участники получат обновлённую версию; начавшие продолжат свою.",
              )}
              <br />
              {t(
                "Настройки применяются к активным и новым попыткам. Сохранённые ответы и оценки остаются по версии участника.",
              )}
            </div>
            <button className="text-link" onClick={() => setCloneOpen(true)}>
              {t(" Создать копию ")}
              <Copy size={15} />
            </button>
          </div>
        )}
        {tab === "questions" && (
          <div className="builder">
            <aside className="question-sidebar">
              <div className="question-sidebar-heading">
                <span>{t("СОДЕРЖАНИЕ")}</span>
                <span>{quiz.questions.length}</span>
              </div>
              {quiz.questions.map((q, i) => (
                <button
                  key={q.id}
                  className={`question-list-item ${i === selected ? "selected" : ""}`}
                  onClick={() => setSelected(i)}
                >
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{q.text || t("Новый вопрос")}</strong>
                    <small>{t(typeLabels[q.type])}</small>
                  </div>
                  <ChevronRight size={15} />
                </button>
              ))}
              <Button
                variant="secondary"

                className="full-width add-question"
                onClick={() => setAddOpen(true)}
              >
                <Plus size={17} />
                {t(" Добавить вопрос ")}
              </Button>
            </aside>
            {question ? (
              <section className="question-editor panel" key={question.id}>
                <div className="section-heading">
                  <div>
                    <h2>{t(typeLabels[question.type])}</h2>
                  </div>
                  <div className="question-actions">
                    <button
                      disabled={selected === 0}
                      className="icon-button"
                      title={t("Переместить выше")}
                      aria-label={t("Переместить вопрос выше")}
                      onClick={() => move(-1)}
                    >
                      <ChevronUp size={18} />
                    </button>
                    <button
                      disabled={
                        selected === quiz.questions.length - 1
                      }
                      className="icon-button"
                      title={t("Переместить ниже")}
                      aria-label={t("Переместить вопрос ниже")}
                      onClick={() => move(1)}
                    >
                      <ChevronDown size={18} />
                    </button>
                    <button

                      className="icon-button danger-text"
                      aria-label={t("Удалить вопрос")}
                      onClick={removeQuestion}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>
                <fieldset>
                  <Field label={t("Тип вопроса")}><select value={question.type} onChange={(e) => changeQuestionType(e.target.value)}>{Object.entries(typeLabels).map(([type, label]) => <option key={type} value={type}>{t(label)}</option>)}</select></Field>
                  <Field
                    label={
                      question.type === "content"
                        ? t("Текст страницы")
                        : t("Текст вопроса")
                    }
                  >
                    <textarea
                      rows={3}
                      placeholder={
                        question.type === "content"
                          ? t("Введите текст страницы")
                          : t("Введите текст вопроса")
                      }
                      value={question.text}
                      onChange={(e) =>
                        updateQuestion({
                          text: e.target.value,
                        })
                      }
                    />
                  </Field>
                  {question.image ? (
                    <div className="editor-image">
                      <img
                        src={question.image}
                        alt={t("Изображение к вопросу")}
                      />
                      <button
                        className="icon-button"
                        aria-label={t("Удалить изображение")}
                        onClick={() =>
                          updateQuestion({
                            image: null,
                          })
                        }
                      >
                        <X size={18} />
                      </button>
                    </div>
                  ) : (
                    <label className="image-upload">
                      <ImagePlus size={20} />
                      {busyImage ? t("Загружаем…") : t("Добавить изображение")}
                      <small>{t("PNG, JPG, WebP, GIF · до 3 МБ")}</small>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={upload}
                        disabled={busyImage}
                      />
                    </label>
                  )}
                  {["single", "multiple"].includes(question.type) && (
                    <div className="answer-editor">
                      <div className="answer-editor-label">
                        <strong>{t("Варианты ответа")}</strong>
                        <small>
                          {question.type === "single"
                            ? t("Отметьте один правильный")
                            : t("Отметьте все правильные")}
                        </small>
                      </div>
                      {question.options.map((o, i) => {
                        const correct =
                          Array.isArray(question.correct) &&
                          question.correct.includes(o.id);
                        return (
                          <div
                            className={`option-editor ${correct ? "correct" : ""}`}
                            key={o.id}
                          >
                            <button
                              className="correct-select"
                              aria-label={t("Вариант {value0}: {value1}", {
                                value0: i + 1,
                                value1: correct
                                  ? t("правильный")
                                  : t("отметить правильным"),
                              })}
                              aria-pressed={correct}
                              onClick={() =>
                                updateQuestion({
                                  correct:
                                    question.type === "single"
                                      ? [o.id]
                                      : correct
                                        ? question.correct.filter(
                                            (k) => k !== o.id,
                                          )
                                        : [...(question.correct || []), o.id],
                                })
                              }
                            >
                              {correct ? (
                                <CheckCircle2 size={21} />
                              ) : question.type === "multiple" ? (
                                <Square size={21} />
                              ) : (
                                <Circle size={21} />
                              )}
                            </button>
                            <span className="option-letter">
                              {String.fromCharCode(65 + i)}
                            </span>
                            <input
                              aria-label={t("Текст варианта {value0}", {
                                value0: i + 1,
                              })}
                              placeholder={t("Вариант {value0}", {
                                value0: i + 1,
                              })}
                              value={o.text}
                              onChange={(e) =>
                                updateQuestion({
                                  options: question.options.map((p) =>
                                    p.id === o.id
                                      ? {
                                          ...p,
                                          text: e.target.value,
                                        }
                                      : p,
                                  ),
                                })
                              }
                            />
                            <button
                              className="icon-button"
                              disabled={question.options.length <= 2}
                              aria-label={t("Удалить вариант {value0}", {
                                value0: i + 1,
                              })}
                              onClick={() =>
                                updateQuestion({
                                  options: question.options.filter(
                                    (p) => p.id !== o.id,
                                  ),
                                  correct: question.correct.filter(
                                    (k) => k !== o.id,
                                  ),
                                })
                              }
                            >
                              <X size={16} />
                            </button>
                          </div>
                        );
                      })}
                      <button
                        className="text-link add-option"
                        disabled={question.options.length >= 12}
                        onClick={() =>
                          updateQuestion({
                            options: [
                              ...question.options,
                              {
                                id: uid(),
                                text: "",
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={16} />
                        {t(" Добавить вариант ")}
                      </button>
                    </div>
                  )}
                  {question.type === "truefalse" && <Field label={t("Правильный ответ")}><div className="boolean-editor">{question.options.map((option) => <button key={option.id} className={`button ${question.correct?.includes(option.id) ? "primary" : "secondary"}`} onClick={() => updateQuestion({ correct: [option.id] })} aria-pressed={question.correct?.includes(option.id)}>{option.text}</button>)}</div></Field>}
                  {question.type === "number" && <div className="numeric-editor"><Field label={t("Правильный числовой ответ")}><input type="number" step="any" value={question.correct ?? 0} onChange={(e) => updateQuestion({ correct: e.target.value === "" ? "" : Number(e.target.value) })}/></Field><Field label={t("Допустимая погрешность")} hint={t("0 — точное число. Ответ засчитывается в пределах указанного отклонения.")}><input type="number" step="any" min="0" value={question.tolerance ?? 0} onChange={(e) => updateQuestion({ tolerance: e.target.value === "" ? "" : Number(e.target.value) })}/></Field></div>}
                  {question.type === "ordering" && <div className="answer-editor"><div className="answer-editor-label"><strong>{t("Правильный порядок")}</strong><small>{t("Расположите элементы сверху вниз. Участник получит их в случайном порядке.")}</small></div>{(question.correct || []).map((optionId, optionIndex) => {
                    const option = question.options.find((item) => item.id === optionId);
                    if (!option) return null;
                    const reorder = (delta) => { const correct = [...question.correct]; [correct[optionIndex],correct[optionIndex+delta]]=[correct[optionIndex+delta],correct[optionIndex]];updateQuestion({correct}); };
                    return <div className="ordering-row" key={option.id}><span className="option-letter">{optionIndex+1}</span><input value={option.text} aria-label={t("Элемент {number}",{number:optionIndex+1})} placeholder={t("Элемент {number}",{number:optionIndex+1})} onChange={(e)=>updateQuestion({options:question.options.map((item)=>item.id===option.id?{...item,text:e.target.value}:item)})}/><button className="icon-button" disabled={optionIndex===0} onClick={()=>reorder(-1)} aria-label={t("Переместить выше")}><ChevronUp size={18}/></button><button className="icon-button" disabled={optionIndex===question.correct.length-1} onClick={()=>reorder(1)} aria-label={t("Переместить ниже")}><ChevronDown size={18}/></button><button className="icon-button" disabled={question.options.length<=2} onClick={()=>updateQuestion({options:question.options.filter((item)=>item.id!==option.id),correct:question.correct.filter((id)=>id!==option.id)})} aria-label={t("Удалить элемент {number}",{number:optionIndex+1})}><X size={17}/></button></div>;
                  })}<button className="text-link add-option" disabled={question.options.length>=12} onClick={()=>{const option={id:uid(),text:""};updateQuestion({options:[...question.options,option],correct:[...question.correct,option.id]});}}><Plus size={16}/>{t("Добавить элемент")}</button></div>}
                  {question.type === "short" && (
                    <Field
                      label={t("Правильный ответ")}
                      hint={t(
                        "Регистр и пробелы по краям не учитываются. Засчитывается точное совпадение.",
                      )}
                    >
                      <input
                        maxLength={2000}
                        value={
                          typeof question.correct === "string"
                            ? question.correct
                            : ""
                        }
                        placeholder={t("Введите ожидаемый ответ")}
                        onChange={(e) =>
                          updateQuestion({
                            correct: e.target.value,
                          })
                        }
                      />
                    </Field>
                  )}
                  {question.type === "matching" && (
                    <div className="answer-editor">
                      <div className="answer-editor-label">
                        <strong>{t("Правильные пары")}</strong>
                        <small>{t("Правая колонка будет перемешана")}</small>
                      </div>
                      {question.pairs.map((p, i) => (
                        <div className="pair-editor" key={p.id}>
                          <input
                            aria-label={t("Левая часть пары {value0}", {
                              value0: i + 1,
                            })}
                            placeholder={t("Термин")}
                            value={p.left}
                            onChange={(e) =>
                              updateQuestion({
                                pairs: question.pairs.map((v) =>
                                  v.id === p.id
                                    ? {
                                        ...v,
                                        left: e.target.value,
                                      }
                                    : v,
                                ),
                              })
                            }
                          />
                          <ArrowRight size={16} />
                          <input
                            aria-label={t("Правая часть пары {value0}", {
                              value0: i + 1,
                            })}
                            placeholder={t("Определение")}
                            value={p.right}
                            onChange={(e) =>
                              updateQuestion({
                                pairs: question.pairs.map((v) =>
                                  v.id === p.id
                                    ? {
                                        ...v,
                                        right: e.target.value,
                                      }
                                    : v,
                                ),
                              })
                            }
                          />
                          <button
                            className="icon-button"
                            disabled={question.pairs.length <= 2}
                            aria-label={t("Удалить пару {value0}", {
                              value0: i + 1,
                            })}
                            onClick={() =>
                              updateQuestion({
                                pairs: question.pairs.filter(
                                  (v) => v.id !== p.id,
                                ),
                              })
                            }
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="text-link add-option"
                        disabled={question.pairs.length >= 12}
                        onClick={() =>
                          updateQuestion({
                            pairs: [
                              ...question.pairs,
                              {
                                id: uid(),
                                left: "",
                                right: "",
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={16} />
                        {t(" Добавить пару ")}
                      </button>
                    </div>
                  )}
                  {question.type !== "content" && (
                    <div className="points-row">
                      <Field
                        label={t("Баллов за правильный ответ")}
                        hint={t(
                          "Несколько ответов и соответствия оцениваются целиком.",
                        )}
                      >
                        <input
                          type="number"
                          min="1"
                          max="100"
                          value={question.points}
                          onChange={(e) =>
                            updateQuestion({
                              points: Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                      <span>
                        <CheckCircle2 size={17} />
                        {t(" Ответы видны только вам ")}
                      </span>
                    </div>
                  )}
                </fieldset>
              </section>
            ) : (
              <section className="panel">
                <Empty
                  title={t("Нет вопросов")}
                  action={
                    <Button  onClick={() => setAddOpen(true)}>
                      <Plus size={17} />
                      {t(" Добавить вопрос ")}
                    </Button>
                  }
                >
                  {t(" Добавьте первый вопрос. ")}
                </Empty>
              </section>
            )}
          </div>
        )}
        {tab === "settings" && (
          <div className="settings-layout">
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>{t("Основные настройки")}</h2>
                </div>
                <FileText size={23} />
              </div>
              <Field label={t("Название квиза")}>
                <input
                  value={quiz.title}
                  maxLength={180}
                  onChange={(e) =>
                    update({
                      title: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label={t("Краткое описание")}>
                <textarea
                  value={quiz.description || ""}
                  rows={2}
                  maxLength={2000}
                  onChange={(e) =>
                    update({
                      description: e.target.value,
                    })
                  }
                  placeholder={t("Что ждёт участников?")}
                />
              </Field>
              <Field
                label={t("Страница перед началом")}
                hint={t("Инструкция, материалы или ваше приветствие.")}
              >
                <textarea
                  rows={4}
                  value={quiz.intro || ""}
                  onChange={(e) =>
                    update({
                      intro: e.target.value,
                    })
                  }
                  placeholder={t("Инструкция перед началом")}
                />
              </Field>
              <Field label={t("Страница после завершения")}>
                <textarea
                  rows={3}
                  value={quiz.outro || ""}
                  onChange={(e) =>
                    update({
                      outro: e.target.value,
                    })
                  }
                  placeholder={t("Спасибо за участие!")}
                />
              </Field>
            </section>
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>{t("Время и участие")}</h2>
                </div>
                <Clock3 size={23} />
              </div>
              <fieldset>
                <Toggle
                  label={t("Запрашивать имя")}
                  description={t("Участник вводит имя перед началом квиза.")}
                  checked={quiz.settings.requireName}
                  onChange={(v) =>
                    settings({
                      requireName: v,
                    })
                  }
                />
                <Toggle
                  label={t("Показывать результат")}
                  description={t(
                    "Участник увидит свои баллы и процент после завершения.",
                  )}
                  checked={quiz.settings.showScore}
                  onChange={(v) =>
                    settings({
                      showScore: v,
                    })
                  }
                />
                <Toggle
                  label={t("Показывать правильные ответы после теста")}
                  description={t(
                    "По умолчанию выключено. Разбор доступен после завершения при включённом показе результата. Изменение применяется и к уже завершённым попыткам при обновлении страницы.",
                  )}
                  checked={quiz.settings.showCorrectAnswersAfterTest === true}
                  onChange={(v) =>
                    settings({
                      showCorrectAnswersAfterTest: v,
                    })
                  }
                />
                <Field
                  label={t("Проверка ответов во время теста")}
                  hint={
                    quiz.settings.showScore
                      ? quiz.settings.feedbackMode === "immediate"
                        ? t("Участник видит правильный ответ после проверки каждого вопроса. Разбор после завершения включается отдельно.")
                        : t("Ответы оцениваются после отправки. Показ правильных ответов после теста включается отдельно.")
                      : t(
                          "При скрытых результатах проверка и разбор недоступны.",
                        )
                  }
                >
                  <select
                    disabled={!quiz.settings.showScore}
                    value={quiz.settings.feedbackMode || "end"}
                    onChange={(e) =>
                      settings({
                        feedbackMode: e.target.value,
                      })
                    }
                  >
                    <option value="end">{t("Без проверки во время теста")}</option>
                    <option value="immediate">
                      {t("Проверять каждый ответ сразу")}
                    </option>
                  </select>
                </Field>
                <Field
                  label={t("Лимит времени, минут")}
                  hint={t(
                    "0 — без ограничения. Новый лимит считается от начала каждой попытки и действует на активные попытки.",
                  )}
                >
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    value={quiz.settings.timeLimitMinutes}
                    onChange={(e) =>
                      settings({
                        timeLimitMinutes: Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </fieldset>
              <Field
                label={t("Дедлайн (UTC)")}
                hint={t(
                  "После этой даты приём ответов заканчивается, активные попытки завершаются.",
                )}
              >
                <input
                  type="datetime-local"
                  value={
                    quiz.settings.deadline
                      ? new Date(quiz.settings.deadline)
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                  onChange={(e) =>
                    settings({
                      deadline: e.target.value
                        ? new Date(`${e.target.value}:00Z`).toISOString()
                        : null,
                    })
                  }
                />
              </Field>
              {quiz.settings.deadline && (
                <button
                  className="text-link muted"
                  onClick={() =>
                    settings({
                      deadline: null,
                    })
                  }
                >
                  <X size={14} />
                  {t(" Убрать дедлайн ")}
                </button>
              )}
            </section>
            <section className="panel settings-panel wide">
              <div className="section-heading">
                <div>
                  <h2>{t("Контроль нарушений")}</h2>
                </div>
                <ShieldCheck size={25} />
              </div>
              <fieldset>
                <Toggle
                  label={t("Одна попытка с IP-адреса")}
                  description={t("Один IP-адрес — одна попытка в этом квизе. Поддерживаются IPv4 и IPv6. В общей сети участники могут иметь один адрес.")}
                  checked={quiz.settings.oneAttemptPerIp}
                  onChange={(v) => settings({ oneAttemptPerIp: v })}
                />
                <Toggle
                  label={t("Контроль переключения окна")}
                  description={t(
                    "Уход со страницы или потеря фокуса — предупреждение. При достижении лимита попытка аннулируется. Пересдачу может разрешить администратор.",
                  )}
                  checked={quiz.settings.antiCheat}
                  onChange={(v) =>
                    settings({
                      antiCheat: v,
                    })
                  }
                />
                {quiz.settings.antiCheat && (
                  <Field
                    label={t("Лимит предупреждений")}
                    hint={t(
                      "По умолчанию 3. Новый лимит действует со следующего нарушения. Уже полученные предупреждения сохраняются.",
                    )}
                  >
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={quiz.settings.maxWarnings}
                      onChange={(e) =>
                        settings({
                          maxWarnings: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                )}
                <Toggle
                  label={t("Блокировать вставку")}
                  description={t(
                    "Запрещает вставку из буфера обмена; при включённом контроле фиксирует нарушение.",
                  )}
                  checked={quiz.settings.blockPaste}
                  onChange={(v) =>
                    settings({
                      blockPaste: v,
                    })
                  }
                />
                <Toggle
                  label={t("Перемешивать вопросы")}
                  description={t(
                    "У каждого участника свой порядок вопросов. Изменение действует на новые попытки.",
                  )}
                  checked={quiz.settings.shuffleQuestions}
                  onChange={(v) =>
                    settings({
                      shuffleQuestions: v,
                    })
                  }
                />
                <Toggle
                  label={t("Перемешивать варианты")}
                  description={t(
                    "Порядок ответов выбирается сервером один раз на попытку. Изменение действует на новые попытки.",
                  )}
                  checked={quiz.settings.shuffleOptions}
                  onChange={(v) =>
                    settings({
                      shuffleOptions: v,
                    })
                  }
                />
              </fieldset>
              <div className="info-banner subtle">
                <Info size={18} />
                <span>
                  {t(
                    " Контроль вкладок помогает соблюдать правила, но не определяет использование второго устройства. Для надёжной идентификации включите группы и персональные коды. ",
                  )}
                </span>
              </div>
            </section>
          </div>
        )}
        {tab === "groups" && (
          <section className="panel roster-panel">
            <div className="section-heading">
              <div>
                <h2>{t("Группы и студенты")}</h2>
              </div>
              <Users size={25} />
            </div>
            <fieldset>
              <Toggle
                label={t("Выбор из списка студентов")}
                description={t(
                  "Участник выбирает группу и своё имя. Каждое имя можно занять только один раз.",
                )}
                checked={quiz.settings.rosterEnabled}
                onChange={(v) =>
                  settings({
                    rosterEnabled: v,
                  })
                }
              />
              <Toggle
                label={t("Персональный код студента")}
                description={t(
                  "Передайте каждому его код отдельно. Один список имён не защищает от входа под чужим именем.",
                )}
                checked={quiz.settings.requireStudentCode}
                onChange={(v) =>
                  settings({
                    requireStudentCode: v,
                  })
                }
              />
              {quiz.settings.rosterEnabled &&
                !quiz.settings.requireStudentCode && (
                  <div className="inline-alert">
                    <AlertTriangle size={18} />
                    {t(
                      " Без кода любой участник сможет первым выбрать чужое имя. Рекомендуем включить персональные коды. ",
                    )}
                  </div>
                )}
            </fieldset>
            <fieldset>
              <div className="roster-groups">
                {quiz.groups.map((group, gi) => (
                  <div className="roster-group" key={group.id}>
                    <div className="roster-group-heading">
                      <span className="round-icon small">
                        <Users size={18} />
                      </span>
                      <input
                        aria-label={t("Название группы {value0}", {
                          value0: gi + 1,
                        })}
                        placeholder={t("Например, 25-13")}
                        value={group.name}
                        onChange={(e) =>
                          update({
                            groups: quiz.groups.map((g) =>
                              g.id === group.id
                                ? {
                                    ...g,
                                    name: e.target.value,
                                  }
                                : g,
                            ),
                          })
                        }
                      />
                      <button
                        className="icon-button danger-text"
                        aria-label={t("Удалить группу {value0}", {
                          value0: group.name,
                        })}
                        onClick={() =>
                          update({
                            groups: quiz.groups.filter(
                              (g) => g.id !== group.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                    <div className="roster-column-labels">
                      <span>{t("ИМЯ СТУДЕНТА")}</span>
                      <span>{t("ПЕРСОНАЛЬНЫЙ КОД")}</span>
                    </div>
                    {group.students.map((student, si) => (
                      <div className="student-row" key={student.id}>
                        <input
                          aria-label={t("Имя студента {value0} в {value1}", {
                            value0: si + 1,
                            value1: group.name,
                          })}
                          placeholder={t("Фамилия Имя")}
                          value={student.name}
                          onChange={(e) =>
                            update({
                              groups: quiz.groups.map((g) =>
                                g.id === group.id
                                  ? {
                                      ...g,
                                      students: g.students.map((s) =>
                                        s.id === student.id
                                          ? {
                                              ...s,
                                              name: e.target.value,
                                            }
                                          : s,
                                      ),
                                    }
                                  : g,
                              ),
                            })
                          }
                        />
                        <input
                          aria-label={t("Код студента {value0}", {
                            value0: student.name,
                          })}
                          value={student.code || ""}
                          placeholder={t("Индивидуальный код")}
                          onChange={(e) =>
                            update({
                              groups: quiz.groups.map((g) =>
                                g.id === group.id
                                  ? {
                                      ...g,
                                      students: g.students.map((s) =>
                                        s.id === student.id
                                          ? {
                                              ...s,
                                              code: e.target.value,
                                            }
                                          : s,
                                      ),
                                    }
                                  : g,
                              ),
                            })
                          }
                        />
                        <button
                          className="icon-button"
                          aria-label={t("Удалить студента {value0}", {
                            value0: student.name,
                          })}
                          onClick={() =>
                            update({
                              groups: quiz.groups.map((g) =>
                                g.id === group.id
                                  ? {
                                      ...g,
                                      students: g.students.filter(
                                        (s) => s.id !== student.id,
                                      ),
                                    }
                                  : g,
                              ),
                            })
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="text-link add-option"
                      onClick={() =>
                        update({
                          groups: quiz.groups.map((g) =>
                            g.id === group.id
                              ? {
                                  ...g,
                                  students: [
                                    ...g.students,
                                    {
                                      id: uid(),
                                      name: "",
                                      code: uid().slice(0, 8).toUpperCase(),
                                    },
                                  ],
                                }
                              : g,
                          ),
                        })
                      }
                    >
                      <Plus size={16} />
                      {t(" Добавить студента ")}
                    </button>
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                onClick={() =>
                  update({
                    groups: [
                      ...quiz.groups,
                      {
                        id: uid(),
                        name: "",
                        students: [],
                      },
                    ],
                  })
                }
              >
                <Plus size={17} />
                {t(" Добавить группу ")}
              </Button>
            </fieldset>
            <p className="help-note">
              <LockKeyhole size={15} />
              {t(
                " Имя и браузер закрепляются при старте. Завершённые и аннулированные попытки нельзя перезаписать. ",
              )}
            </p>
          </section>
        )}
        {tab === "share" && (
          <section className="panel share-panel">
            <h2>{t("Ссылка приглашения")}</h2>
            <p>{t("Отправьте эту ссылку участникам.")}</p>
            <div className="invite-copy">
              <input
                readOnly
                aria-label={t("Ссылка приглашения")}
                value={`${location.origin}/q/${quiz.slug}`}
                onFocus={(e) => e.target.select()}
              />
              <Button onClick={invite}>
                <Copy size={17} />
                <span>{t("Копировать")}</span>
              </Button>
            </div>
            <div className="share-status">
              <Badge status={quiz.status} />
              <span>
                {quiz.status === "published"
                  ? t("Участники могут начать квиз")
                  : t("Опубликуйте квиз, чтобы открыть доступ")}
              </span>
            </div>
            <a
              className="text-link"
              href={`/q/${quiz.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              {t(" Открыть страницу приглашения ")}
              <ExternalLink size={16} />
            </a>
            <div className="info-banner subtle">
              <Info size={18} />
              <span>
                {t(
                  " Ссылка использует текущий адрес сайта. После подключения домена открывайте кабинет через quiz.abzalnurlanuly.com. ",
                )}
              </span>
            </div>
          </section>
        )}
      </main>
      {addOpen && (
        <Modal title={t("Добавить вопрос")} onClose={() => setAddOpen(false)}>
          <p className="muted">{t("Выберите тип вопроса.")}</p>
          <div className="question-type-grid">
            {Object.entries(typeLabels).map(([type, label]) => (
              <button onClick={() => add(type)} key={type}>
                <span className="round-icon small">
                  {type === "single" ? (
                    <Circle size={20} />
                  ) : type === "multiple" ? (
                    <CheckSquare size={20} />
                  ) : type === "short" ? (
                    <Pencil size={20} />
                  ) : type === "matching" ? (
                    <Link2 size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </span>
                <div>
                  <strong>{t(label)}</strong>
                  <small>
                    {
                      {
                        single: t("Один верный вариант из нескольких"),
                        multiple: t("Все правильные варианты"),
                        short: t("Ответ своими словами"),
                        matching: t("Найти пары для понятий"),
                        content: t("Текст и изображение без оценки"),
                        truefalse: t("Определить верность утверждения"),
                        number: t("Число с допустимой погрешностью"),
                        ordering: t("Расставить элементы по порядку"),
                      }[type]
                    }
                  </small>
                </div>
                <Plus size={17} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {cloneOpen && <CloneDialog title={quiz.title} busy={cloning} onClose={() => !cloning && setCloneOpen(false)} onConfirm={clone} />}
    </AdminShell>
  );
}
function Report() {
  const { id } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [questionRevision, setQuestionRevision] = useState("current");
  const navigate = useNavigate();
  const legacyAttempt = new URLSearchParams(location.search).get("attempt");
  const participantRoute = (attemptId) => `/admin/quizzes/${id}/report/attempts/${encodeURIComponent(attemptId)}`;
  const [anonymize, setAnonymize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [attemptToDelete, setAttemptToDelete] = useState(null);
  const [attemptBusy, setAttemptBusy] = useState(false);
  const notify = useContext(ToastContext);
  const load = useCallback(() =>
    api(`/api/admin/quizzes/${id}/report`)
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((e) => setError(e.message)), [id]);
  const { connected, now } = useAdminLive(load, id);
  const deleteAttempt = async () => {
    setAttemptBusy(true);
    try {
      await api(`/api/admin/quizzes/${id}/attempts/${attemptToDelete.id}`, { method: "DELETE" });
      setAttemptToDelete(null);
      await load();
      notify("Результат участника удалён");
    } catch (e) {
      if (e.status === 404) {
          setAttemptToDelete(null);
        await load();
        notify("Результат уже удалён или заменён новой попыткой. Список обновлён.");
      } else notify(e.message, true);
    }
    finally { setAttemptBusy(false); }
  };
  const grantRetake = async (attempt) => {
    setAttemptBusy(true);
    try {
      await api(`/api/admin/quizzes/${id}/attempts/${attempt.id}/retake`, { method: "POST" });
      await load();
      notify("Пересдача разрешена. Участник сможет начать новую попытку.");
    } catch (e) {
      if (e.status === 404) {
        await load();
        notify("Результат уже удалён или заменён новой попыткой. Список обновлён.");
      } else notify(e.message, true);
    }
    finally { setAttemptBusy(false); }
  };
  const clearMetadata = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/quizzes/${id}/anonymize`, {
        method: "POST",
      });
      setAnonymize(false);
      await load();
      notify("IP-адреса и данные браузеров удалены. Результаты сохранены.");
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const attempts = (report?.attempts || []).filter(
    (a) =>
      (filter === "all" || a.status === filter) &&
      `${a.name || ""} ${a.group || ""}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const s = report?.summary || {};
  const currentRevision = report?.quiz.contentRevision || 1;
  const revisions = report?.revisions || [];
  const selectedRevision = questionRevision === "current" ? currentRevision : Number(questionRevision);
  const revisionReport = revisions.find((revision) => revision.contentRevision === selectedRevision);
  const questionStats = revisionReport?.questions || report?.questions || [];
  useEffect(() => { if (report && questionRevision !== "current" && !revisions.some((revision) => revision.contentRevision === Number(questionRevision))) setQuestionRevision("current"); }, [report, questionRevision]);
  const graded = report?.attempts.filter((a) => a.status !== "active" && (a.contentRevision || 1) === currentRevision) || [];
  const bins = [0, 0, 0, 0, 0];
  graded.forEach((a) => bins[Math.min(4, Math.floor((a.percent || 0) / 20))]++);
  const maxBin = Math.max(1, ...bins);
  const donutAngle = s.total ? ((s.submitted || 0) / s.total) * 360 : 0;
  if (legacyAttempt) return <Navigate replace to={participantRoute(legacyAttempt)} />;
  return (
    <AdminShell section="reports">
      <main className="workspace report-workspace">
        <div className="breadcrumb">
          <Link to="/admin">{t("Квизы")}</Link>
          <ChevronRight size={14} />
          <Link to={`/admin/quizzes/${id}`}>
            {report?.quiz.title || t("Квиз")}
          </Link>
          <ChevronRight size={14} />
          <span>{t("Результаты")}</span>
        </div>
        <div className="page-heading">
          <div>
            <h1>{t("Результаты")}</h1>
            <p>
              {report?.quiz.title || t("Отчёт по квизу")}
              {t(" · все даты в UTC")}
            </p>
          </div>
          <div className="heading-actions">
            <Button
              variant="secondary"
              onClick={load}
              aria-label={t("Обновить результаты")}
            >
              <RefreshCw size={17} />
            </Button>
            <Button onClick={() => setExportOpen(true)}>
              <Download size={17} />
              {t(" Скачать Excel ")}
            </Button>
          </div>
        </div>
        {error && (
          <div className="inline-alert">{t(error)}</div>
        )}
        {!report ? (
          <Loading />
        ) : (
          <>
            <div className="stat-grid four">
              <div className="stat">
                <span>
                  {t(" Всего участников ")}
                  <Users size={17} />
                </span>
                <strong>{s.total}</strong>
                <small>
                  {s.active || 0}
                  {t(" сейчас проходят")}
                </small>
              </div>
              <div className="stat">
                <span>
                  {t(" Завершили ")}
                  <CheckCircle2 size={17} />
                </span>
                <strong>{s.submitted || 0}</strong>
                <small>
                  {report.attempts.filter((a) => a.status === "expired").length}{" "}
                  {t(" по истечении времени ")}
                </small>
              </div>
              <div className="stat">
                <span>
                  {t(" Средний результат ")}
                  <BarChart3 size={17} />
                </span>
                <strong>
                  {s.averagePercent == null
                    ? "—"
                    : `${Math.round(s.averagePercent)}%`}
                </strong>
                <small>{t("Завершённые работы версии {number}", { number: currentRevision })}</small>
              </div>
              <div className="stat">
                <span>
                  {t(" Аннулированы ")}
                  <ShieldAlert size={17} />
                </span>
                <strong>{s.invalidated || 0}</strong>
                <small>{t("Правила честного участия")}</small>
              </div>
            </div>
            <LiveParticipants
              participants={report.attempts.filter((a) => a.status === "active")}
              connected={connected}
              now={now}
              onSelect={(a) => navigate(participantRoute(a.id))}
              onDelete={setAttemptToDelete}
            />
            <div className="report-charts">
              <section className="panel distribution">
                <div className="chart-heading">
                  <h3>{t("Распределение результатов")}</h3>
                  <small>
                    {graded.length}
                    {t(" завершённых попыток")}
                  </small>
                </div>
                {graded.length ? (
                  <div
                    className="bar-chart"
                    role="img"
                    aria-label={t(
                      "Распределение по диапазонам 0–19, 20–39, 40–59, 60–79, 80–100 процентов: {value0}",
                      {
                        value0: bins.join(", "),
                      },
                    )}
                  >
                    {bins.map((n, i) => (
                      <div className="bar-col" key={i}>
                        <strong>{n}</strong>
                        <div className="bar-well">
                          <span
                            style={{
                              height: `${(n / maxBin) * 100}%`,
                            }}
                          />
                        </div>
                        <small>
                          {["0–19", "20–39", "40–59", "60–79", "80–100"][i]}%
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="chart-empty">
                    <BarChart3 size={26} />
                    <p>{t("График появится после первых результатов.")}</p>
                  </div>
                )}
              </section>
              <section className="panel participation">
                <h3>{t("Участие")}</h3>
                <div
                  className="donut"
                  style={{
                    background: s.total
                      ? `conic-gradient(#111111 0deg ${donutAngle}deg,#999999 ${donutAngle}deg ${donutAngle + ((s.invalidated || 0) / s.total) * 360}deg,#eeeeee 0deg)`
                      : "#eeeeee",
                  }}
                >
                  <div>
                    <strong>{s.total}</strong>
                    <small>{t("попыток")}</small>
                  </div>
                </div>
                <div className="donut-legend">
                  <span>
                    <i />
                    {t(" Завершили")}
                    <b>{s.submitted || 0}</b>
                  </span>
                  <span>
                    <i className="soft" />
                    {t(" Аннулированы")}
                    <b>{s.invalidated || 0}</b>
                  </span>
                  <span>
                    <i className="pale" />
                    {t(" Другие ")}
                    <b>
                      {Math.max(
                        0,
                        (s.total || 0) -
                          (s.submitted || 0) -
                          (s.invalidated || 0),
                      )}
                    </b>
                  </span>
                </div>
              </section>
            </div>
            <section className="panel results-panel">
              <div className="section-heading">
                <div>
                  <h2>{t("Участники")}</h2>
                  <p className="muted">
                    {t(" Подробности попыток, время и журнал событий. ")}
                  </p>
                </div>
                <span className="count-pill">
                  {report.attempts.length}
                  {t(" участников ")}
                </span>
              </div>
              <div className="results-toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label={t("Поиск участника")}
                    placeholder={t("Имя или группа…")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <select
                  aria-label={t("Статус попытки")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{t("Все статусы")}</option>
                  {["submitted", "active", "expired", "invalidated"].map(
                    (k) => (
                      <option value={k} key={k}>
                        {t(statusLabel[k])}
                      </option>
                    ),
                  )}
                </select>
              </div>
              {!attempts.length ? (
                <Empty icon={Users} title={t("Нет участников")}>
                  {report.attempts.length
                    ? t("По вашему запросу нет участников.")
                    : t("Пригласите студентов — их результаты появятся здесь.")}
                </Empty>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("Участник")}</th>
                        <th>{t("Статус")}</th>
                        <th>{t("Результат")}</th>
                        <th>{t("Время")}</th>
                        <th>{t("Завершение · UTC")}</th>
                        <th>
                          <span className="sr-only">{t("Подробности")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((a) => (
                        <tr
                          key={a.id}
                          onClick={() => navigate(participantRoute(a.id))}
                          tabIndex={0}
                          onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && navigate(participantRoute(a.id))}
                          aria-label={t("Подробности: {value0}", {
                            value0: a.name || t("Без имени"),
                          })}
                        >
                          <td>
                            <div className="participant-name">
                              <span className="initial-avatar">
                                {(a.name || t("А")).charAt(0).toUpperCase()}
                              </span>
                              <div>
                                <Link className="participant-report-link" to={participantRoute(a.id)} onClick={(e) => e.stopPropagation()}>{a.name || t("Без имени")}</Link>
                                <small>{a.group || t("Без группы")} · {t("Версия {number}", { number: a.contentRevision || 1 })}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <Badge status={a.status} />
                            {a.status === "active" && <div className="table-presence"><PresenceBadge attempt={a} now={now} /></div>}
                          </td>
                          <td>
                            {a.status === "active" ? (
                              <AttemptProgress attempt={a} />
                            ) : (
                              <div className="score-cell">
                                <strong>{Math.round(a.percent || 0)}%</strong>
                                <small>
                                  {a.score ?? 0} / {a.maxScore ?? 0}
                                </small>
                              </div>
                            )}
                          </td>
                          <td className="tabular">
                            {duration(a.durationSeconds)}
                          </td>
                          <td className="table-date">
                            {a.finishedAt
                              ? utc(a.finishedAt).replace(" UTC", "")
                              : "—"}
                          </td>
                          <td>
                            <div className="attempt-row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                              {a.status === "invalidated" && <button className="icon-button" disabled={attemptBusy || a.retakeGranted} title={t(a.retakeGranted ? "Пересдача уже разрешена" : "Разрешить пересдачу")} aria-label={t("Разрешить пересдачу: {name}", { name: a.name || t("Без имени") })} onClick={() => grantRetake(a)}><RefreshCw size={16} /></button>}
                              <button className="icon-button danger-text" disabled={attemptBusy} title={t("Удалить результат")} aria-label={t("Удалить результат: {name}", { name: a.name || t("Без имени") })} onClick={() => setAttemptToDelete(a)}><Trash2 size={16} /></button>
                              <ChevronRight size={16} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel question-performance">
              <div className="section-heading">
                <div>
                  <h2>{t("Статистика по вопросам")}</h2>
                  <p className="muted">
                    {t("Статистика относится к версии {number}. Ответы разных версий не смешиваются.", { number: selectedRevision })}
                  </p>
                </div>
                {revisions.length > 1 ? <label className="revision-select"><span className="sr-only">{t("Версия вопросов")}</span><select aria-label={t("Версия вопросов")} value={questionRevision} onChange={(e) => setQuestionRevision(e.target.value)}><option value="current">{t("Текущая версия {number}", { number: currentRevision })}</option>{revisions.filter((revision) => revision.contentRevision !== currentRevision).map((revision) => <option key={revision.contentRevision} value={revision.contentRevision}>{t("Версия {number}", { number: revision.contentRevision })}</option>)}</select></label> : <ListChecks size={22} />}
              </div>
              {!questionStats.length ? (
                <p className="muted">{t("Пока нет вопросов для анализа.")}</p>
              ) : (
                questionStats.map((q, i) => (
                  <div className="performance-row" key={q.id}>
                    <span className="question-index">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{q.text}</strong>
                      <div className="progress-track">
                        <span
                          style={{
                            width: `${q.percent || 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="performance-value">
                      <strong>{Math.round(q.percent || 0)}%</strong>
                      <small>
                        {q.correct || 0} / {q.total || 0}
                      </small>
                    </div>
                  </div>
                ))
              )}
            </section>
            <div className="report-privacy">
              <div>
                <ShieldCheck size={20} />
                <span>
                  <strong>{t("Контроль над данными")}</strong>
                  <small>
                    {t(
                      " Удалите IP-адреса и данные браузеров. Оценки и блокировки попыток сохранятся. ",
                    )}
                  </small>
                </span>
              </div>
              <Button variant="secondary" onClick={() => setAnonymize(true)}>
                {t(" Удалить сетевые данные ")}
              </Button>
            </div>
          </>
        )}
      </main>
      {exportOpen && <ExportDialog id={id} onClose={() => setExportOpen(false)} />}
      {attemptToDelete && <AttemptDeleteDialog attempt={attemptToDelete} busy={attemptBusy} onClose={() => !attemptBusy && setAttemptToDelete(null)} onConfirm={deleteAttempt} />}
      {anonymize && (
        <Modal
          title={t("Удалить сетевые данные?")}
          onClose={() => setAnonymize(false)}
        >
          <p>
            {t(
              " IP-адреса и сведения о браузерах участников этого квиза будут удалены. Имена, оценки, журнал событий и запрет пересдачи сохранятся. Действие необратимо. ",
            )}
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setAnonymize(false)}>
              {t(" Отмена ")}
            </Button>
            <Button loading={busy} onClick={clearMetadata}>
              {t(" Удалить сетевые данные ")}
            </Button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
function StudentLayout({ children, title, danger = false }) {
  return (
    <div className={`student-page ${danger ? "danger" : ""}`}>
      <header className="public-header">
        <Brand />
        <div className="public-header-tools">
          <span className="student-header-label">{title || t("Квиз")}</span>
          <LanguageSwitcher />
        </div>
      </header>
      {children}
      <Footer />
    </div>
  );
}
function RulesDialog({ settings, busy, error, onClose, onAccept }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <Modal
      title={t("Правила перед началом")}
      variant="rules-modal"
      headerExtra={<LanguageSwitcher />}
      onClose={onClose}
      footer={
        <>
          {" "}
          <label className="consent-check">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>{t("Я прочитал(а) правила и принимаю условия.")}</span>
          </label>
          {error && (
            <div className="inline-alert" role="alert">
              {t(error)}
            </div>
          )}
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {t("Отмена")}
            </Button>
            <Button disabled={!accepted} loading={busy} onClick={onAccept}>
              {t("Принять и начать")}
              <ArrowRight size={20} />
            </Button>
          </div>
        </>
      }
    >
      <div className="rules-dialog-intro">
        <ShieldAlert size={30} />
        <p>
          {t(
            "Во время квиза оставайтесь на этой странице. Переключение вкладок, сворачивание браузера и переход в другое окно фиксируются как нарушения.",
          )}
        </p>
      </div>
      <dl className="rules-settings">
        <div>
          <dt>{t("Лимит времени")}</dt>
          <dd>
            {settings.timeLimitMinutes
              ? t("{minutes} мин", { minutes: settings.timeLimitMinutes })
              : t("Без ограничения")}
          </dd>
        </div>
        {settings.deadline && (
          <div>
            <dt>{t("Дедлайн (UTC)")}</dt>
            <dd>{utc(settings.deadline)}</dd>
          </div>
        )}
      </dl>
      <ul className="rules-list">
        <li>
          {t(
            "После {max} предупреждений попытка аннулируется: 0 баллов. Пересдача возможна только с разрешения администратора.",
            {
              max: settings.maxWarnings || 3,
            },
          )}
        </li>
        {settings.blockPaste && (
          <li>{t("Вставка из буфера обмена запрещена.")}</li>
        )}
        <li>
          {t(
            "Если вы включите полноэкранный режим, выход из него также считается нарушением.",
          )}
        </li>
        <li>
          {t(
            "Таймер и дедлайн проверяются сервером. Время продолжает идти при потере связи и закрытии страницы.",
          )}
        </li>
        <li>
          {t("В отчёте сохраняются IP-адрес, время в UTC и события контроля.")}
        </li>
      </ul>
      <p className="rules-caution">
        {t(
          "Системные уведомления и другие программы могут вызвать потерю фокуса. Закройте лишние окна перед началом.",
        )}
      </p>
      <p className="rules-limits">
        {t(
          "Контроль браузера не обнаруживает второе устройство и не гарантирует полную защиту от подсказок.",
        )}
      </p>
    </Modal>
  );
}
function readableAnswer(question, answer) {
  if (
    !question ||
    answer == null ||
    answer === "" ||
    (Array.isArray(answer) && !answer.length)
  )
    return t("Нет ответа");
  if (["single", "truefalse"].includes(question.type))
    return (
      question.options?.find((o) => o.id === answer)?.text || t("Нет ответа")
    );
  if (["multiple", "ordering"].includes(question.type))
    return (
      answer
        .map((id) => question.options?.find((o) => o.id === id)?.text)
        .filter(Boolean)
        .join(question.type === "ordering" ? " → " : "; ") || t("Нет ответа")
    );
  if (question.type === "matching")
    return question.pairs
      .map((pair) => `${pair.left} — ${answer[pair.id] || t("Нет ответа")}`)
      .join("; ");
  return String(answer);
}
function AnswerReview({ item, question, answer, compact = false }) {
  return (
    <article
      className={`answer-review ${item.correct ? "correct-feedback" : "wrong-feedback"} ${compact ? "compact-review" : ""}`}
      aria-live={compact ? "polite" : undefined}
    >
      {!compact && <h3>{question?.text || ""}</h3>}
      <div className="feedback-heading">
        {item.correct ? <CheckCircle2 size={25} /> : <X size={25} />}
        <strong>{t(item.correct ? "Ответ верный" : "Ответ неверный")}</strong>
        <span>
          {t("{points} из {max} баллов", {
            points: item.points,
            max: item.maxPoints,
          })}
        </span>
      </div>
      <div className="review-answer">
        <span>{t("Ваш ответ")}</span>
        <p>{readableAnswer(question, answer)}</p>
      </div>
      {!item.correct && (
        <div className="review-expected">
          <span>
            {t(
              item.expected.length > 1
                ? "Правильные ответы"
                : "Правильный ответ",
            )}
          </span>
          <ul>
            {item.expected.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {compact && (
        <p className="feedback-locked">
          <LockKeyhole size={16} />
          {t("Ответ зафиксирован")}
        </p>
      )}
    </article>
  );
}
function StudentEntry() {
  const { language } = useLanguage();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { slug } = useParams();
  const [quiz, setQuiz] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [studentId, setStudentId] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = (clearError = true) =>
    api(`/api/public/quizzes/${slug}`)
      .then((q) => {
        setQuiz(q);
        if (q.attempt) setAttempt(q.attempt);
        if (clearError === true) setError("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    setQuiz(null);
    setAttempt(null);
    load();
  }, [slug]);
  const executeStart = async (rulesAccepted = false, targetQuiz = quiz, retry = retrying) => {
    setBusy(true);
    setError("");
    try {
      const a = await api(`/api/public/quizzes/${slug}/start`, {
        method: "POST",
        body: {
          ...(retry ? {} : targetQuiz.settings.rosterEnabled
            ? {
                studentId,
                code,
              }
            : {
                name,
              }),
          rulesAccepted,
          language,
        },
      });
      if (retry && attempt?.id) {
        try { localStorage.removeItem(`forma-quiz-events-${attempt.id}`); } catch {}
      }
      setRulesOpen(false);
      setRetrying(false);
      setAttempt(a);
    } catch (e) {
      setError(e.message);
      load(false);
    } finally {
      setBusy(false);
    }
  };
  const start = (e) => {
    e.preventDefault();
    setRetrying(false);
    setError("");
    if (quiz.settings.antiCheat) setRulesOpen(true);
    else executeStart();
  };
  const retry = async () => {
    setBusy(true);
    setError("");
    setRetrying(true);
    try {
      const currentQuiz = await api(`/api/public/quizzes/${slug}`);
      setQuiz(currentQuiz);
      if (currentQuiz.settings.antiCheat) setRulesOpen(true);
      else await executeStart(false, currentQuiz, true);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const rulesDialog = rulesOpen && (
    <RulesDialog
      settings={{ ...defaults, ...quiz.settings }}
      busy={busy}
      error={t(error)}
      onClose={() => !busy && setRulesOpen(false)}
      onAccept={() => executeStart(true)}
    />
  );
  if (attempt)
    return (
      <>
      <StudentPlayer
        key={`${attempt.id}:${attempt.startedAt}`}
        initialAttempt={attempt}
        quiz={quiz}
        onRefresh={setAttempt}
        onRetry={retry}
        retryBusy={busy}
        retryError={error}
      />
      {rulesDialog}
      </>
    );
  if (!quiz)
    return (
      <StudentLayout>
        {error ? (
          <main className="student-entry">
            <Empty
              icon={Link2}
              title={t("Не удалось открыть квиз")}
              action={
                <Button variant="secondary" onClick={() => load()}>
                  <RefreshCw size={16} />
                  {t(" Повторить ")}
                </Button>
              }
            >
              {t(error)}
            </Empty>
          </main>
        ) : (
          <Loading />
        )}
      </StudentLayout>
    );
  const s = {
    ...defaults,
    ...quiz.settings,
  };
  const available =
    quiz.status === "published" &&
    (!s.deadline || Date.parse(s.deadline) > Date.now());
  const students = quiz.groups.find((g) => g.id === group)?.students || [];
  return (
    <StudentLayout>
      <main className="student-entry">
        <section className="entry-story">
          <h1>{quiz.title}</h1>
          {quiz.description && (
            <p className="entry-description">{quiz.description}</p>
          )}
          <div className="quiz-facts">
            <span>
              <ListChecks size={19} />
              <strong>{quiz.questionCount}</strong>
              {t(" вопросов ")}
            </span>
            <span>
              <Clock3 size={19} />
              {s.timeLimitMinutes
                ? t("{value0} мин", {
                    value0: s.timeLimitMinutes,
                  })
                : t("Без таймера")}
            </span>
            <span>
              <LockKeyhole size={19} />
              {t(" Одна попытка ")}
            </span>
          </div>
          {quiz.intro && (
            <div className="entry-intro">
              <h3>{t("Перед началом")}</h3>
              <p>{quiz.intro}</p>
            </div>
          )}
          {s.deadline && (
            <div className="entry-deadline">
              <Clock3 size={16} />
              {t("Доступен до {date}", { date: utc(s.deadline) })}
            </div>
          )}
        </section>
        <section className="entry-form panel">
          {!available ? (
            <Empty icon={LockKeyhole} title={t("Приём ответов закрыт")}>
              {quiz.status === "draft"
                ? t("Квиз ещё готовится. Администратор откроет его позже.")
                : t(
                    "Начать новую попытку сейчас нельзя. Обратитесь к администратору.",
                  )}
            </Empty>
          ) : (
            <>
              <h2>{t("Начать квиз")}</h2>
              <p className="muted">{t("Укажите свои данные перед началом.")}</p>
              <form onSubmit={start}>
                {s.rosterEnabled ? (
                  <>
                    <Field label={t("Группа")}>
                      <select
                        required
                        value={group}
                        onChange={(e) => {
                          setGroup(e.target.value);
                          setStudentId("");
                        }}
                      >
                        <option value="">{t("Выберите группу")}</option>
                        {quiz.groups.map((g) => (
                          <option value={g.id} key={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("Имя и фамилия")}>
                      <select
                        required
                        disabled={!group}
                        value={studentId}
                        onChange={(e) => setStudentId(e.target.value)}
                      >
                        <option value="">{t("Выберите себя в списке")}</option>
                        {students.map((st) => (
                          <option
                            key={st.id}
                            value={st.id}
                            disabled={!st.available}
                          >
                            {st.name}
                            {!st.available ? t(" — попытка уже занята") : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {(s.requireStudentCode || students.find((student) => student.id === studentId)?.requiresRetakeCode) && (
                      <Field
                        label={t("Персональный код")}
                        hint={t("Его вам передаёт администратор.")}
                      >
                        <input
                          autoComplete="off"
                          required
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          placeholder={t("Введите свой код")}
                        />
                      </Field>
                    )}
                  </>
                ) : (
                  <Field
                    label={
                      s.requireName
                        ? t("Имя и фамилия")
                        : t("Имя и фамилия (необязательно)")
                    }
                    hint={t("Имя закрепится за этой попыткой.")}
                  >
                    <input
                      autoComplete="name"
                      required={s.requireName}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={120}
                      placeholder={t("Введите имя и фамилию")}
                    />
                  </Field>
                )}
                <div
                  className={`rules-card ${s.antiCheat ? "controlled" : ""}`}
                >
                  <ShieldCheck size={21} />
                  <div>
                    <strong>
                      {s.antiCheat
                        ? t("Контроль нарушений включён")
                        : t("Одна попытка")}
                    </strong>
                    <p>
                      {s.antiCheat
                        ? t(
                            "Не переключайте вкладки, не сворачивайте браузер и не уходите в другие окна. За каждое переключение — предупреждение. Лимит: {value0}. При его достижении квиз аннулируется с нулевым результатом. ",
                            {
                              value0: s.maxWarnings,
                            },
                          )
                        : ""}
                      {s.blockPaste ? t("Вставка из буфера запрещена. ") : ""}
                      {t(
                        "После начала имя и браузер закрепляются. Самостоятельное повторное прохождение недоступно.",
                      )}{" "}
                      {s.oneAttemptPerIp && <>{t("С одного IP-адреса можно начать только одну попытку.")}{" "}</>}
                      {t("Администратор видит прогресс, активность вкладки и время последнего сигнала.")}{" "}
                      {s.timeLimitMinutes
                        ? t(
                            "Таймер продолжает идти, даже если вы закроете страницу.",
                          )
                        : ""}
                    </p>
                  </div>
                </div>
                <label className="consent-check">
                  <input
                    type="checkbox"
                    required
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    {t(
                      " Я прочитал(а) правила и готов(а) начать. Понимаю, что результат окончательный. ",
                    )}
                  </span>
                </label>
                {error && (
                  <div className="inline-alert" role="alert">
                    {t(error)}
                  </div>
                )}
                <Button
                  className="full-width"
                  disabled={!consent}
                  loading={busy}
                >
                  {t(" Начать квиз ")}
                  <ArrowRight size={18} />
                </Button>
                <p className="entry-privacy">
                  {t(
                    " В процессе сохраняются ответы, время, события контроля и IP-адрес для отчёта администратора. ",
                  )}
                </p>
              </form>
            </>
          )}
        </section>
      </main>
      {rulesDialog}
    </StudentLayout>
  );
}
function useAttemptLock(id, active) {
  const [state, setState] = useState({
    ready: false,
    duplicate: false,
  });
  useEffect(() => {
    if (!active) {
      setState({
        ready: true,
        duplicate: false,
      });
      return;
    }
    let release;
    let disposed = false;
    const key = `forma-quiz-attempt-${id}`;
    if (navigator.locks) {
      navigator.locks
        .request(
          key,
          {
            ifAvailable: true,
          },
          async (lock) => {
            if (disposed) return;
            setState({
              ready: true,
              duplicate: !lock,
            });
            if (lock)
              await new Promise((resolve) => {
                release = resolve;
              });
          },
        )
        .catch(() =>
          setState({
            ready: true,
            duplicate: true,
          }),
        );
    } else if (window.BroadcastChannel) {
      const channel = new BroadcastChannel(key);
      const token = uid();
      const candidates = new Set([token]);
      let owns = false;
      let blocked = false;
      const timer = setTimeout(() => {
        if (disposed || blocked) return;
        owns = [...candidates].sort()[0] === token;
        setState({
          ready: true,
          duplicate: !owns,
        });
      }, 400);
      channel.onmessage = (e) => {
        if (e.data.type === "hello") {
          if (owns)
            channel.postMessage({
              type: "owned",
              target: e.data.token,
            });
          else {
            candidates.add(e.data.token);
            channel.postMessage({
              type: "candidate",
              token,
            });
          }
        }
        if (e.data.type === "candidate") candidates.add(e.data.token);
        if (e.data.type === "owned" && e.data.target === token) {
          blocked = true;
          clearTimeout(timer);
          setState({
            ready: true,
            duplicate: true,
          });
        }
      };
      channel.postMessage({
        type: "hello",
        token,
      });
      release = () => {
        clearTimeout(timer);
        channel.close();
      };
    } else
      setState({
        ready: true,
        duplicate: false,
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [id, active]);
  return state;
}
function StudentPlayer({ initialAttempt, quiz, onRefresh, onRetry, retryBusy, retryError }) {
  const [attempt, setAttempt] = useState(initialAttempt);
  const [answers, setAnswers] = useState(initialAttempt.answers || {});
  const [index, setIndex] = useState(0);
  const [saveState, setSaveState] = useState("saved");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [warning, setWarning] = useState(null);
  const [tick, setTick] = useState(Date.now());
  const [error, setError] = useState("");
  const [removed, setRemoved] = useState(false);
  const latest = useRef(initialAttempt.answers || {});
  const attemptRef = useRef(initialAttempt);
  const timer = useRef();
  const chain = useRef(Promise.resolve());
  const eventFlight = useRef(null);
  const eventQueue = useRef([]);
  const lastEvent = useRef(0);
  const alive = useRef(true);
  const seenWarnings = useRef(initialAttempt.warnings || 0);
  const { ready, duplicate } = useAttemptLock(
    attempt.id,
    attempt.status === "active" && !removed,
  );
  const lockRef = useRef({
    ready,
    duplicate,
  });
  lockRef.current = {
    ready,
    duplicate,
  };
  const terminal = attempt.status !== "active" || removed;
  const storageKey = `forma-quiz-events-${attempt.id}`;
  const accept = useCallback(
    (a) => {
      if (!alive.current) return;
      if (attemptRef.current.status !== "active" && a.status === "active")
        return;
      if (a.status === "active") {
        const previous = attemptRef.current;
        const feedback = {
          ...(previous.feedback || {}),
          ...(a.feedback || {}),
        };
        const lockedAnswers = {};
        for (const questionId of Object.keys(feedback)) {
          const authoritative = a.feedback?.[questionId]
            ? a.answers
            : previous.answers;
          if (Object.hasOwn(authoritative || {}, questionId))
            lockedAnswers[questionId] = authoritative[questionId];
        }
        a = {
          ...a,
          warnings: Math.max(a.warnings || 0, previous.warnings || 0),
          feedback,
          answers: { ...a.answers, ...lockedAnswers },
        };
        if (Object.keys(lockedAnswers).length) {
          latest.current = { ...latest.current, ...lockedAnswers };
          setAnswers((current) => ({ ...current, ...lockedAnswers }));
        }
      }
      attemptRef.current = a;
      setAttempt(a);
      if (a.status !== "active") {
        setConfirm(false);
        setWarning(null);
        onRefresh?.(a);
      } else if (a.warnings > seenWarnings.current) {
        seenWarnings.current = a.warnings;
        setWarning(a.warnings);
      }
    },
    [onRefresh],
  );
  const currentQuestionId = attempt.questions?.[index]?.id;
  useEffect(() => {
    if (terminal || !ready || duplicate) return;
    let disposed = false;
    let inFlight = false;
    let pending = null;
    const send = async (payload) => {
      if (disposed || attemptRef.current.status !== "active") return;
      if (inFlight) {
        pending = payload;
        return;
      }
      inFlight = true;
      try {
        const updated = await api(`/api/public/attempts/${attempt.id}/presence`, {
          method: "POST",
          body: payload,
        });
        // accept() applies settings, warnings and checked answers only. Local
        // answer edits stay in answers/latest until their own save completes.
        if (!disposed) accept(updated);
      } catch (e) {
        if (!disposed && e.network) setOffline(true);
        if (!disposed && e.status === 404) setRemoved(true);
      } finally {
        inFlight = false;
        if (!disposed && pending) {
          const queued = pending;
          pending = null;
          send(queued);
        }
      }
    };
    const report = () => send({
      visibility: document.hidden ? "hidden" : "visible",
      focused: document.hasFocus(),
      ...(currentQuestionId ? { questionId: currentQuestionId } : {}),
    });
    const leave = () => {
      api(`/api/public/attempts/${attempt.id}/presence`, {
        method: "POST",
        keepalive: true,
        body: {
          visibility: "hidden",
          focused: false,
          ...(currentQuestionId ? { questionId: currentQuestionId } : {}),
        },
      }).catch(() => {});
    };
    report();
    const interval = setInterval(report, 10000);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    window.addEventListener("pagehide", leave);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      window.removeEventListener("pagehide", leave);
    };
  }, [terminal, ready, duplicate, attempt.id, currentQuestionId, accept]);
  useEffect(() => {
    alive.current = true;
    try {
      eventQueue.current = JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch {}
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [storageKey]);
  useEffect(() => {
    if (attempt.status !== "invalidated" || removed) return;
    let disposed = false;
    const refresh = () => api(`/api/public/attempts/${attempt.id}`).then((a) => {
      if (!disposed) accept(a);
    }).catch((e) => {
      if (!disposed && e.status === 404) setRemoved(true);
    });
    const interval = setInterval(refresh, 5000);
    const visible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [attempt.id, attempt.status, removed, accept]);
  const persistQueue = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(eventQueue.current));
    } catch {}
  };
  const flushEvents = useCallback(() => {
    if (eventFlight.current) return eventFlight.current;
    if (!eventQueue.current.length || attemptRef.current.status !== "active")
      return Promise.resolve();
    if (!navigator.onLine) {
      setOffline(true);
      const e = new Error(
        "Сначала восстановите соединение: события контроля ещё не отправлены.",
      );
      e.network = true;
      return Promise.reject(e);
    }
    if (!lockRef.current.ready || lockRef.current.duplicate)
      return Promise.reject(new Error("Продолжайте квиз в первой вкладке."));
    const task = (async () => {
      try {
        while (
          eventQueue.current.length &&
          attemptRef.current.status === "active"
        ) {
          const ev = eventQueue.current[0];
          const a = await api(`/api/public/attempts/${attempt.id}/events`, {
            method: "POST",
            body: ev,
          });
          eventQueue.current.shift();
          persistQueue();
          accept(a);
        }
        setOffline(false);
      } catch (e) {
        if (e.network) setOffline(true);
        else setError(e.message);
        throw e;
      } finally {
        eventFlight.current = null;
      }
    })();
    eventFlight.current = task;
    return task;
  }, [attempt.id, accept]);
  const recordEvent = useCallback(
    (type) => {
      if (
        attemptRef.current.status !== "active" ||
        !lockRef.current.ready ||
        lockRef.current.duplicate
      )
        return;
      const now = Date.now();
      if (now - lastEvent.current < 1500) return;
      lastEvent.current = now;
      eventQueue.current.push({
        type,
        eventId: uid(),
      });
      persistQueue();
      flushEvents().catch(() => {});
    },
    [flushEvents],
  );
  const save = useCallback(
    async (snapshot = latest.current) => {
      if (attemptRef.current.status !== "active" || lockRef.current.duplicate)
        return;
      setSaveState("saving");
      chain.current = chain.current
        .catch(() => {})
        .then(async () => {
          await flushEvents();
          if (attemptRef.current.status !== "active") return;
          const a = await api(`/api/public/attempts/${attempt.id}/answers`, {
            method: "PUT",
            body: {
              answers: snapshot,
            },
          });
          accept(a);
          setOffline(false);
          if (JSON.stringify(latest.current) === JSON.stringify(snapshot))
            setSaveState("saved");
        });
      try {
        await chain.current;
      } catch (e) {
        setSaveState("error");
        if (e.network) setOffline(true);
        else setError(e.message);
        throw e;
      }
    },
    [attempt.id, accept, flushEvents],
  );
  useEffect(() => {
    if (terminal || !ready || duplicate) return;
    const visibility = () => {
      if (document.hidden) recordEvent("visibility");
    };
    const blur = () => {
      if (attemptRef.current.settings.antiCheat) recordEvent("blur");
    };
    const paste = (e) => {
      if (attemptRef.current.settings.blockPaste) {
        e.preventDefault();
        recordEvent("paste");
      }
    };
    const fullscreen = () => {
      if (!document.fullscreenElement && fullscreenUsed.current)
        recordEvent("fullscreen");
    };
    const guard = (e) => {
      if (attemptRef.current.status === "active") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    if (attempt.settings.antiCheat) {
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("blur", blur);
      document.addEventListener("fullscreenchange", fullscreen);
    }
    document.addEventListener("paste", paste, true);
    window.addEventListener("beforeunload", guard);
    flushEvents().catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      document.removeEventListener("fullscreenchange", fullscreen);
      document.removeEventListener("paste", paste, true);
      window.removeEventListener("beforeunload", guard);
    };
  }, [
    terminal,
    ready,
    duplicate,
    recordEvent,
    flushEvents,
    attempt.settings.antiCheat,
  ]);
  useEffect(() => {
    if (terminal || !ready || duplicate) return;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        await flushEvents();
        const a = await api(`/api/public/attempts/${attempt.id}`);
        accept(a);
        if (a.status === "active" && saveState !== "saved")
          await save(latest.current);
        setOffline(false);
      } catch (e) {
        if (e.network) setOffline(true);
        if (e.status === 404) setRemoved(true);
      } finally {
        polling = false;
      }
    };
    const interval = setInterval(refresh, 5000);
    const online = () => {
      setOffline(false);
      refresh();
    };
    const off = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", off);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", off);
    };
  }, [
    terminal,
    ready,
    duplicate,
    attempt.id,
    accept,
    flushEvents,
    save,
    saveState,
  ]);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal]);
  const expiryRequested = useRef(false);
  useEffect(() => {
    if (
      !terminal &&
      attempt.expiresAt &&
      tick >= Date.parse(attempt.expiresAt) &&
      !expiryRequested.current &&
      ready &&
      !duplicate
    ) {
      expiryRequested.current = true;
      clearTimeout(timer.current);
      api(`/api/public/attempts/${attempt.id}`)
        .then(accept)
        .catch((e) => {
          if (e.network) setOffline(true);
          expiryRequested.current = false;
        });
    }
  }, [tick, attempt.expiresAt, terminal, ready, duplicate, accept]);
  const checkQuestion = async (questionId) => {
    if (
      checking ||
      submitting ||
      offline ||
      attemptRef.current.feedback?.[questionId]
    )
      return;
    setChecking(true);
    setError("");
    clearTimeout(timer.current);
    try {
      await save(latest.current);
      await flushEvents();
      if (attemptRef.current.status !== "active") return;
      const result = await api(`/api/public/attempts/${attempt.id}/check`, {
        method: "POST",
        body: {
          questionId,
          answer: latest.current[questionId],
        },
      });
      accept(result);
    } catch (e) {
      setError(e.message);
      if (e.network) setOffline(true);
    } finally {
      setChecking(false);
    }
  };
  const updateAnswer = (qid, value) => {
    if (
      terminal ||
      duplicate ||
      submitting ||
      checking ||
      offline ||
      attemptRef.current.feedback?.[qid]
    )
      return;
    const next = {
      ...latest.current,
      [qid]: value,
    };
    latest.current = next;
    setAnswers(next);
    setSaveState("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      save(next).catch(() => {});
    }, 450);
  };
  const submit = async () => {
    setSubmitting(true);
    setError("");
    clearTimeout(timer.current);
    try {
      await flushEvents();
      if (attemptRef.current.status !== "active") return;
      await save(latest.current);
      await flushEvents();
      if (attemptRef.current.status !== "active") return;
      const a = await api(`/api/public/attempts/${attempt.id}/submit`, {
        method: "POST",
        body: {
          answers: latest.current,
        },
      });
      accept(a);
    } catch (e) {
      setError(e.message);
      if (e.network) setOffline(true);
    } finally {
      setSubmitting(false);
    }
  };
  const fullscreenUsed = useRef(false);
  const full = async () => {
    try {
      await document.documentElement.requestFullscreen();
      fullscreenUsed.current = true;
    } catch {
      setError(
        "Браузер не поддерживает полноэкранный режим. Можно продолжать в этом окне.",
      );
    }
  };
  if (removed) return <StudentLayout><main className="student-entry single"><Empty icon={Trash2} title={t("Попытка удалена администратором")} action={<Button onClick={() => location.reload()}>{t("Вернуться к началу квиза")}</Button>}>{t("Ответы этой попытки больше не принимаются. Вы можете открыть квиз заново.")}</Empty></main></StudentLayout>;
  if (terminal) return <TerminalResult attempt={attempt} quiz={quiz} onRetry={onRetry} retryBusy={retryBusy} retryError={retryError} />;
  if (!ready)
    return (
      <StudentLayout>
        <Loading />
      </StudentLayout>
    );
  if (duplicate)
    return (
      <StudentLayout>
        <main className="student-entry single">
          <Empty
            icon={LockKeyhole}
            title={t("Квиз открыт в другой вкладке")}
            action={
              <Button variant="secondary" onClick={() => location.reload()}>
                <RefreshCw size={17} />
                {t(" Проверить ещё раз ")}
              </Button>
            }
          >
            {t(
              " Продолжайте в первой вкладке. Одновременное прохождение одной попытки в нескольких вкладках недоступно. Если первая вкладка закрыта, обновите эту страницу. ",
            )}
          </Empty>
        </main>
      </StudentLayout>
    );
  const questions = attempt.questions || [];
  const question = questions[index];
  const immediate =
    attempt.settings.feedbackMode === "immediate" &&
    attempt.settings.showScore !== false;
  const questionFeedback = immediate ? attempt.feedback?.[question?.id] : null;
  const answered = (q) => {
    const a = answers[q.id];
    return (
      q.type === "content" ||
      (q.type === "number" && typeof a === "number" && Number.isFinite(a)) ||
      (typeof a === "string"
        ? !!a.trim()
        : Array.isArray(a)
          ? a.length > 0
          : a && Object.values(a).filter(Boolean).length === q.pairs?.length)
    );
  };
  const graded = questions.filter((q) => q.type !== "content");
  const answeredCount = graded.filter(answered).length;
  const remaining = attempt.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(attempt.expiresAt) - tick) / 1000))
    : null;
  return (
    <StudentLayout title={t("Прохождение квиза")}>
      <main className="player">
        <div className="player-topline">
          <div>
            <h1>{quiz?.title || t("Ваш квиз")}</h1>
            <p>
              {attempt.name}
              {attempt.group ? ` · ${attempt.group}` : ""}
            </p>
          </div>
          <div className="player-controls">
            {attempt.settings.antiCheat && (
              <span className="integrity-pill">
                <ShieldCheck size={15} />
                <span>
                  {attempt.warnings || 0} / {attempt.maxWarnings || 3}
                </span>
              </span>
            )}
            {remaining != null && (
              <div
                className={`timer ${remaining < 60 ? "urgent" : ""}`}
                role="timer"
                aria-label={t("Осталось {value0}", {
                  value0: duration(remaining),
                })}
              >
                <Clock3 size={17} />
                {duration(remaining)}
              </div>
            )}
            <button
              className="icon-button fullscreen-button"
              onClick={full}
              aria-label={t("Полноэкранный режим")}
            >
              <Maximize2 size={19} />
            </button>
          </div>
        </div>
        <div className="player-progress">
          <span
            style={{
              width: `${graded.length ? (answeredCount / graded.length) * 100 : 0}%`,
            }}
          />
        </div>
        <div className="player-progress-caption">
          <span>
            {t("{count} из {total} вопросов отвечено", {
              count: answeredCount,
              total: graded.length,
            })}
          </span>
          <span className={`save-indicator ${saveState}`} aria-live="polite">
            {saveState === "saved" ? (
              <>
                <Check size={13} />
                {t(" Сохранено ")}
              </>
            ) : saveState === "saving" ? (
              <>
                <LoaderCircle size={13} className="spin" />
                {t(" Сохраняем… ")}
              </>
            ) : saveState === "error" ? (
              <>{t("Не сохранено")}</>
            ) : (
              <>{t("Ожидает сохранения…")}</>
            )}
          </span>
        </div>
        {offline && (
          <div className="offline-banner" role="alert">
            <WifiOff size={20} />
            <div>
              <strong>{t("Соединение прервано")}</strong>
              <p>
                {t(
                  " Не закрывайте страницу. Ответы в этой вкладке сохранятся после восстановления связи. Таймер продолжает идти. ",
                )}
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                save(latest.current).catch(() => {});
              }}
            >
              {t(" Повторить ")}
            </Button>
          </div>
        )}
        {error && (
          <div className="inline-alert" role="alert">
            {t(error)}
            <button
              className="icon-button"
              aria-label={t("Закрыть ошибку")}
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="player-body">
          <aside className="player-map">
            <div className="question-dots">
              {questions.map((q, i) => (
                <button
                  key={q.id}
                  className={`${i === index ? "current" : ""} ${answered(q) ? "answered" : ""}`}
                  onClick={() => setIndex(i)}
                  aria-label={t("Вопрос {value0}{value1}", {
                    value0: i + 1,
                    value1: answered(q) ? t(", отвечен") : "",
                  })}
                  aria-current={i === index ? "step" : undefined}
                >
                  {q.type === "content" ? (
                    <FileText size={16} />
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </button>
              ))}
            </div>
            <p>
              {t(" Можно возвращаться ")}
              <br />
              {t("и менять ответы до отправки. ")}
            </p>
          </aside>
          <section className="player-question panel" key={question?.id}>
            {question ? (
              <>
                <div className="question-caption">
                  <span>
                    {t(" ВОПРОС ")}
                    {String(index + 1).padStart(2, "0")}{" "}
                    <span>/ {String(questions.length).padStart(2, "0")}</span>
                  </span>
                  <small>{t(typeLabels[question.type])}</small>
                </div>
                <h2>{question.text}</h2>
                {question.image && (
                  <img
                    className="question-image"
                    src={question.image}
                    alt={t("Иллюстрация к вопросу")}
                  />
                )}
                <fieldset
                  disabled={
                    submitting ||
                    checking ||
                    offline ||
                    remaining === 0 ||
                    !!questionFeedback
                  }
                  className="student-answers"
                >
                  {["single", "multiple", "truefalse"].includes(question.type) && (
                    <>
                      <p className="answer-hint">
                        {["single", "truefalse"].includes(question.type)
                          ? t("Выберите один вариант ответа.")
                          : t("Выберите все правильные варианты.")}
                      </p>
                      {question.options.map((o, i) => {
                        const chosen =
                          ["single", "truefalse"].includes(question.type)
                            ? answers[question.id] === o.id
                            : (answers[question.id] || []).includes(o.id);
                        return (
                          <label
                            className={`student-option ${chosen ? "chosen" : ""}`}
                            key={o.id}
                          >
                            <input
                              type={
                                ["single", "truefalse"].includes(question.type)
                                  ? "radio"
                                  : "checkbox"
                              }
                              name={`answer-${question.id}`}
                              checked={chosen}
                              onChange={() =>
                                updateAnswer(
                                  question.id,
                                  ["single", "truefalse"].includes(question.type)
                                    ? o.id
                                    : chosen
                                      ? (answers[question.id] || []).filter(
                                          (v) => v !== o.id,
                                        )
                                      : [...(answers[question.id] || []), o.id],
                                )
                              }
                            />
                            <span className="answer-letter">
                              {String.fromCharCode(65 + i)}
                            </span>
                            <span>{o.text}</span>
                            <span className="answer-check">
                              {chosen ? (
                                <Check size={18} />
                              ) : ["single", "truefalse"].includes(question.type) ? (
                                <Circle size={20} />
                              ) : (
                                <Square size={20} />
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </>
                  )}
                  {question.type === "short" && (
                    <Field label={t("Ответ")}>
                      <textarea
                        rows={4}
                        maxLength={2000}
                        value={answers[question.id] || ""}
                        onChange={(e) =>
                          updateAnswer(question.id, e.target.value)
                        }
                        placeholder={t("Напишите ответ здесь…")}
                      />
                    </Field>
                  )}
                  {question.type === "number" && <Field label={t("Числовой ответ")}><input type="number" step="any" value={answers[question.id] ?? ""} onChange={(e)=>updateAnswer(question.id,e.target.value===""?"":Number(e.target.value))} placeholder={t("Введите число")}/></Field>}
                  {question.type === "ordering" && <div className="student-ordering"><p className="answer-hint">{t("Расположите элементы в правильном порядке с помощью стрелок.")}</p>{(Array.isArray(answers[question.id])&&answers[question.id].length?answers[question.id]:question.options.map((item)=>item.id)).map((optionId,optionIndex,order)=>{
                    const option=question.options.find((item)=>item.id===optionId);
                    if(!option)return null;
                    const reorder=(delta)=>{const next=[...order];[next[optionIndex],next[optionIndex+delta]]=[next[optionIndex+delta],next[optionIndex]];updateAnswer(question.id,next);};
                    return <div className="ordering-row student-order-row" key={optionId}><span className="option-letter">{optionIndex+1}</span><span className="ordering-text">{option.text}</span><button className="icon-button" disabled={optionIndex===0} onClick={()=>reorder(-1)} aria-label={t("Переместить {text} выше",{text:option.text})}><ChevronUp size={20}/></button><button className="icon-button" disabled={optionIndex===order.length-1} onClick={()=>reorder(1)} aria-label={t("Переместить {text} ниже",{text:option.text})}><ChevronDown size={20}/></button></div>;
                  })}{!answers[question.id]?.length&&<Button variant="secondary" onClick={()=>updateAnswer(question.id,question.options.map((item)=>item.id))}><Check size={17}/>{t("Подтвердить этот порядок")}</Button>}</div>}
                  {question.type === "matching" && (
                    <>
                      <p className="answer-hint">
                        {t(" Найдите соответствие для каждой строки. ")}
                      </p>
                      {question.pairs.map((pair, i) => (
                        <div className="student-pair" key={pair.id}>
                          <span>
                            <small>{String(i + 1).padStart(2, "0")}</small>
                            {pair.left}
                          </span>
                          <ArrowRight size={17} />
                          <select
                            aria-label={t("Соответствие для {value0}", {
                              value0: pair.left,
                            })}
                            value={answers[question.id]?.[pair.id] || ""}
                            onChange={(e) =>
                              updateAnswer(question.id, {
                                ...(answers[question.id] || {}),
                                [pair.id]: e.target.value,
                              })
                            }
                          >
                            <option value="">
                              {t("Выберите соответствие")}
                            </option>
                            {question.choices.map((choice) => (
                              <option value={choice} key={choice}>
                                {choice}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </>
                  )}
                  {question.type === "content" && (
                    <p className="content-note">
                      <Info size={17} />
                      {t(
                        " Эта страница для ознакомления. Ответ не требуется. ",
                      )}
                    </p>
                  )}
                </fieldset>
                {immediate &&
                  question.type !== "content" &&
                  (questionFeedback ? (
                    <AnswerReview
                      item={questionFeedback}
                      question={question}
                      answer={answers[question.id]}
                      compact
                    />
                  ) : (
                    <div className="check-answer">
                      <p>{t("После проверки изменить ответ нельзя.")}</p>
                      <Button
                        loading={checking}
                        disabled={offline || submitting || !answered(question)}
                        onClick={() => checkQuestion(question.id)}
                      >
                        <CheckCircle2 size={20} />
                        {t("Проверить ответ")}
                      </Button>
                    </div>
                  ))}
                <div className="player-navigation">
                  <Button
                    variant="secondary"
                    disabled={index === 0 || submitting || checking}
                    onClick={() => setIndex(index - 1)}
                  >
                    <ArrowLeft size={17} />
                    <span>{t("Назад")}</span>
                  </Button>
                  <span>
                    {index + 1} / {questions.length}
                  </span>
                  {index === questions.length - 1 ? (
                    <Button
                      disabled={offline || submitting || checking}
                      onClick={() => setConfirm(true)}
                    >
                      {t(" Завершить ")}
                      <Check size={17} />
                    </Button>
                  ) : (
                    <Button onClick={() => setIndex(index + 1)}>
                      {t(" Далее ")}
                      <ArrowRight size={17} />
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <Empty title={t("Вопросов нет")}>
                {t("Обратитесь к администратору.")}
              </Empty>
            )}
          </section>
        </div>
        <div className="player-bottom">
          <LockKeyhole size={14} />
          {t(" Ответы сохраняются на сервере. ")}
          <button
            className="text-link"
            onClick={() => setConfirm(true)}
            disabled={offline || submitting || checking}
          >
            {t(" Завершить досрочно ")}
            <ArrowUpRight size={14} />
          </button>
        </div>
      </main>
      {confirm && (
        <Modal
          title={t("Готовы завершить?")}
          onClose={() => !submitting && setConfirm(false)}
        >
          <p>
            {t("Вы ответили на {count} из {total} вопросов.", {
              count: answeredCount,
              total: graded.length,
            })}{" "}
            {answeredCount < graded.length
              ? t("На вопросы без ответа будет начислено 0 баллов. ")
              : ""}
            {t(" После отправки изменить ответы или начать заново нельзя. ")}
          </p>
          {error && <div className="inline-alert">{t(error)}</div>}
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => setConfirm(false)}
            >
              {t(" Вернуться к вопросам ")}
            </Button>
            <Button loading={submitting} disabled={offline} onClick={submit}>
              {t(" Отправить ответы ")}
              <Check size={17} />
            </Button>
          </div>
        </Modal>
      )}
      {warning != null && (
        <div
          className="warning-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-label={t("Предупреждение о нарушении")}
        >
          <div className="warning-icon">
            <ShieldAlert size={67} />
          </div>
          <span className="warning-counter">
            {t("Предупреждение {count} / {max}", {
              count: warning,
              max: attempt.maxWarnings || 3,
            })}
          </span>
          <h2>{t("Не покидайте страницу квиза")}</h2>
          <p>
            {t(" Зафиксировано нарушение правил участия. ")}
            <br />
            {(attempt.maxWarnings || 3) - warning === 1
              ? t("Следующее предупреждение аннулирует вашу попытку.")
              : t("Осталось предупреждений: {value0}.", {
                  value0: (attempt.maxWarnings || 3) - warning,
                })}
            <br />
            {t(" Не переключайте вкладки и окна во время прохождения. ")}
          </p>
          <button className="button" autoFocus onClick={() => setWarning(null)}>
            {t(" Я понимаю, продолжить ")}
            <ArrowRight size={18} />
          </button>
          <span className="warning-note">
            {t(" Нарушение сохранено в отчёте администратора. ")}
          </span>
        </div>
      )}
    </StudentLayout>
  );
}
function TerminalResult({ attempt, quiz, onRetry, retryBusy, retryError }) {
  const bad = attempt.status === "invalidated";
  const scoreVisible = attempt.percent != null;
  return (
    <StudentLayout danger={bad}>
      <main className={`terminal-result ${bad ? "invalidated" : ""}`}>
        <div className="result-symbol">
          {bad ? <ShieldAlert size={42} /> : <Check size={43} />}
        </div>

        <h1>{bad ? t("Попытка аннулирована") : t("Квиз завершён")}</h1>
        <p className="result-description">
          {bad
            ? t(
                "Достигнут лимит предупреждений. Попытка завершена с нулевым результатом. Администратор может разрешить пересдачу.",
              )
            : attempt.status === "expired"
              ? t(
                  "Время квиза истекло. Сервер завершил попытку и оценил последние сохранённые ответы.",
                )
              : t("Ответы отправлены. Результат сохранён.")}
        </p>
        {bad && attempt.retakeGranted && <div className="retake-granted"><p>{t("Администратор разрешил пересдачу. Таймер начнётся после нажатия кнопки и принятия правил.")}</p><Button loading={retryBusy} onClick={onRetry}><RefreshCw size={18} />{t("Начать заново")}</Button></div>}
        {retryError && <div className="inline-alert" role="alert">{t(retryError)}</div>}
        {scoreVisible && !bad && (
          <div className="result-score">
            <strong>
              {Math.round(attempt.percent)}
              <span>%</span>
            </strong>
            <div>
              <span>{t("ВАШ РЕЗУЛЬТАТ")}</span>
              <p>
                {t("{score} из {max} баллов", {
                  score: attempt.score,
                  max: attempt.maxScore,
                })}
              </p>
            </div>
          </div>
        )}
        {!scoreVisible && !bad && (
          <div className="result-hidden">
            <LockKeyhole size={19} />
            {t(" Результат доступен администратору. ")}
          </div>
        )}
        <div className="result-meta">
          <div>
            <span>{t("УЧАСТНИК")}</span>
            <strong>
              {attempt.name || t("Без имени")}
              {attempt.group ? ` · ${attempt.group}` : ""}
            </strong>
          </div>
          <div>
            <span>{t("ЗАВЕРШЕНО")}</span>
            <strong>{utc(attempt.finishedAt)}</strong>
          </div>
          <div>
            <span>{t("СТАТУС")}</span>
            <Badge status={attempt.status} />
          </div>
        </div>
        {quiz?.outro && !bad && <p className="result-outro">{quiz.outro}</p>}
        {!bad &&
          attempt.settings.showScore !== false &&
          attempt.settings.showCorrectAnswersAfterTest === true &&
          attempt.review?.length > 0 && (
            <section className="answer-review-list">
              <h2>{t("Разбор ответов")}</h2>
              {attempt.review.map((item) => {
                const question = attempt.questions.find(
                  (q) => q.id === item.questionId,
                );
                return (
                  <AnswerReview
                    key={item.questionId}
                    item={item}
                    question={question}
                    answer={attempt.answers?.[item.questionId]}
                  />
                );
              })}
            </section>
          )}
        <p className="terminal-note">
          <LockKeyhole size={15} />
          {t(bad ? "Пересдача доступна только с разрешения администратора." : "Эта попытка окончательная. Повторное прохождение недоступно.")}
        </p>
        <Link to="/" className="text-link">
          {t(" На главную ")}
          <ArrowUpRight size={17} />
        </Link>
      </main>
    </StudentLayout>
  );
}
function NotFound() {
  return (
    <StudentLayout>
      <main className="student-entry single">
        <Empty
          icon={Search}
          title={t("Страница не найдена")}
          action={
            <Link className="button primary" to="/">
              {t(" На главную ")}
              <ArrowRight size={17} />
            </Link>
          }
        >
          {t(" Проверьте ссылку приглашения или вернитесь на главную. ")}
        </Empty>
      </main>
    </StudentLayout>
  );
}
const sharedUi = { api, AdminShell, Button, Field, Toggle, Modal, Loading, Empty, LiveConnection, useAdminLive, utc, uid, statusLabel, Brand, StudentLayout, ExportDialog, CloneDialog, Badge, duration, PresenceBadge, AttemptProgress, AttemptDeleteDialog, readableAnswer, typeLabels, actionLabels, useToast: () => useContext(ToastContext) };
function App() {
  useLanguage();
  return (
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<Loading />}><Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/admin"
            element={
              <AdminGate>
                <Dashboard />
              </AdminGate>
            }
          />
          <Route path="/admin/live" element={<AdminGate><LivePage /></AdminGate>} />
          <Route path="/admin/reports" element={<AdminGate><ReportsCenter /></AdminGate>} />
          <Route path="/admin/surveys" element={<AdminGate><SurveyList ui={sharedUi} /></AdminGate>} />
          <Route path="/admin/surveys/:id" element={<AdminGate><SurveyEditor ui={sharedUi} /></AdminGate>} />
          <Route path="/admin/surveys/:id/report" element={<AdminGate><SurveyReport ui={sharedUi} /></AdminGate>} />
          <Route path="/admin/surveys/:id/report/responses/:responseId" element={<AdminGate><SurveyResponsePage ui={sharedUi} /></AdminGate>} />
          <Route path="/s/:slug" element={<PublicSurvey ui={sharedUi} />} />
          <Route
            path="/admin/quizzes/:id"
            element={
              <AdminGate>
                <QuizEditor />
              </AdminGate>
            }
          />
          <Route
            path="/admin/quizzes/:id/report"
            element={
              <AdminGate>
                <Report />
              </AdminGate>
            }
          />
          <Route path="/q/:slug" element={<StudentEntry />} />
          <Route path="/admin/quizzes/:id/report/attempts/:attemptId" element={<AdminGate><QuizAttemptPage ui={sharedUi} /></AdminGate>} />
          <Route path="*" element={<NotFound />} />
        </Routes></Suspense>
      </ToastProvider>
    </BrowserRouter>
  );
}
createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <App />
  </LanguageProvider>,
);
