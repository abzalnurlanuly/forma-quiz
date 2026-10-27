import React, { useEffect, useId, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Check, Copy } from "lucide-react";
import { t } from "./i18n.jsx";

function JoinQr({ value }) {
  const id = useId();
  const qr = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value, "Byte");
    code.make();
    const modules = code.getModuleCount();
    const quiet = 4;
    const paths = [];
    // Horizontal runs keep the SVG compact. The quiet zone is part of the
    // viewBox, so responsive sizing cannot crop the four white border modules.
    for (let row = 0; row < modules; row++) {
      let column = 0;
      while (column < modules) {
        if (!code.isDark(row, column)) { column++; continue; }
        const start = column;
        while (column < modules && code.isDark(row, column)) column++;
        const width = column - start;
        paths.push(`M${start + quiet} ${row + quiet}h${width}v1h-${width}z`);
      }
    }
    return { size: modules + quiet * 2, path: paths.join("") };
  }, [value]);
  return <svg className="board-join-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-labelledby={`${id}-title ${id}-description`} xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <title id={`${id}-title`}>{t("QR-код для открытия квиза")}</title>
    <desc id={`${id}-description`}>{value}</desc>
    <rect width={qr.size} height={qr.size} fill="#fff" />
    <path d={qr.path} fill="#000" />
  </svg>;
}

export function boardJoinUrl(path) {
  if (typeof path !== "string" || !/^\/q\/[a-z0-9][a-z0-9-]{2,79}$/.test(path)) return null;
  return new URL(path, window.location.origin).href;
}

export default function BoardJoin({ url, closed }) {
  const [copyState, setCopyState] = useState("");
  useEffect(() => { setCopyState(""); }, [url]);
  useEffect(() => { if (!copyState) return; const timer = setTimeout(() => setCopyState(""), 4000); return () => clearTimeout(timer); }, [copyState]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopyState("copied"); }
    catch { setCopyState("manual"); }
  };
  const parsed = new URL(url);
  return <aside className={`board-join ${closed ? "closed" : ""}`} aria-label={t(closed ? "Продолжить квиз" : "Присоединиться к квизу")}>
    <JoinQr value={url} />
    <div className="board-join-info">
      <h2>{t(closed ? "Продолжить квиз" : "Открыть квиз")}</h2>
      <p className="board-join-help">{t(closed ? "Приём закрыт. Начавшие участники могут продолжить." : "Наведите камеру телефона на QR-код.")}</p>
      <a className="board-join-link" href={url} title={url} target="_blank" rel="noreferrer">{parsed.host}{parsed.pathname}</a>
      <button className="board-join-copy" type="button" onClick={copy} aria-label={t(copyState === "copied" ? "Ссылка скопирована" : "Копировать ссылку на квиз")}>{copyState === "copied" ? <Check size={17} /> : <Copy size={17} />}{t(copyState === "copied" ? "Скопировано" : "Ссылка")}</button>
      <span className="board-join-copy-status" role="status">{copyState === "manual" ? t("Откройте ссылку или скопируйте её вручную.") : copyState === "copied" ? t("Ссылка скопирована") : ""}</span>
    </div>
  </aside>;
}
