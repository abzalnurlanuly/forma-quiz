import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, translate, LANGUAGES } from "../client/locales.js";

test("browser language detection chooses the first supported locale and otherwise Russian", () => {
  assert.equal(detectLanguage(["en-US", "kk-KZ", "ru-RU"]), "kk");
  assert.equal(detectLanguage(["ru-RU", "kk-KZ"]), "ru");
  assert.equal(detectLanguage(["en-US", "de"]), "ru");
  assert.equal(detectLanguage([]), "ru");
  assert.equal(detectLanguage([null, " KK_kz "]), "kk");
  assert.equal(detectLanguage("kk-KZ"), "kk");
  assert.deepEqual(
    LANGUAGES.map(({ code }) => code),
    ["ru", "kk"],
  );
});

test("Kazakh translates interface keys while unknown quiz content is preserved", () => {
  assert.equal(translate("Администратор", "kk"), "Әкімші");
  assert.equal(translate("Назад", "kk"), "Артқа");
  assert.equal(translate("Далее", "kk-KZ"), "Келесі");
  for (const language of ["ru", "kk", "en"]) {
    for (const value of [
      "Abzal Nurlanuly",
      "25-13",
      "Какой протокол шифрует трафик?",
    ]) {
      assert.equal(translate(value, language), value);
    }
  }
  assert.equal(translate("  Назад  ", "ru"), "  Назад  ");
  assert.equal(translate("  Назад  ", "kk"), "Артқа");
});

test("interpolation preserves original names and markup as plain text", () => {
  assert.equal(
    translate("Имя: {name}", "ru", { name: "<b>Нұрлан</b>" }),
    "Имя: <b>Нұрлан</b>",
  );
  assert.equal(
    translate("Неизвестный ключ {name}", "kk", { name: "Abzal Nurlanuly" }),
    "Неизвестный ключ Abzal Nurlanuly",
  );
  assert.equal(translate(null, "kk"), "");
  assert.equal(translate("{value}", "ru", { value: 0 }), "0");
});
