import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { translate, LANGUAGES, detectLanguage } from "./locales.js";

function initialLanguage() {
  try {
    const saved = localStorage.getItem("forma-language");
    if (saved === "ru" || saved === "kk") return saved;
  } catch {}
  return detectLanguage(navigator.languages || [navigator.language]);
}
let currentLanguage = initialLanguage();
export const t = (text, values) => translate(text, currentLanguage, values);
export const getLanguage = () => currentLanguage;
const LanguageContext = createContext(null);
export function LanguageProvider({ children }) {
  const [language, updateLanguage] = useState(currentLanguage);
  const setLanguage = useCallback((next) => {
    if (next !== "ru" && next !== "kk") return;
    currentLanguage = next;
    try {
      localStorage.setItem("forma-language", next);
    } catch {}
    updateLanguage(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const translateCurrent = useCallback(
    (text, values) => translate(text, language, values),
    [language],
  );
  return (
    <LanguageContext.Provider
      value={{ language, setLanguage, t: translateCurrent }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
export function useLanguage() {
  return useContext(LanguageContext);
}
export function LanguageSwitcher() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div
      className="language-switcher"
      role="group"
      aria-label={t("Язык интерфейса")}
    >
      {LANGUAGES.map((option) => (
        <button
          key={option.code}
          type="button"
          aria-pressed={language === option.code}
          aria-label={option.name}
          lang={option.code}
          onClick={() => setLanguage(option.code)}
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}
