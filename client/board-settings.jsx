import React, { useState } from "react";
import { Copy, ExternalLink, RefreshCw, Radio, Save, ShieldCheck } from "lucide-react";
import { t } from "./i18n.jsx";
import "./board-settings.css";

export default function BoardSettings({ quiz, onChange, onPresentationChange, onTokenChange, onSave, saving, dirty, ui }) {
  const { api, Button, Field, Toggle, Modal } = ui;
  const notify = ui.useToast();
  const [rotating, setRotating] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const enabled = quiz.settings.publicBoardEnabled === true;
  const showNames = quiz.settings.publicBoardShowNames === true;
  const showScores = quiz.settings.publicBoardShowScores !== false;
  const scoresAllowed = showScores && quiz.settings.showScore !== false;
  const url = enabled && quiz.publicBoardToken ? `${location.origin}/b/${quiz.publicBoardToken}` : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); notify("Ссылка на табло скопирована"); }
    catch { notify("Не удалось скопировать. Выделите ссылку вручную.", true); }
  };
  const rotate = async () => {
    setRotating(true);
    try {
      const response = await api(`/api/admin/quizzes/${quiz.id}/board/rotate`, { method: "POST" });
      onTokenChange(response.publicBoardToken);
      setConfirm(false);
      notify("Ссылка на табло обновлена");
    } catch (error) { notify(error.message, true); }
    finally { setRotating(false); }
  };
  return <section className="panel settings-panel wide board-settings">
    <div className="section-heading"><div><h2>{t("Табло для аудитории")}</h2><p>{t("Откройте отдельную страницу на проекторе и следите за прохождением квиза.")}</p></div><Radio size={25} /></div>
    <Toggle label="Публичное live-табло" checked={enabled} onChange={onChange} disabled={saving || rotating} description={t("Можно включить и выключить после публикации и начала попыток. Вход администратора на экране аудитории не нужен.")} />
    {enabled && <div className="board-settings-presentation">
      <Toggle label="Показывать имена участников" checked={showNames} onChange={(value) => onPresentationChange("publicBoardShowNames", value)} disabled={saving || rotating} description={t("Имена будут видны каждому, у кого есть ссылка на табло. На самом табло можно переключаться между именами и кодами.")} />
      <Toggle label="Показывать баллы после завершения" checked={showScores} onChange={(value) => onPresentationChange("publicBoardShowScores", value)} disabled={saving || rotating} description={t(quiz.settings.showScore === false ? "Баллы скрыты общей настройкой «Показывать результат». Включите её, чтобы показать итог на табло." : "Только итоговые баллы завершённых работ. Во время прохождения и для аннулированных попыток баллы скрыты.")} />
    </div>}
    <div className="board-settings-privacy"><ShieldCheck size={20} /><p>{t(showNames ? "Имена участников доступны по ссылке на табло." : "Участники отображаются по кодам. Имена скрыты.")} {t(scoresAllowed ? "После завершения видны итоговые баллы." : "Итоговые баллы скрыты.")} {t("IP маскируются. Ответы, ключи и данные браузера не публикуются.")}</p></div>
    {url && <div className="board-settings-share"><Field label={t("Короткая ссылка на табло")} hint={t("Любой, у кого есть эта ссылка, сможет открыть табло. Для сдачи квиза используйте обычное приглашение.")}><input aria-label={t("Короткая ссылка на табло")} value={url} readOnly onFocus={(event) => event.target.select()} /></Field><div className="board-settings-actions"><Button variant="secondary" onClick={copy}><Copy size={18} />{t("Скопировать ссылку")}</Button><a className="button secondary" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} />{t("Открыть табло")}</a><Button variant="secondary" disabled={rotating || saving} onClick={() => setConfirm(true)}><RefreshCw size={18} />{t("Заменить ссылку")}</Button></div></div>}
    {dirty && <div className="board-settings-pending"><p>{t("Изменения вступят в силу после сохранения квиза.")}</p><Button loading={saving} disabled={rotating} onClick={onSave}><Save size={18} />{t("Сохранить изменения")}</Button></div>}
    {confirm && <Modal title={t("Заменить ссылку на табло?")} onClose={() => !rotating && setConfirm(false)}><p>{t("Старая ссылка перестанет работать, в том числе на уже открытом проекторе. Настройки и результаты квиза сохранятся.")}</p><div className="modal-actions"><Button variant="secondary" disabled={rotating} onClick={() => setConfirm(false)}>{t("Отмена")}</Button><Button loading={rotating} onClick={rotate}>{t("Заменить ссылку")}</Button></div></Modal>}
  </section>;
}
