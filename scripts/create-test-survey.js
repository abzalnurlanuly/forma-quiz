import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, transaction } from "../server/db.js";
import { newSurvey, validateSurvey } from "../server/surveys.js";

const fixtureSlug = "test-survey-all-question-types";
const fixtureTitle = "Тестовый опрос: все типы вопросов";
// This exact introduction identifies this fixture without adding public fields
// or treating an unrelated survey with the same title as safe to reuse.
const fixtureIntro = "Это тестовый опрос для проверки всех 10 типов вопросов Forma. " +
  "Используйте только вымышленные ответы и не указывайте личные данные. " +
  "Опрос создан как черновик: просмотр и публикация доступны администратору.";

function question(type, text, description, required = false, extra = {}) {
  return { id: randomUUID(), type, text, description, required, image: null, options: [], ...extra };
}

function options(texts) {
  return texts.map((text) => ({ id: randomUUID(), text }));
}

function fixture(dataDir) {
  const survey = {
    ...newSurvey(fixtureTitle),
    slug: fixtureSlug,
    description: "Тестовая анкета с примерами текста, выбора, рейтинга, шкалы, числа, даты и информационного блока. Служит для проверки редактора и мобильной формы.",
    intro: fixtureIntro,
    outro: "Тестовое заполнение завершено. Спасибо за проверку формы! Эти ответы предназначены только для тестирования.",
    status: "draft",
    settings: {
      anonymous: true,
      collectName: false,
      collectIp: false,
      collectUserAgent: false,
      oneResponsePerIp: false,
      oneResponsePerBrowser: false,
      deadline: null,
    },
    questions: [
      question("short", "Тест: как называется ваш учебный проект?", "Тестовая подсказка: введите короткое вымышленное название, например «Орбита». Не указывайте имя или контакты.", true),
      question("long", "Тест: что вы хотели бы улучшить в форме?", "Тестовая подсказка: напишите несколько предложений. Можно добавить переносы строк и проверить длинный текст."),
      question("single", "Тест: какой формат объяснения вам удобнее?", "Тестовая подсказка: выберите только один вариант.", true, {
        options: options(["Краткая инструкция", "Подробное объяснение", "Пример с иллюстрацией"]),
      }),
      question("multiple", "Тест: на каких устройствах проверить форму?", "Тестовая подсказка: можно выбрать несколько вариантов или оставить вопрос без ответа.", false, {
        options: options(["Телефон", "Ноутбук", "Планшет", "Настольный компьютер"]),
      }),
      question("dropdown", "Тест: выберите цель учебного проекта", "Тестовая подсказка: откройте список и выберите один пункт.", true, {
        options: options(["Учебное задание", "Сбор обратной связи", "Проверка интерфейса", "Демонстрация возможностей"]),
      }),
      question("rating", "Тест: насколько удобно заполнять форму?", "Тестовая подсказка: поставьте оценку от 1 до 5. В этом примере ответ обязателен.", true, {
        min: 1, max: 5, step: 1, minLabel: "Совсем неудобно", maxLabel: "Очень удобно",
      }),
      question("scale", "Тест: насколько вероятно, что вы порекомендуете эту форму?", "Тестовая подсказка: передвиньте ползунок от 0 до 10 или явно выберите предложенное значение. Начальная позиция не считается ответом.", false, {
        min: 0, max: 10, step: 1, minLabel: "Точно не порекомендую", maxLabel: "Обязательно порекомендую",
      }),
      question("number", "Тест: сколько минут занимает пример задания?", "Тестовая подсказка: введите число от 0 до 100 с шагом 0,5. Допустимы, например, 0; 7,5; 20.", true, {
        min: 0, max: 100, step: 0.5, minLabel: "", maxLabel: "",
      }),
      question("date", "Тест: выберите дату пробного занятия", "Тестовая подсказка: выберите любую вымышленную дату. Этот вопрос можно пропустить."),
      question("content", "Тестовый информационный блок", "Тестовое пояснение: этот блок не требует ответа и не входит в число заполняемых вопросов. Здесь можно разместить инструкцию, описание раздела или благодарность."),
    ],
  };
  // Validate the complete new document before inserting it. Supplying the same
  // initial content as its original keeps this freshly created fixture at v1.
  return validateSurvey(survey, survey, dataDir);
}

function describe(survey, result) {
  return {
    result,
    id: survey.id,
    title: survey.title,
    status: survey.status,
    editorPath: `/admin/surveys/${survey.id}`,
    questionTypes: survey.questions.map((entry) => entry.type),
  };
}

try {
  if (process.argv.length > 2)
    throw new Error("Команда: node scripts/create-test-survey.js. Каталог данных задаётся через DATA_DIR.");
  const dataDir = resolve(process.env.DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../data"));
  const db = openDatabase(dataDir);
  try {
    const result = transaction(db, () => {
      const matches = db.prepare(`
        SELECT doc FROM surveys
        WHERE slug = ? OR EXISTS (
          SELECT 1 FROM json_each(surveys.doc, '$.slugAliases') AS aliases
          WHERE aliases.value = ?
        )
      `).all(fixtureSlug, fixtureSlug);
      if (matches.length > 1)
        throw new Error("Ссылка тестового опроса относится к нескольким существующим опросам. Все опросы оставлены без изменений.");
      const existing = matches[0];
      if (existing) {
        const survey = JSON.parse(existing.doc);
        if (survey.intro !== fixtureIntro)
          throw new Error("Ссылка тестового опроса уже занята другим опросом. Существующий опрос оставлен без изменений.");
        return describe(survey, "already_exists");
      }
      const survey = fixture(dataDir);
      db.prepare("INSERT INTO surveys(id,slug,doc) VALUES(?,?,?)").run(survey.id, survey.slug, JSON.stringify(survey));
      return describe(survey, "created");
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
