import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus, ArrowLeft, ArrowRight, ArrowUpRight, ArrowUp, ArrowDown, Copy, Trash2, Save, Eye, Search, BarChart3, FileText, Settings, Palette, Link2, Download, Check, X, ImagePlus, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";
import { useLanguage, LanguageSwitcher, t } from "./i18n.jsx";
import "./surveys.css";

const fieldTypes = { short: "Короткий текст", long: "Длинный текст", single: "Один вариант", multiple: "Несколько вариантов", dropdown: "Выпадающий список", rating: "Рейтинг", scale: "Шкала", number: "Число", date: "Дата", content: "Информационный блок" };
const defaultSettings = { anonymous: true, collectName: false, collectIp: false, collectUserAgent: false, oneResponsePerIp: false, oneResponsePerBrowser: false };
const defaultTheme = { backgroundColor: "#f5f5f5", surfaceColor: "#ffffff", accentColor: "#111111", textColor: "#171717", font: "sans", layout: "card", logo: null, cover: null };
const normalSurvey = (s) => ({ ...s, questions: s.questions || s.fields || [], settings: { ...defaultSettings, ...s.settings }, theme: { ...defaultTheme, ...s.theme } });
const choiceTypes = ["single", "multiple", "dropdown"];
const localDateTime = (value) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
const isEmpty = (value) => value == null || value === "" || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
const answerFor = (answers, id) => answers && Object.hasOwn(answers, id) ? answers[id] : undefined;
function SurveyBadge({ status }) { return <span className={`badge ${status}`}><i />{t({ draft: "Черновик", published: "Опубликован", closed: "Закрыт" }[status] || status)}</span>; }
function SurveyVersion({ revision }) { return <span className="survey-version-badge">{t("Версия {number}", { number: revision || 1 })}</span>; }
function ErrorBox({ error }) { return error ? <div className="inline-alert" role="alert"><AlertTriangle size={17} />{t(error)}</div> : null; }
function ConfirmDialog({ ui, title, children, busy, onClose, onConfirm, action, danger = false }) { const { Modal, Button } = ui; return <Modal title={t(title)} onClose={() => !busy && onClose()}><p>{children}</p><div className="modal-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t("Отмена")}</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{t(action)}</Button></div></Modal>; }

export function SurveyList({ ui }) {
  useLanguage();
  const { api, AdminShell, Button, Loading, Empty, useAdminLive, LiveConnection } = ui;
  const notify = ui.useToast();
  const navigate = useNavigate();
  const [surveys, setSurveys] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);
  const load = useCallback(async () => { try { const r = await api("/api/admin/surveys"); setSurveys(r.surveys); setError(""); } catch (e) { setError(e.message); } }, [api]);
  const { connected } = useAdminLive(load);
  const create = async () => { setBusy(true); try { const r = await api("/api/admin/surveys", { method: "POST", body: { title: t("Новый опрос") } }); navigate(`/admin/surveys/${r.id}`); } catch (e) { notify(e.message, true); } finally { setBusy(false); } };
  const act = async () => { setBusy(true); try { const r = await api(`/api/admin/surveys/${confirm.survey.id}${confirm.type === "clone" ? "/clone" : ""}`, { method: confirm.type === "clone" ? "POST" : "DELETE" }); setConfirm(null); if (confirm.type === "clone") navigate(`/admin/surveys/${r.id}`); else { await load(); notify("Опрос удалён"); } } catch (e) { notify(e.message, true); } finally { setBusy(false); } };
  const visible = (surveys || []).filter((s) => (filter === "all" || s.status === filter) && `${s.title} ${s.description || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <AdminShell section="surveys"><main className="workspace"><div className="page-heading"><div><h1>{t("Опросы")}</h1><p>{t("Собирайте мнения. Без баллов и правильных ответов.")}</p></div><Button onClick={create} loading={busy}><Plus size={18} />{t("Создать опрос")}</Button></div>
    <div className="stat-grid"><div className="stat"><span>{t("Всего опросов")}<FileText size={17} /></span><strong>{surveys?.length ?? "—"}</strong><small>{t("Создано всего")}</small></div><div className="stat"><span>{t("Опубликованные")}<span className="live-dot" /></span><strong>{surveys?.filter((s) => s.status === "published").length ?? "—"}</strong><small>{t("Принимают ответы")}</small></div><div className="stat"><span>{t("Всего ответов")}<BarChart3 size={17} /></span><strong>{surveys?.reduce((n, s) => n + (s.submittedCount ?? s.responseCount ?? 0), 0) ?? "—"}</strong><small>{t("Во всех опросах")}</small></div></div>
    <ErrorBox error={error} /><div className="collection-toolbar"><div className="tabs">{[["all", "Все опросы"], ["published", "Опубликованные"], ["draft", "Черновики"], ["closed", "Закрытые"]].map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{t(label)}</button>)}</div><label className="search"><Search size={17} /><input aria-label={t("Поиск опросов")} placeholder={t("Найти опрос…")} value={search} onChange={(e) => setSearch(e.target.value)} /></label></div>
    <div className="survey-list-live"><LiveConnection connected={connected} /></div>
    {!surveys ? <Loading /> : !visible.length ? <Empty icon={FileText} title={t(search ? "Ничего не найдено" : "Опросов пока нет")} action={!search && <Button onClick={create}><Plus size={17} />{t("Создать опрос")}</Button>}>{t(search ? "Измените запрос или фильтр." : "Создайте анкету, настройте оформление и поделитесь ссылкой.")}</Empty> : <div className="quiz-grid">{visible.map((s) => <article key={s.id} className="quiz-card survey-card"><div className="quiz-card-top"><SurveyBadge status={s.status} /><span className="survey-privacy-tag"><ShieldCheck size={14} />{t(s.settings?.anonymous !== false ? "Анонимный" : "Сбор данных настроен")}</span></div><Link to={`/admin/surveys/${s.id}`} className="quiz-card-title"><h2>{s.title}</h2><ArrowUpRight size={19} /></Link><p>{s.description || t("Без описания")}</p><div className="quiz-card-meta"><span><FileText size={15} />{t("Вопросов: {count}", { count: s.questionCount ?? s.questions?.filter((q) => q.type !== "content").length ?? 0 })}</span><span>{t("Ответов: {count}", { count: s.submittedCount ?? s.responseCount ?? 0 })}</span></div><div className="quiz-card-footer"><Link className="text-link" to={`/admin/surveys/${s.id}/report`}>{t("Результаты")}<ArrowRight size={15} /></Link><div><button className="icon-button" aria-label={t("Создать копию опроса")} title={t("Создать копию опроса")} onClick={() => setConfirm({ type: "clone", survey: s })}><Copy size={17} /></button><button className="icon-button danger-text" aria-label={t("Удалить опрос")} title={t("Удалить опрос")} onClick={() => setConfirm({ type: "delete", survey: s })}><Trash2 size={17} /></button></div></div></article>)}</div>}
    {confirm && <ConfirmDialog ui={ui} title={confirm.type === "clone" ? "Создать копию опроса?" : "Удалить опрос?"} busy={busy} danger={confirm.type === "delete"} action={confirm.type === "clone" ? "Создать копию" : "Удалить опрос"} onClose={() => setConfirm(null)} onConfirm={act}>{t(confirm.type === "clone" ? "Будет создан черновик с вопросами и оформлением, без ответов участников." : "Опрос и все его ответы будут удалены без возможности восстановления. Для удаления сначала закройте приём ответов.")}</ConfirmDialog>}
  </main></AdminShell>;
}

function newQuestion(type, uid) { return { id: uid(), type, text: "", description: "", required: false, options: choiceTypes.includes(type) ? [{ id: uid(), text: "" }, { id: uid(), text: "" }] : [], ...(type === "rating" ? { min: 1, max: 5, step: 1 } : {}), ...(type === "scale" ? { min: 0, max: 10, step: 1, minLabel: "", maxLabel: "" } : {}) }; }
function themedStyle(theme = {}) { const s = { ...defaultTheme, ...theme }; const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; const accent = color(s.accentColor, defaultTheme.accentColor); const channels = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; return { "--survey-bg": color(s.backgroundColor, defaultTheme.backgroundColor), "--survey-surface": color(s.surfaceColor, defaultTheme.surfaceColor), "--survey-accent": accent, "--survey-on-accent": luminance > .179 ? "#111111" : "#ffffff", "--survey-text": color(s.textColor, defaultTheme.textColor), fontFamily: s.font === "serif" ? 'Georgia, "Times New Roman", serif' : 'Arial, "Segoe UI", sans-serif' }; }
function SurveyCover({ survey }) { return <>{survey.theme?.cover && <img className="survey-cover" src={survey.theme.cover} alt="" />}{survey.theme?.logo && <img className="survey-logo" src={survey.theme.logo} alt={survey.title} />}</>; }
function SurveyScale({ question: q, value, onChange, common, preview }) {
  const min = q.min ?? (q.type === "rating" ? 1 : 0);
  const max = q.max ?? (q.type === "rating" ? 5 : 10);
  const step = q.step || 1;
  const answered = !isEmpty(value);
  // A visual starting position is not an answer: only deliberate interaction
  // or the explicit choice button writes to the response.
  const middle = min + Math.floor((max - min) / step / 2) * step;
  const current = answered ? Number(value) : middle;
  const progress = Math.max(0, Math.min(100, 100 * (current - min) / (max - min)));
  return <div className={`survey-scale ${answered ? "is-answered" : "is-unanswered"}`}>
    <div className="survey-scale-value"><div><span>{t("Ваш выбор")}</span><output htmlFor={common.id}>{answered ? current : "—"}</output></div>{answered ? <button type="button" className="survey-scale-reset" disabled={preview} onClick={() => onChange("")}>{t("Сбросить")}</button> : <span className="survey-scale-prompt">{t("Передвиньте ползунок или выберите значение.")}</span>}</div>
    <input {...common} type="range" min={min} max={max} step={step} value={current} aria-label={q.text || t("Шкала")} aria-valuetext={answered ? String(current) : t("Значение не выбрано")} style={{ "--range-progress": `${progress}%` }} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => { if (!answered) onChange(Number(e.currentTarget.value)); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(current); } }} />
    <div className="survey-scale-labels"><span><strong>{min}</strong>{q.minLabel && <span>{q.minLabel}</span>}</span><span><strong>{max}</strong>{q.maxLabel && <span>{q.maxLabel}</span>}</span></div>
    {!answered && <button type="button" className="survey-scale-confirm" disabled={preview} onClick={() => onChange(current)}>{t("Выбрать {value}", { value: current })}<Check size={16} /></button>}
  </div>;
}
function SurveyQuestion({ question: q, value, onChange, error, preview = false, number }) {
  const id = `survey-field-${q.id}`;
  if (q.type === "content") return <section className="survey-content-block"><h2>{q.text}</h2>{q.image && <img className="survey-question-image" src={q.image} alt={q.text || t("Изображение вопроса")} />}{q.description && <p>{q.description}</p>}</section>;
  const common = { id, disabled: preview, "aria-invalid": !!error, "aria-describedby": [q.description && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined };
  let control;
  if (q.type === "long") control = <textarea {...common} rows={4} maxLength={12000} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  else if (choiceTypes.includes(q.type) && q.type !== "dropdown") control = <div className="survey-options">{q.options.map((o) => <label key={o.id} className="survey-option"><input type={q.type === "multiple" ? "checkbox" : "radio"} name={id} disabled={preview} checked={q.type === "multiple" ? (Array.isArray(value) ? value : []).includes(o.id) : value === o.id} onChange={(e) => onChange(q.type === "multiple" ? e.target.checked ? [...(value || []), o.id] : (value || []).filter((v) => v !== o.id) : o.id)} /><span>{o.text || t("Вариант ответа")}</span></label>)}</div>;
  else if (q.type === "dropdown") control = <select {...common} value={value ?? ""} onChange={(e) => onChange(e.target.value)}><option value="">{t("Выберите вариант")}</option>{q.options.map((o) => <option key={o.id} value={o.id}>{o.text || t("Вариант ответа")}</option>)}</select>;
  else if (q.type === "scale" || (q.type === "rating" && Math.floor(((q.max ?? 5) - (q.min ?? 1)) / (q.step || 1)) >= 10)) control = <SurveyScale question={q} value={value} onChange={onChange} common={common} preview={preview} />;
  else if (q.type === "rating") { const min = q.min ?? 1; const max = q.max ?? 5; const step = q.step || 1; const options = Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step); control = <div className="survey-rating-wrap"><div className="survey-rating" role="radiogroup" aria-label={q.text || t(fieldTypes[q.type])} aria-invalid={!!error} aria-describedby={common["aria-describedby"]}>{options.map((n) => <label key={n} className={Number(value) === n && !isEmpty(value) ? "selected" : ""}><input type="radio" name={id} value={n} checked={Number(value) === n && !isEmpty(value)} disabled={preview} onChange={() => onChange(n)} /><span>{n}</span></label>)}</div>{(q.minLabel || q.maxLabel) && <div className="survey-scale-labels"><span>{q.minLabel}</span><span>{q.maxLabel}</span></div>}</div>; }
  else control = <input {...common} type={q.type === "number" ? "number" : q.type === "date" ? "date" : "text"} min={q.type === "number" ? q.min ?? undefined : undefined} max={q.type === "number" ? q.max ?? undefined : undefined} step={q.type === "number" ? q.step || "any" : undefined} maxLength={q.type === "short" ? 2000 : undefined} value={value ?? ""} onChange={(e) => onChange(q.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />;
  return <fieldset className={`survey-question ${error ? "has-error" : ""}`} id={`${id}-group`}><legend>{number != null && <span className="survey-question-number" aria-hidden="true">{number}</span>}<span>{q.text || t("Новый вопрос")}{q.required && <span className="survey-required" aria-label={t("Обязательный вопрос")}> *</span>}</span></legend>{q.image && <img className="survey-question-image" src={q.image} alt={q.text || t("Изображение вопроса")} />}{q.description && <p id={`${id}-help`} className="survey-question-help">{q.description}</p>}{control}{error && <p className="survey-field-error" id={`${id}-error`}>{t(error)}</p>}</fieldset>;
}

export function SurveyEditor({ ui }) {
  useLanguage();
  const { id } = useParams();
  const { api, AdminShell, Button, Field, Toggle, Loading, Modal, uid } = ui;
  const notify = ui.useToast();
  const navigate = useNavigate();
  const [survey, setSurvey] = useState(null);
  const [tab, setTab] = useState("questions");
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteQuestion, setDeleteQuestion] = useState(false);
  useEffect(() => { let active = true; setSurvey(null); setDirty(false); setSelected(0); api(`/api/admin/surveys/${id}`).then((r) => active && setSurvey(normalSurvey(r))).catch((e) => active && setError(e.message)); return () => { active = false; }; }, [id, api]);
  useEffect(() => { const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  const update = (patch) => { setSurvey((s) => ({ ...s, ...patch })); setDirty(true); };
  const settings = (patch) => update({ settings: { ...survey.settings, ...patch } });
  const theme = (patch) => update({ theme: { ...survey.theme, ...patch } });
  const question = survey?.questions[selected];
  const hasResponses = (survey?.responseCount || 0) > 0;
  const updateQuestion = (patch) => update({ questions: survey.questions.map((q, i) => i === selected ? { ...q, ...patch } : q) });
  const save = async (status) => { setBusy(true); setError(""); try { const r = await api(`/api/admin/surveys/${id}`, { method: "PUT", body: { ...survey, ...(status ? { status } : {}) } }); setSurvey(normalSurvey(r)); setDirty(false); notify(status === "published" ? "Опрос опубликован. Поделитесь ссылкой." : status === "closed" ? "Приём ответов закрыт" : "Изменения сохранены"); } catch (e) { setError(e.message); notify(e.message, true); } finally { setBusy(false); } };
  const add = (type) => { update({ questions: [...survey.questions, newQuestion(type, uid)] }); setSelected(survey.questions.length); setAddOpen(false); };
  const move = (delta) => { const list = [...survey.questions]; [list[selected], list[selected + delta]] = [list[selected + delta], list[selected]]; update({ questions: list }); setSelected(selected + delta); };
  const duplicate = () => { const copy = { ...question, id: uid(), options: question.options?.map((o) => ({ ...o, id: uid() })) }; const list = [...survey.questions]; list.splice(selected + 1, 0, copy); update({ questions: list }); setSelected(selected + 1); };
  const remove = () => { update({ questions: survey.questions.filter((_, i) => i !== selected) }); setSelected(Math.max(0, selected - 1)); setDeleteQuestion(false); };
  const clone = async () => { setBusy(true); try { const r = await api(`/api/admin/surveys/${id}/clone`, { method: "POST" }); setCloneOpen(false); navigate(`/admin/surveys/${r.id}`); } catch (e) { notify(e.message, true); } finally { setBusy(false); } };
  const upload = async (event, key) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 3 * 1024 * 1024) { notify("Выберите PNG, JPEG, WebP или GIF до 3 МБ.", true); return; } setUploading(key); try { const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }); const r = await api("/api/admin/uploads", { method: "POST", body: { data } }); theme({ [key]: r.url }); } catch (e) { notify(e.message || "Не удалось загрузить изображение", true); } finally { setUploading(""); } };
  const share = async () => { try { await navigator.clipboard.writeText(`${location.origin}/s/${survey.slug}`); notify("Ссылка скопирована"); } catch { notify("Не удалось скопировать. Выделите ссылку вручную.", true); } };
  if (!survey) return <AdminShell section="surveys"><main className="workspace"><ErrorBox error={error} />{!error && <Loading />}</main></AdminShell>;
  return <AdminShell section="surveys"><main className="workspace survey-editor"><div className="editor-heading"><div><Link className="text-link" to="/admin/surveys"><ArrowLeft size={16} />{t("Все опросы")}</Link><h1>{survey.title}</h1><div className="survey-save-meta"><span className="save-state">{t(dirty ? "Есть несохранённые изменения" : "Все изменения сохранены")}</span><SurveyVersion revision={survey.contentRevision} /></div></div><div className="heading-actions"><Button variant="secondary" title={t("Предпросмотр")} aria-label={t("Предпросмотр")} onClick={() => setPreview(true)}><Eye size={18} /></Button><Link className="button secondary icon-only" aria-label={t("Результаты")} to={`/admin/surveys/${id}/report`}><BarChart3 size={18} /></Link><Button variant="secondary" loading={busy} onClick={() => save()}><Save size={17} />{t("Сохранить")}</Button><Button loading={busy} onClick={() => save(survey.status === "published" ? "closed" : "published")}>{t(survey.status === "published" ? "Закрыть приём" : "Опубликовать")}<ArrowUpRight size={17} /></Button></div></div>
    <div className="editor-tabs tabs">{[["questions", FileText, "Вопросы"], ["design", Palette, "Оформление"], ["settings", Settings, "Настройки"], ["share", Link2, "Приглашение"]].map(([key, Icon, label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}><Icon size={17} />{t(label)}{key === "questions" && <span>{survey.questions.length}</span>}</button>)}</div><ErrorBox error={error} />
    {hasResponses && <div className="info-banner survey-version-notice"><ShieldCheck size={19} /><div><strong>{t("Опрос можно редактировать")}</strong><p>{t("После сохранения новые участники увидят обновлённые вопросы. Те, кто уже начал, продолжат прежнюю версию. Их ответы и отчёты сохранятся. Настройки и оформление можно обновлять для всех.")}</p></div></div>}
    {tab === "questions" && <div className="builder"><aside className="question-sidebar"><div className="question-sidebar-heading"><span>{t("СОДЕРЖАНИЕ")}</span><span>{survey.questions.length}</span></div>{survey.questions.map((q, i) => <button key={q.id} className={`question-list-item ${selected === i ? "selected" : ""}`} onClick={() => setSelected(i)}><span>{i + 1}</span><div><strong>{q.text || t("Новый вопрос")}</strong><small>{t(fieldTypes[q.type])}{q.required ? " · *" : ""}</small></div></button>)}<Button className="full-width" variant="secondary" onClick={() => setAddOpen(true)}><Plus size={17} />{t("Добавить вопрос")}</Button></aside>
      {question ? <section className="panel question-editor"><div className="section-heading"><h2>{t("Вопрос {number}", { number: selected + 1 })}</h2><div className="question-actions"><button className="icon-button" disabled={!selected} aria-label={t("Переместить вверх")} onClick={() => move(-1)}><ArrowUp size={17} /></button><button className="icon-button" disabled={selected === survey.questions.length - 1} aria-label={t("Переместить вниз")} onClick={() => move(1)}><ArrowDown size={17} /></button><button className="icon-button" aria-label={t("Дублировать вопрос")} onClick={duplicate}><Copy size={17} /></button><button className="icon-button danger-text" aria-label={t("Удалить вопрос")} onClick={() => setDeleteQuestion(true)}><Trash2 size={17} /></button></div></div><Field label={t("Тип вопроса")}><select value={question.type} onChange={(e) => updateQuestion({ ...newQuestion(e.target.value, uid), id: question.id, text: question.text, description: question.description, required: question.required })}>{Object.entries(fieldTypes).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></Field><Field label={t(question.type === "content" ? "Заголовок блока" : "Текст вопроса")}><textarea rows={3} maxLength={12000} value={question.text} onChange={(e) => updateQuestion({ text: e.target.value })} placeholder={t("Введите текст…")} /></Field><Field label={t("Подсказка или описание")}><textarea rows={2} maxLength={4000} value={question.description || ""} onChange={(e) => updateQuestion({ description: e.target.value })} /></Field>
        {choiceTypes.includes(question.type) && <div className="survey-edit-options"><h3>{t("Варианты ответа")}</h3>{question.options.map((o, i) => <div className="survey-edit-option" key={o.id}><span>{i + 1}</span><input value={o.text} maxLength={2000} placeholder={t("Вариант ответа")} aria-label={t("Вариант {number}", { number: i + 1 })} onChange={(e) => updateQuestion({ options: question.options.map((v) => v.id === o.id ? { ...v, text: e.target.value } : v) })} /><button className="icon-button" disabled={i === 0} aria-label={t("Переместить вверх")} onClick={() => { const list = [...question.options]; [list[i - 1], list[i]] = [list[i], list[i - 1]]; updateQuestion({ options: list }); }}><ArrowUp size={15} /></button><button className="icon-button" disabled={question.options.length < 3} aria-label={t("Удалить вариант")} onClick={() => updateQuestion({ options: question.options.filter((v) => v.id !== o.id) })}><X size={16} /></button></div>)}<Button variant="secondary" disabled={question.options.length >= 100} onClick={() => updateQuestion({ options: [...question.options, { id: uid(), text: "" }] })}><Plus size={16} />{t("Добавить вариант")}</Button></div>}
        {["rating", "scale", "number"].includes(question.type) && <><div className="survey-form-grid">{[["min", "Минимум"], ["max", "Максимум"], ["step", "Шаг"]].map(([key, label]) => <Field key={key} label={t(label)}><input type="number" value={question[key] ?? ""} step="any" onChange={(e) => updateQuestion({ [key]: e.target.value === "" ? null : Number(e.target.value) })} /></Field>)}</div>{question.type !== "number" && <div className="survey-form-grid"><Field label={t("Подпись минимума")}><input value={question.minLabel || ""} onChange={(e) => updateQuestion({ minLabel: e.target.value })} maxLength={200} /></Field><Field label={t("Подпись максимума")}><input value={question.maxLabel || ""} onChange={(e) => updateQuestion({ maxLabel: e.target.value })} maxLength={200} /></Field></div>}</>}
        {question.type !== "content" && <Toggle label={t("Обязательный вопрос")} description={t("Без ответа отправить анкету не получится.")} checked={question.required} onChange={(required) => updateQuestion({ required })} />}
      </section> : <section className="panel"><ui.Empty icon={FileText} title={t("Добавьте первый вопрос")} action={<Button onClick={() => setAddOpen(true)}><Plus size={17} />{t("Добавить вопрос")}</Button>}>{t("Выберите подходящий формат ответа.")}</ui.Empty></section>}</div>}
    {tab === "design" && <div className="survey-design-grid"><section className="panel"><h2>{t("Тексты опроса")}</h2><Field label={t("Название опроса")}><input value={survey.title} maxLength={200} onChange={(e) => update({ title: e.target.value })} /></Field><Field label={t("Описание")}><textarea rows={3} value={survey.description || ""} maxLength={4000} onChange={(e) => update({ description: e.target.value })} /></Field><Field label={t("Вступление перед началом")}><textarea rows={4} value={survey.intro || ""} maxLength={12000} onChange={(e) => update({ intro: e.target.value })} /></Field><Field label={t("Сообщение после отправки")}><textarea rows={3} value={survey.outro || ""} maxLength={12000} onChange={(e) => update({ outro: e.target.value })} placeholder={t("Спасибо за ваш ответ!")} /></Field></section><section className="panel"><h2>{t("Визуальное оформление")}</h2><div className="survey-colors">{[["backgroundColor", "Фон страницы"], ["surfaceColor", "Фон формы"], ["accentColor", "Акцентный цвет"], ["textColor", "Цвет текста"]].map(([key, label]) => <label className="survey-color" key={key}><span>{t(label)}</span><input type="color" value={survey.theme[key]} onChange={(e) => theme({ [key]: e.target.value })} /><code>{survey.theme[key]}</code></label>)}</div><div className="survey-form-grid"><Field label={t("Шрифт")}><select value={survey.theme.font} onChange={(e) => theme({ font: e.target.value })}><option value="sans">{t("Без засечек")}</option><option value="serif">{t("С засечками")}</option></select></Field><Field label={t("Ширина формы")}><select value={survey.theme.layout} onChange={(e) => theme({ layout: e.target.value })}><option value="card">{t("Компактная")}</option><option value="wide">{t("Широкая")}</option></select></Field></div>{[["logo", "Логотип"], ["cover", "Обложка"]].map(([key, label]) => <div className="survey-media-editor" key={key}><strong>{t(label)}</strong>{survey.theme[key] && <div className={`survey-media-preview ${key}`}><img src={survey.theme[key]} alt={t(label)} /><button className="icon-button" onClick={() => theme({ [key]: null })} aria-label={t("Удалить изображение")}><X size={17} /></button></div>}<label className="image-upload"><ImagePlus size={18} /><span>{t(uploading === key ? "Загрузка…" : "Загрузить изображение")}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={!!uploading} onChange={(e) => upload(e, key)} /><small>PNG, JPEG, WebP, GIF · 3 {t("МБ")}</small></label></div>)}</section></div>}
    {tab === "settings" && <section className="panel survey-settings"><h2>{t("Конфиденциальность")}</h2><Toggle label={t("Анонимный опрос")} description={t("Имя, IP-адрес и данные браузера не сохраняются в ответах и отчётах.")} checked={survey.settings.anonymous} onChange={(anonymous) => settings({ anonymous, ...(anonymous ? { collectName: false, collectIp: false, collectUserAgent: false } : {}) })} /><Toggle label={t("Собирать имя")} description={t("Участник укажет имя перед началом.")} checked={survey.settings.collectName} disabled={survey.settings.anonymous} onChange={(collectName) => settings({ collectName })} /><Toggle label={t("Сохранять IP-адрес")} description={t("Если сбор включён, IP-адрес войдёт в публичный и приватный Excel-отчёты.")} checked={survey.settings.collectIp} disabled={survey.settings.anonymous} onChange={(collectIp) => settings({ collectIp })} /><Toggle label={t("Сохранять данные браузера")} description={t("Техническая строка User-Agent будет включена в приватный отчёт.")} checked={survey.settings.collectUserAgent} disabled={survey.settings.anonymous} onChange={(collectUserAgent) => settings({ collectUserAgent })} /><p className="survey-privacy-note">{t("Отключение сбора удаляет ранее сохранённые данные этого типа. Включение действует на новые заполнения: старые данные не восстанавливаются.")}</p><h2>{t("Доступ")}</h2><Field label={t("Срок приёма ответов")} hint={t("Время в часовом поясе вашего устройства. Пусто — без срока.")}><input type="datetime-local" value={localDateTime(survey.settings.deadline)} onChange={(e) => settings({ deadline: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field><h2>{t("Повторные ответы")}</h2><Toggle label={t("Один ответ с IP-адреса")} description={t("Участники общей сети могут иметь один IP. Ограничение может затронуть разных людей.")} checked={survey.settings.oneResponsePerIp} onChange={(oneResponsePerIp) => settings({ oneResponsePerIp })} /><Toggle label={t("Один ответ из браузера")} description={t("Ограничение по cookie браузера. Очистка cookie или другой браузер могут его обойти.")} checked={survey.settings.oneResponsePerBrowser} onChange={(oneResponsePerBrowser) => settings({ oneResponsePerBrowser })} /><p className="survey-privacy-note"><ShieldCheck size={18} /><span>{t("В анонимном режиме ограничения используют непрозрачные технические идентификаторы, а не имя или открытый IP-адрес. Их нет в ответах и экспорте.")}</span></p><p className="muted">{t("В вопросах не запрашивайте имя и другие личные данные, если обещаете участникам анонимность.")}</p></section>}
    {tab === "share" && <section className="panel survey-share"><Link2 size={30} /><h2>{t("Ссылка на опрос")}</h2><p>{t("Опубликуйте опрос и отправьте ссылку участникам.")}</p><div className="survey-share-link"><input aria-label={t("Ссылка на опрос")} value={`${location.origin}/s/${survey.slug}`} readOnly onFocus={(e) => e.target.select()} /><Button onClick={share}><Copy size={17} />{t("Копировать")}</Button></div><div className="survey-share-actions"><SurveyBadge status={survey.status} /><a className="text-link" target="_blank" rel="noreferrer" href={`/s/${survey.slug}`}>{t("Открыть опрос")}<ArrowUpRight size={16} /></a></div></section>}
    {addOpen && <Modal title={t("Добавить вопрос")} onClose={() => setAddOpen(false)}><div className="survey-type-grid">{Object.entries(fieldTypes).map(([key, label]) => <button key={key} onClick={() => add(key)}><FileText size={18} /><span>{t(label)}</span><Plus size={16} /></button>)}</div></Modal>}
    {preview && <Modal variant="survey-preview-modal" title={t("Предпросмотр опроса")} onClose={() => setPreview(false)}><p className="survey-preview-notice">{t("Предпросмотр: ответы не отправляются.")}</p><div className={`survey-canvas ${survey.theme.layout}`} style={themedStyle(survey.theme)}><div className="survey-paper"><SurveyCover survey={survey} /><div className="survey-paper-body"><h1>{survey.title}</h1><p className="survey-prose">{survey.description}</p><p className="survey-prose">{survey.intro}</p><div className="survey-questions">{survey.questions.map((q, index) => <div key={q.id}><SurveyQuestion question={q} number={survey.questions.slice(0, index + 1).filter((field) => field.type !== "content").length} preview /></div>)}</div><button className="survey-submit" disabled>{t("Отправить ответы")}</button></div></div></div></Modal>}
    {cloneOpen && <ConfirmDialog ui={ui} title="Создать копию опроса?" busy={busy} action="Создать копию" onClose={() => setCloneOpen(false)} onConfirm={clone}>{t("Будет создан черновик с вопросами и оформлением, без ответов участников.")}</ConfirmDialog>}
    {deleteQuestion && <ConfirmDialog ui={ui} title="Удалить вопрос?" danger action="Удалить вопрос" onClose={() => setDeleteQuestion(false)} onConfirm={remove}>{t("Вопрос будет удалён из формы. Изменение вступит в силу после сохранения.")}</ConfirmDialog>}
  </main></AdminShell>;
}

function answerText(question, answer) {
  if (isEmpty(answer)) return "—";
  if (choiceTypes.includes(question.type)) return (Array.isArray(answer) ? answer : [answer]).map((id) => question.options?.find((o) => o.id === id)?.text || String(id)).join(", ");
  return typeof answer === "object" ? JSON.stringify(answer) : String(answer);
}
function QuestionAggregate({ question: q }) {
  const a = q.aggregates || {};
  const rows = a.options || a.distribution;
  const maxCount = Math.max(1, ...(rows || []).map((v) => v.count || 0));
  return <section className="panel survey-aggregate"><div className="section-heading"><div><h3>{q.text}</h3><p className="muted">{t(fieldTypes[q.type])} · {t("Ответили: {count}", { count: a.answered || 0 })} · {t("Пропустили: {count}", { count: a.skipped || 0 })}</p></div>{a.average != null && <div className="survey-average"><strong>{Number(a.average).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span>{t("Среднее значение")}</span></div>}</div>{rows?.length > 0 && <div className="survey-bars">{rows.map((v, i) => <div className="survey-bar-row" key={v.id ?? v.value ?? i}><span>{v.text ?? String(v.value)}</span><div className="survey-bar-track"><i style={{ width: `${100 * (v.count || 0) / maxCount}%` }} /></div><strong>{v.count || 0}</strong></div>)}</div>}{a.min != null && a.max != null && <p className="muted">{t("Минимум: {min} · Максимум: {max}", { min: a.min, max: a.max })}</p>}{!rows && a.average == null && <p className="muted">{t("Текстовые ответы доступны в карточках участников и в Excel.")}</p>}</section>;
}
export function SurveyReport({ ui }) {
  useLanguage();
  const { id } = useParams();
  const { api, AdminShell, Button, Loading, Empty, useAdminLive, LiveConnection, utc, ExportDialog } = ui;
  const notify = ui.useToast();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const routeLocation = useLocation();
  const [tab, setTab] = useState(() => new URLSearchParams(routeLocation.search).get("tab") === "responses" ? "responses" : "summary");
  useEffect(() => {
    const query = new URLSearchParams(routeLocation.search);
    const legacyId = query.get("attempt");
    if (legacyId) navigate(`/admin/surveys/${id}/report/responses/${encodeURIComponent(legacyId)}`, { replace: true });
    else setTab(query.get("tab") === "responses" ? "responses" : "summary");
  }, [id, routeLocation.search, navigate]);
  const changeTab = (value) => { setTab(value); navigate(`/admin/surveys/${id}/report${value === "responses" ? "?tab=responses" : ""}`, { replace: true }); };
  const [toDelete, setToDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const load = useCallback(async () => { try { const r = await api(`/api/admin/surveys/${id}/report`); setReport(r); setError(""); } catch (e) { setError(e.message); } }, [id, api]);
  const { connected } = useAdminLive(load, id);
  const remove = async () => { setBusy(true); try { await api(`/api/admin/surveys/${id}/responses/${toDelete.id}`, { method: "DELETE" }); setToDelete(null); await load(); notify("Ответ удалён"); } catch (e) { notify(e.message, true); } finally { setBusy(false); } };
  const anonymous = report?.survey.settings?.anonymous !== false;
  const questions = report?.questions || [];
  const responses = report?.responses || [];
  const fieldsFor = (response) => (response.questions || report?.survey.questions || questions).filter((q) => q.type !== "content");
  const shown = responses.filter((r) => `${!anonymous ? r.name || "" : ""} ${r.id} ${fieldsFor(r).map((q) => answerText(q, answerFor(r.answers, q.id))).join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <AdminShell section="reports"><main className="workspace"><div className="page-heading"><div><Link className="text-link" to={`/admin/surveys/${id}`}><ArrowLeft size={16} />{t("К редактору опроса")}</Link><div className="survey-report-title"><h1>{report?.survey.title || t("Результаты опроса")}</h1>{report && <SurveyVersion revision={report.survey.contentRevision} />}</div><p>{t("Ответы и сводка без оценок и баллов.")}</p></div><div className="heading-actions"><Button variant="secondary" aria-label={t("Обновить результаты")} onClick={load}><RefreshCw size={17} /></Button><Button disabled={!report} onClick={() => setExportOpen(true)}><Download size={17} />{t("Скачать Excel")}</Button></div></div><ErrorBox error={error} />
    {!report ? <Loading /> : <><div className="stat-grid four">{[["Всего ответов", report.summary.total], ["Отправлены", report.summary.submitted], ["Заполняют сейчас", report.summary.active], ["На связи", (report.summary.online || 0) + (report.summary.away || 0)]].map(([label, value]) => <div className="stat" key={label}><span>{t(label)}</span><strong>{value || 0}</strong></div>)}</div><div className="survey-report-toolbar"><div className="tabs"><button className={tab === "summary" ? "active" : ""} onClick={() => changeTab("summary")}>{t("Сводка по вопросам")}</button><button className={tab === "responses" ? "active" : ""} onClick={() => changeTab("responses")}>{t("Ответы участников")}<span>{responses.length}</span></button></div><LiveConnection connected={connected} /></div>{anonymous && <p className="survey-privacy-note"><ShieldCheck size={18} /><span>{t("Анонимный опрос: имена, IP-адреса и данные браузеров не показываются и не экспортируются.")}</span></p>}
      {tab === "summary" && <p className="survey-report-scope"><SurveyVersion revision={report.summary.questionsContentRevision || report.survey.contentRevision} /><span>{t("Сводка по вопросам учитывает отправленные ответы этой версии: {count}.", { count: report.summary.questionsSubmittedCount ?? responses.filter((response) => response.status === "submitted" && (response.contentRevision || 1) === (report.survey.contentRevision || 1)).length })} {t("Все версии доступны в ответах участников.")}</span></p>}
      {tab === "summary" && (questions.length ? <div className="survey-aggregates">{questions.map((q) => <QuestionAggregate key={q.id} question={q} />)}</div> : <Empty icon={BarChart3} title={t("Сводка появится после добавления вопросов")}>{t("Настройте опрос в редакторе.")}</Empty>)}
      {tab === "responses" && <section className="panel"><div className="section-heading"><h2>{t("Ответы участников")}</h2><label className="search"><Search size={17} /><input aria-label={t("Поиск по ответам")} placeholder={t("Поиск по ответам…")} value={search} onChange={(e) => setSearch(e.target.value)} /></label></div>{!shown.length ? <Empty icon={FileText} title={t(responses.length ? "Ничего не найдено" : "Ответов пока нет")}>{t(responses.length ? "Измените запрос или фильтр." : "Поделитесь ссылкой на опубликованный опрос.")}</Empty> : <div className="table-scroll"><table><thead><tr><th>{t("Участник")}</th><th>{t("Статус")}</th><th>{t("Версия")}</th><th>{t("Заполнено")}</th><th>{t("Отправлено")}</th><th>{t("Действия")}</th></tr></thead><tbody>{shown.map((r) => <tr key={r.id}><td><Link className="survey-response-link" to={`/admin/surveys/${id}/report/responses/${r.id}`}>{!anonymous && r.name ? r.name : t("Ответ №{number}", { number: responses.indexOf(r) + 1 })}<ArrowUpRight size={14} /></Link></td><td><span className={`badge ${r.status}`}><i />{t({ active: "Заполняется", submitted: "Отправлен", expired: "Время истекло" }[r.status] || r.status)}</span></td><td><SurveyVersion revision={r.contentRevision} /></td><td>{fieldsFor(r).filter((q) => !isEmpty(answerFor(r.answers, q.id))).length} / {fieldsFor(r).length}</td><td>{utc(r.finishedAt)}</td><td><button className="icon-button danger-text" aria-label={t("Удалить ответ")} onClick={() => setToDelete(r)}><Trash2 size={17} /></button></td></tr>)}</tbody></table></div>}</section>}
    </>}
    {toDelete && <ConfirmDialog ui={ui} title="Удалить ответ участника?" busy={busy} danger action="Удалить ответ" onClose={() => setToDelete(null)} onConfirm={remove}>{t("Ответ и его технические данные будут удалены без возможности восстановления. Активное заполнение будет прервано.")}</ConfirmDialog>}
    {exportOpen && <ExportDialog kind="surveys" id={id} onClose={() => setExportOpen(false)} />}
  </main></AdminShell>;
}

const responseStatus = (status) => t({ active: "Заполняется", submitted: "Отправлен", expired: "Время истекло" }[status] || status);
function SurveyResponseAnswer({ question: q, answer, number }) {
  const answered = !isEmpty(answer);
  const selected = Array.isArray(answer) ? answer : [answer];
  return <article className="panel participant-answer-card survey-response-answer">
    <div className="participant-question-top"><span className="survey-response-question-label">{t("Вопрос {number}", { number })} · {t(fieldTypes[q.type])}</span><span className={`survey-answer-state ${answered ? "answered" : ""}`}>{t(answered ? "Есть ответ" : "Без ответа")}</span></div>
    <h2>{q.text}</h2>{q.image && <img className="survey-question-image" src={q.image} alt={q.text || t("Изображение вопроса")} />}{q.description && <p className="survey-response-question-help">{q.description}</p>}
    {choiceTypes.includes(q.type) ? <div className="survey-response-options" role="list" aria-label={t("Варианты ответа")}>{q.options?.map((option) => <div key={option.id} role="listitem" className={selected.includes(option.id) ? "is-selected" : ""}><span className="survey-response-option-mark" aria-hidden="true">{selected.includes(option.id) && <Check size={16} />}</span><span>{option.text}</span>{selected.includes(option.id) && <strong className="sr-only">{t("Выбрано")}</strong>}</div>)}</div> : <div className={`participant-answer-block survey-response-answer-value ${answered ? "" : "is-empty"}`}><span>{t("Ответ участника")}</span><p>{answered ? answerText(q, answer) : t("Участник не ответил на этот вопрос.")}</p>{["scale", "rating"].includes(q.type) && <small>{t("От {min} до {max}", { min: q.min ?? (q.type === "rating" ? 1 : 0), max: q.max ?? (q.type === "rating" ? 5 : 10) })}{q.minLabel || q.maxLabel ? ` · ${[q.minLabel, q.maxLabel].filter(Boolean).join(" — ")}` : ""}</small>}</div>}
  </article>;
}
function SurveyEvent({ event, questions, utc }) {
  const metadata = event.metadata || {};
  const question = questions.find((q) => q.id === metadata.questionId);
  const label = t({ start: "Начало заполнения", answers_saved: "Ответы сохранены", answers: "Ответы сохранены", submitted: "Ответы отправлены", submit: "Ответы отправлены", presence: "Обновление присутствия", question: "Переход к вопросу", expired: "Время истекло" }[event.type] || event.type);
  return <li><div><strong>{label}</strong>{question && <p>{question.text}</p>}{event.type === "presence" && <p>{t(metadata.visibility === "hidden" ? "Вкладка скрыта" : metadata.focused ? "Во вкладке опроса" : "Вкладка без фокуса")}</p>}</div><time>{utc(event.createdAt)}</time></li>;
}
export function SurveyResponsePage({ ui }) {
  useLanguage();
  const { id, responseId } = useParams();
  const navigate = useNavigate();
  const routeKey = `${id}:${responseId}`;
  const routeKeyRef = useRef(routeKey);
  routeKeyRef.current = routeKey;
  const { api, AdminShell, Button, Loading, Empty, useAdminLive, LiveConnection, utc } = ui;
  const notify = ui.useToast();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const result = await api(`/api/admin/surveys/${id}/report`); if (routeKeyRef.current === routeKey) { setReport(result); setError(""); } }
    catch (e) { if (routeKeyRef.current === routeKey) setError(e.message); }
  }, [api, id, routeKey]);
  const { connected } = useAdminLive(load, id, responseId);
  const detail = report?.responses.find((r) => r.id === responseId);
  const anonymous = report?.survey.settings?.anonymous !== false;
  const questionList = detail?.questions || report?.survey.questions || report?.questions || [];
  const questions = questionList.filter((q) => q.type !== "content");
  const answered = questions.filter((q) => !isEmpty(answerFor(detail?.answers, q.id))).length;
  const back = `/admin/surveys/${id}/report?tab=responses`;
  const duration = detail ? `${Math.floor(detail.durationSeconds / 60)} ${t("мин")} ${detail.durationSeconds % 60} ${t("сек")}` : "—";
  const remove = async () => {
    setBusy(true);
    try { await api(`/api/admin/surveys/${id}/responses/${responseId}`, { method: "DELETE" }); notify("Ответ удалён"); navigate(back, { replace: true }); }
    catch (e) { notify(e.message, true); setBusy(false); }
  };
  useEffect(() => { setReport(null); setError(""); setDeleteOpen(false); window.scrollTo({ top: 0 }); }, [id, responseId]);
  return <AdminShell section="reports"><main className="workspace participant-report-workspace survey-response-page">
    <Link className="text-link participant-back-link" to={back}><ArrowLeft size={18} />{t("Все ответы опроса")}</Link>
    <div className="page-heading participant-report-heading"><div><p className="survey-response-kicker">{detail?.title || report?.survey.title || t("Результаты опроса")}</p><h1>{!anonymous && detail?.name ? detail.name : t("Ответ участника")}</h1>{detail && <p className="survey-response-id">ID: {detail.id}</p>}</div><div className="heading-actions"><Button variant="secondary" aria-label={t("Обновить результаты")} onClick={load}><RefreshCw size={18} /></Button>{detail && <Button variant="danger" onClick={() => setDeleteOpen(true)}><Trash2 size={17} />{t("Удалить ответ")}</Button>}</div></div>
    <ErrorBox error={error} />
    {!report ? !error && <Loading /> : !detail ? <Empty icon={FileText} title={t("Ответ не найден")} action={<Link className="button secondary" to={back}>{t("Все ответы опроса")}<ArrowRight size={17} /></Link>}>{t("Ответ был удалён или больше недоступен.")}</Empty> : <>
      <section className="panel participant-summary"><div className="section-heading"><h2>{t("Об участнике")}</h2><LiveConnection connected={connected} /></div><dl className="detail-list participant-metadata survey-response-metadata"><div><dt>{t("Статус")}</dt><dd><span className={`badge ${detail.status}`}><i />{responseStatus(detail.status)}</span></dd></div><div><dt>{t("Версия опроса")}</dt><dd><SurveyVersion revision={detail.contentRevision} /></dd></div><div><dt>{t("Заполнено")}</dt><dd>{answered} / {questions.length}</dd></div><div><dt>{t("Начало")}</dt><dd>{utc(detail.startedAt)}</dd></div><div><dt>{t("Отправлено")}</dt><dd>{utc(detail.finishedAt)}</dd></div><div><dt>{t("Продолжительность")}</dt><dd>{duration}</dd></div>{detail.expiresAt && <div><dt>{t("Срок приёма ответов")}</dt><dd>{utc(detail.expiresAt)}</dd></div>}{!anonymous && detail.ip && <div><dt>{t("IP-адрес")}</dt><dd>{detail.ip}</dd></div>}{!anonymous && detail.userAgent && <div className="survey-user-agent"><dt>{t("Данные браузера")}</dt><dd>{detail.userAgent}</dd></div>}</dl>
        {anonymous ? <p className="survey-privacy-note"><ShieldCheck size={18} /><span>{t("Анонимный опрос: имена, IP-адреса и данные браузеров не показываются и не экспортируются.")}</span></p> : <p className="survey-privacy-note"><ShieldCheck size={18} /><span>{t("Сбор данных при старте")}: {[detail.collection?.collectName && t("Имя"), detail.collection?.collectIp && t("IP-адрес"), detail.collection?.collectUserAgent && t("Данные браузера")].filter(Boolean).join(", ") || t("Не собирались")}</span></p>}
      </section>
      <section className="participant-answers survey-response-answers" aria-label={t("Вопросы и ответы")}>{questionList.map((q, index) => q.type === "content" ? <section className="panel survey-response-content" key={q.id}><span className="survey-response-question-label">{t("Информационный блок")}</span><h2>{q.text}</h2>{q.image && <img className="survey-question-image" src={q.image} alt={q.text || t("Изображение вопроса")} />}{q.description && <p>{q.description}</p>}</section> : <SurveyResponseAnswer key={q.id} question={q} answer={answerFor(detail.answers, q.id)} number={questionList.slice(0, index + 1).filter((field) => field.type !== "content").length} />)}</section>
      <section className="panel participant-journal survey-response-events"><div className="section-heading"><h2>{t("Журнал действий")}</h2><span className="muted">{detail.events?.length || 0}</span></div>{detail.events?.length ? <ol>{detail.events.map((event, index) => <SurveyEvent key={index} event={event} questions={questionList} utc={utc} />)}</ol> : <p className="muted">{t("Действий пока нет.")}</p>}</section>
      <Link className="text-link participant-back-link" to={back}><ArrowLeft size={18} />{t("Все ответы опроса")}</Link>
    </>}
    {deleteOpen && <ConfirmDialog ui={ui} title="Удалить ответ участника?" busy={busy} danger action="Удалить ответ" onClose={() => setDeleteOpen(false)} onConfirm={remove}>{t("Ответ и его технические данные будут удалены без возможности восстановления. Активное заполнение будет прервано.")}</ConfirmDialog>}
  </main></AdminShell>;
}

function validateAnswers(questions, answers) {
  const errors = Object.create(null);
  for (const q of questions) {
    if (q.type === "content") continue;
    const answer = answerFor(answers, q.id);
    if (isEmpty(answer)) { if (q.required) errors[q.id] = "Ответьте на обязательный вопрос."; continue; }
    if (["number", "rating", "scale"].includes(q.type)) {
      const n = Number(answer);
      if (!Number.isFinite(n)) errors[q.id] = "Введите число.";
      else if ((q.min != null && n < q.min) || (q.max != null && n > q.max)) errors[q.id] = "Значение выходит за допустимые границы.";
      else if (q.step && Math.abs((n - (q.min ?? 0)) / q.step - Math.round((n - (q.min ?? 0)) / q.step)) > 1e-7) errors[q.id] = "Число не соответствует заданному шагу.";
    }
  }
  return errors;
}
function PrivacyDisclosure({ settings: s }) {
  return <div className="survey-disclosure"><ShieldCheck size={19} /><div><strong>{t(s.anonymous ? "Анонимный опрос" : "Какие данные сохраняются")}</strong><p>{t(s.anonymous ? "Ваше имя, IP-адрес и данные браузера не сохраняются в ответах. Не указывайте личные данные в свободных полях, если хотите сохранить анонимность." : "Администратор получит ваши ответы и только включённые ниже данные.")}</p>{!s.anonymous && <ul><li>{t(s.collectName ? "Имя: запрашивается" : "Имя: не запрашивается")}</li><li>{t(s.collectIp ? "IP-адрес: сохраняется" : "IP-адрес: не сохраняется")}</li><li>{t(s.collectUserAgent ? "Данные браузера: сохраняются" : "Данные браузера: не сохраняются")}</li></ul>}{(s.oneResponsePerIp || s.oneResponsePerBrowser) && <p>{t("Повторные ответы ограничены непрозрачными техническими идентификаторами.")}{s.oneResponsePerIp && <> {t("В общей сети один IP может принадлежать нескольким людям.")}</>}</p>}</div></div>;
}
export function PublicSurvey({ ui }) {
  const { language } = useLanguage();
  const { slug } = useParams();
  const { api, StudentLayout, Loading } = ui;
  const [survey, setSurvey] = useState(null);
  const [response, setResponse] = useState(null);
  const [answers, setAnswers] = useState({});
  const [name, setName] = useState("");
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState("saved");
  const answersRef = useRef({});
  const savedRef = useRef("{}");
  const chainRef = useRef(Promise.resolve());
  const currentQuestion = useRef(null);
  const submitting = useRef(false);
  const autosaveTimer = useRef(null);
  const loadedSlug = useRef(slug);
  useEffect(() => {
    let active = true; loadedSlug.current = slug; setSurvey(null); setResponse(null); setStarted(false); setError(""); setAnswers({}); answersRef.current = {}; savedRef.current = "{}"; chainRef.current = Promise.resolve();
    api(`/api/public/surveys/${slug}`).then((r) => { if (!active) return; setSurvey(normalSurvey(r)); if (r.response) { setResponse(r.response); setAnswers(r.response.answers || {}); answersRef.current = r.response.answers || {}; savedRef.current = JSON.stringify(r.response.answers || {}); setStarted(r.response.status === "active"); } }).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [slug, api]);
  const persist = useCallback((snapshot, responseId) => {
    const encoded = JSON.stringify(snapshot);
    const requestedSlug = loadedSlug.current;
    chainRef.current = chainRef.current.catch(() => {}).then(async () => {
      if (savedRef.current === encoded) return;
      setSaveStatus("saving");
      try {
        const r = await api(`/api/public/responses/${responseId}/answers`, { method: "PUT", body: { answers: snapshot } });
        if (loadedSlug.current !== requestedSlug) return;
        savedRef.current = encoded;
        setSaveStatus(JSON.stringify(answersRef.current) === encoded ? "saved" : "pending");
        if (r.status !== "active") setResponse(r);
      } catch (e) { if (loadedSlug.current === requestedSlug) { setSaveStatus("error"); setError(e.message); } throw e; }
    });
    return chainRef.current;
  }, [api]);
  useEffect(() => { if (!response || response.status !== "active" || !started || submitting.current || savedRef.current === JSON.stringify(answers)) return; autosaveTimer.current = setTimeout(() => { if (!submitting.current) persist(answersRef.current, response.id).catch(() => {}); }, 700); return () => clearTimeout(autosaveTimer.current); }, [answers, response?.id, response?.status, started, persist]);
  useEffect(() => {
    if (!response || response.status !== "active" || !started) return;
    let stopped = false;
    const ping = () => { if (stopped || submitting.current) return; api(`/api/public/responses/${response.id}/presence`, { method: "POST", body: { visibility: document.hidden ? "hidden" : "visible", focused: document.hasFocus(), questionId: currentQuestion.current } }).then((r) => { if (!stopped) setResponse(r); }).catch((e) => { if (!stopped && e.status === 404) { setResponse((r) => ({ ...r, status: "removed" })); setError("Ответ удалён администратором. Откройте опрос заново."); } }); };
    ping(); const timer = setInterval(ping, 10000); document.addEventListener("visibilitychange", ping); window.addEventListener("focus", ping); window.addEventListener("blur", ping); window.addEventListener("surveyquestionchange", ping);
    const leave = () => { if (JSON.stringify(answersRef.current) !== savedRef.current && !submitting.current) api(`/api/public/responses/${response.id}/answers`, { method: "PUT", keepalive: true, body: { answers: answersRef.current } }).catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", ping); window.removeEventListener("focus", ping); window.removeEventListener("blur", ping); window.removeEventListener("surveyquestionchange", ping); window.removeEventListener("pagehide", leave); };
  }, [response?.id, response?.status, started, api]);
  const start = async () => { setBusy(true); setError(""); try { const r = await api(`/api/public/surveys/${slug}/start`, { method: "POST", body: { ...(survey.settings.collectName && !survey.settings.anonymous ? { name } : {}), language } }); setResponse(r); setAnswers(r.answers || {}); answersRef.current = r.answers || {}; savedRef.current = JSON.stringify(r.answers || {}); setErrors({}); setSaveStatus("saved"); setStarted(true); window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const change = (q, value) => { const next = { ...answersRef.current, [q.id]: value }; answersRef.current = next; setAnswers(next); setSaveStatus("pending"); setErrors((e) => { const copy = { ...e }; delete copy[q.id]; return copy; }); };
  const submit = async (event) => { event.preventDefault(); const invalid = validateAnswers(response.questions || survey.questions, answersRef.current); setErrors(invalid); if (Object.keys(invalid).length) { const field = document.getElementById(`survey-field-${Object.keys(invalid)[0]}-group`); field?.scrollIntoView({ behavior: "smooth", block: "center" }); field?.querySelector("input,select,textarea")?.focus({ preventScroll: true }); setError("Проверьте обязательные вопросы."); return; } submitting.current = true; clearTimeout(autosaveTimer.current); setBusy(true); setError(""); try { await chainRef.current.catch(() => {}); const r = await api(`/api/public/responses/${response.id}/submit`, { method: "POST", body: { answers: answersRef.current } }); setResponse(r); savedRef.current = JSON.stringify(answersRef.current); setSaveStatus("saved"); window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { setError(e.message); } finally { submitting.current = false; setBusy(false); } };
  const settings = { ...defaultSettings, ...(response?.status === "active" ? response.settings : survey?.settings) };
  const activeSurvey = survey ? { ...survey, title: response?.title || survey.title, theme: response?.status === "active" ? { ...defaultTheme, ...response.theme } : survey.theme } : null;
  const questions = response?.questions || survey?.questions || [];
  const finished = response && response.status !== "active";
  return <div className="survey-public" style={themedStyle(activeSurvey?.theme)}><StudentLayout title={activeSurvey?.title || t("Опрос")}><main className={`survey-canvas ${activeSurvey?.theme.layout || "card"}`}>
    {!survey ? <div className="survey-paper"><div className="survey-paper-body">{error ? <><h1>{t("Опрос недоступен")}</h1><ErrorBox error={error} /></> : <Loading />}</div></div> : <div className="survey-paper"><SurveyCover survey={activeSurvey} /><div className="survey-paper-body">{finished ? <section className="survey-thanks"><div className="survey-thanks-icon">{response.status === "submitted" ? <Check size={30} /> : <AlertTriangle size={30} />}</div><span className="survey-eyebrow">{t(response.status === "submitted" ? "Ответ отправлен" : response.status === "removed" ? "Ответ удалён" : "Заполнение завершено")}</span><h1>{t(response.status === "submitted" ? "Спасибо за ваш ответ!" : response.status === "removed" ? "Ответ удалён администратором" : "Приём этого ответа завершён")}</h1><p className="survey-prose">{response.status === "submitted" ? survey.outro || t("Ваше мнение помогает нам стать лучше.") : response.status === "removed" ? t("Ответ удалён администратором. Откройте опрос заново.") : t("Время заполнения истекло. Вы можете обратиться к организатору опроса.")}</p>{response.status === "removed" && <Link to={`/s/${slug}`} onClick={() => { setResponse(null); setStarted(false); setError(""); }} className="survey-submit">{t("Вернуться к началу опроса")}<ArrowRight size={17} /></Link>}{response.status !== "removed" && !survey.settings.oneResponsePerIp && !survey.settings.oneResponsePerBrowser && survey.status === "published" && <button className="survey-submit" disabled={busy} onClick={() => { setResponse(null); setStarted(false); setError(""); }}>{t("Заполнить ещё раз")}<ArrowRight size={17} /></button>}</section> : <><span className="survey-eyebrow">{t("Опрос")}</span><h1>{activeSurvey.title}</h1>{survey.description && <p className="survey-prose">{survey.description}</p>}{!started ? <><div className="survey-entry-meta"><span><FileText size={17} />{t("Вопросов: {count}", { count: survey.questions.filter((q) => q.type !== "content").length })}</span><span>{t("Без оценок")}</span></div>{survey.intro && <p className="survey-prose survey-intro">{survey.intro}</p>}<PrivacyDisclosure settings={settings} />{survey.status !== "published" ? <p className="inline-alert" role="status">{t("Опрос сейчас не принимает новые ответы.")}</p> : <form onSubmit={(e) => { e.preventDefault(); start(); }}>{!settings.anonymous && settings.collectName && <label className="field"><span className="field-label">{t("Ваше имя")}</span><input required value={name} maxLength={150} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>}<ErrorBox error={error} /><button className="survey-submit" disabled={busy} type="submit">{t(busy ? "Загрузка…" : "Начать опрос")}<ArrowRight size={18} /></button></form>}</> : <form onSubmit={submit} noValidate><div className="survey-form-meta"><span>{t("Обязательные вопросы отмечены *")}</span><span role="status" className={`survey-save-status ${saveStatus}`}>{t({ saved: "Ответы сохранены", saving: "Сохранение…", pending: "Есть несохранённые ответы", error: "Не удалось сохранить" }[saveStatus])}</span></div>{settings.anonymous && <p className="survey-anonymous-marker"><ShieldCheck size={15} />{t("Анонимный опрос")}</p>}<div className="survey-questions">{questions.map((q, index) => <div key={q.id} onFocusCapture={() => { if (currentQuestion.current !== q.id) { currentQuestion.current = q.id; window.dispatchEvent(new Event("surveyquestionchange")); } }}><SurveyQuestion question={q} number={questions.slice(0, index + 1).filter((field) => field.type !== "content").length} value={answerFor(answers, q.id)} onChange={(value) => change(q, value)} error={answerFor(errors, q.id)} /></div>)}</div><ErrorBox error={error} />{saveStatus === "error" && <button type="button" className="text-link" onClick={() => persist(answersRef.current, response.id).catch(() => {})}><RefreshCw size={16} />{t("Повторить сохранение")}</button>}<div className="survey-submit-row"><button className="survey-submit" type="submit" disabled={busy}>{t(busy ? "Отправка…" : "Отправить ответы")}<ArrowRight size={18} /></button><p>{t("После отправки изменить ответы нельзя.")}</p></div></form>}</>}</div></div>}
  </main></StudentLayout></div>;
}
