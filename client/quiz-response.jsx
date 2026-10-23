import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileText, RefreshCw, Trash2 } from "lucide-react";
import { t } from "./i18n.jsx";

export default function QuizAttemptPage({ ui }) {
  const { id, attemptId } = useParams();
  const { api, AdminShell, Button, Badge, Loading, Empty, utc, duration, useAdminLive, LiveConnection, PresenceBadge, AttemptProgress, AttemptDeleteDialog, readableAnswer, typeLabels, actionLabels } = ui;
  const navigate = useNavigate();
  const notify = ui.useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const resource = useRef();
  resource.current = `${id}/${attemptId}`;
  const back = `/admin/quizzes/${id}/report`;
  const load = useCallback(async () => {
    try {
      const response = await api(`/api/admin/quizzes/${id}/attempts/${attemptId}`);
      if (resource.current !== `${id}/${attemptId}`) return;
      setData(response);
      setError("");
      setMissing(false);
    } catch (e) {
      if (resource.current !== `${id}/${attemptId}`) return;
      setError(e.message);
      if (e.status === 404) { setMissing(true); setData(null); }
    }
  }, [id, attemptId, api]);
  const { connected, now } = useAdminLive(load, id, attemptId);
  useEffect(() => { window.scrollTo(0, 0); setData(null); }, [id, attemptId]);
  const attempt = data?.attempt;
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/quizzes/${id}/attempts/${attemptId}`, { method: "DELETE" });
      notify("Результат участника удалён");
      navigate(back, { replace: true });
    } catch (e) {
      setDeleting(false);
      if (e.status === 404) { notify("Результат уже удалён или заменён новой попыткой. Список обновлён."); navigate(back, { replace: true }); }
      else notify(e.message, true);
    } finally { setBusy(false); }
  };
  const retake = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/quizzes/${id}/attempts/${attemptId}/retake`, { method: "POST" });
      await load();
      notify("Пересдача разрешена. Участник сможет начать новую попытку.");
    } catch (e) { notify(e.message, true); await load(); }
    finally { setBusy(false); }
  };
  return <AdminShell section="reports"><main className="workspace participant-report-workspace">
    <div className="page-heading participant-report-heading"><div>
      <Link className="text-link" to={back}><ArrowLeft size={19} />{t("К общему отчёту")}</Link>
      <h1>{attempt?.name || t("Отчёт участника")}</h1>
      <p>{attempt?.title || data?.quiz.title || t("Подробности попытки")}</p>
    </div><LiveConnection connected={connected} /></div>
    {error && !missing && <div className="inline-alert" role="alert">{t(error)}<Button variant="secondary" onClick={load}>{t("Повторить")}</Button></div>}
    {missing ? <Empty icon={FileText} title={t("Попытка не найдена.")}>{t("Результат удалён или участник начал новую попытку.")}</Empty> : !attempt ? (!error && <Loading />) : <>
      <section className="panel participant-summary">
        <div><span className="eyebrow">{t("Результат")}</span><h2>{attempt.status === "active" ? t("Ещё проходит") : `${attempt.score ?? 0} / ${attempt.maxScore ?? 0}`}</h2>{attempt.status === "active" ? <AttemptProgress attempt={attempt} /> : <p>{Math.round(attempt.percent || 0)}%</p>}</div>
        <Badge status={attempt.status} />
        <div className="heading-actions">
          {attempt.status === "invalidated" && <Button variant="secondary" loading={busy} disabled={attempt.retakeGranted} onClick={retake}><RefreshCw size={18} />{t(attempt.retakeGranted ? "Пересдача уже разрешена" : "Разрешить пересдачу")}</Button>}
          <Button variant="secondary" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={18} />{t("Удалить результат")}</Button>
        </div>
      </section>
      {attempt.retakeGranted && <p className="info-banner">{t("Пересдача разрешена. Таймер начнётся, когда участник нажмёт «Начать заново».")}</p>}
      <section className="panel participant-metadata"><h2>{t("Данные участника")}</h2><dl className="detail-list">
        <div><dt>ID</dt><dd>{attempt.id}</dd></div>
        <div><dt>{t("Версия вопросов")}</dt><dd>{attempt.contentRevision || 1}</dd></div>
        <div><dt>{t("Группа")}</dt><dd>{attempt.group || "—"}</dd></div>
        <div><dt>{t("Начало")}</dt><dd>{utc(attempt.startedAt)}</dd></div>
        <div><dt>{t("Завершение")}</dt><dd>{utc(attempt.finishedAt)}</dd></div>
        <div><dt>{t("Длительность")}</dt><dd>{duration(attempt.durationSeconds)}</dd></div>
        <div><dt>{t("Лимит до")}</dt><dd>{utc(attempt.expiresAt)}</dd></div>
        <div><dt>{t("IP-адрес")}</dt><dd>{attempt.ip || t("Удалён / не сохранён")}</dd></div>
        <div><dt>User-Agent</dt><dd>{attempt.userAgent || t("Удалён / не сохранён")}</dd></div>
        <div><dt>{t("Предупреждения")}</dt><dd>{attempt.warnings || 0}</dd></div>
        {attempt.status === "active" && <><div><dt>{t("Присутствие")}</dt><dd><PresenceBadge attempt={attempt} now={now} /></dd></div><div><dt>{t("Последний сигнал")}</dt><dd>{utc(attempt.presence?.lastSeenAt)}</dd></div></>}
      </dl></section>
      <section className="participant-answers" aria-label={t("Вопросы и ответы")}><h2>{t("Вопросы и ответы")}</h2>
        {attempt.status === "active" && <p className="muted">{t("Показаны сохранённые ответы. Участник ещё может их изменить.")}</p>}
        {attempt.questions.map((question, index) => {
          const item = attempt.review?.find((review) => review.questionId === question.id);
          const answer = Object.hasOwn(attempt.answers || {}, question.id) ? attempt.answers[question.id] : undefined;
          return <article key={question.id} className="panel participant-answer-card">
            <div className="participant-question-top"><span>{String(index + 1).padStart(2, "0")}</span><span>{t(typeLabels[question.type] || question.type)}</span>{item && <strong>{t("{points} из {max} баллов", { points: item.points, max: item.maxPoints })}</strong>}</div>
            <h2>{question.text}</h2>
            {question.image && <img className="question-image" src={question.image} alt={t("Изображение к вопросу")} />}
            {question.type !== "content" && <>
              {question.options?.length > 0 && <ol className="participant-answer-options">{question.options.map((option) => {
                const chosen = Array.isArray(answer) ? answer.includes(option.id) : answer === option.id;
                return <li key={option.id} className={chosen ? "selected" : ""}><span>{option.text}</span>{chosen && <small>{t("Выбрано")}</small>}</li>;
              })}</ol>}
              <div className="participant-answer-block"><span>{t("Ответ участника")}</span><p>{readableAnswer(question, answer)}</p></div>
              {item && <div className="participant-expected"><span>{t("Правильный ответ")}</span><ul>{item.expected.map((value, i) => <li key={i}>{value}</li>)}</ul></div>}
            </>}
          </article>;
        })}
      </section>
      <section className="panel participant-journal"><h2>{t("Журнал событий")}</h2><div className="audit-events">
        {attempt.events.length ? attempt.events.map((event, index) => <div key={index}><span className="audit-dot" /><div><strong>{t(actionLabels[event.type] || event.type)}{event.counted ? ` · ${t("Нарушение")}` : ""}</strong><small>{utc(event.createdAt)}</small></div></div>) : <p className="muted">{t("Нарушений не зафиксировано.")}</p>}
      </div></section>
      <Link className="button secondary" to={back}><ArrowLeft size={18} />{t("К общему отчёту")}</Link>
    </>}
  </main>{deleting && attempt && <AttemptDeleteDialog attempt={attempt} busy={busy} onClose={() => !busy && setDeleting(false)} onConfirm={remove} />}</AdminShell>;
}
