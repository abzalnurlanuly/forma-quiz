import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function surveyQuestions() {
  return ["short", "long", "single", "multiple", "dropdown", "rating", "scale", "number", "date", "content"].map((type) => ({
    id: randomUUID(), type, text: `Вопрос ${type}`, description: "Описание", required: true,
    image: null,
    ...(["single", "multiple", "dropdown"].includes(type) ? { options: [
      { id: randomUUID(), text: "Первый вариант" }, { id: randomUUID(), text: "Второй вариант" },
    ] } : {}),
    ...(type === "number" ? { min: -1, max: 2, step: 0.5 } : {}),
    ...(type === "scale" ? { min: 0, max: 10, step: 2 } : {}),
  }));
}

export async function surveyFor(admin, overrides = {}) {
  const created = await admin.request("/api/admin/surveys", { method: "POST", body: { title: "Проверочный опрос" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const survey = {
    ...created.data, questions: surveyQuestions(), status: "published", ...overrides,
    settings: { ...created.data.settings, ...overrides.settings },
    theme: { ...created.data.theme, ...overrides.theme },
  };
  const saved = await admin.request(`/api/admin/surveys/${survey.id}`, { method: "PUT", body: survey });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return saved.data;
}

export function surveyAnswers(survey, text = "Ответ участника") {
  return Object.fromEntries(survey.questions.filter((q) => q.type !== "content").map((q) => [q.id,
    ["short", "long"].includes(q.type) ? `${text} ${q.type}`
      : ["single", "dropdown"].includes(q.type) ? q.options[0].id
        : q.type === "multiple" ? q.options.map((o) => o.id)
          : q.type === "date" ? "2024-02-29" : q.type === "rating" ? 4 : 0,
  ]));
}
