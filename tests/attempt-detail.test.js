import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fixture, quizFor, assertNoSecrets } from "./helpers.js";

test("individual admin report uses the participant snapshot, preserves zero, and never exposes keys to participants", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, {
    settings: { shuffleQuestions: true, shuffleOptions: true, showCorrectAnswersAfterTest: false },
    questions: [
      { id: "zero", type: "number", text: "Числовой ноль", correct: 0, tolerance: 0, points: 2 },
      { id: "choice", type: "single", text: "Варианты", options: [{ id: "a", text: "Первый" }, { id: "b", text: "Второй" }], correct: ["a"], points: 1 },
      { id: "constructor", type: "multiple", text: "Без сохранённого ответа", options: [{ id: "a", text: "Первый" }, { id: "b", text: "Второй" }], correct: ["a"], points: 1 },
      { id: "toString", type: "ordering", text: "Порядок без ответа", options: [{ id: "a", text: "Первый" }, { id: "b", text: "Второй" }], correct: ["a", "b"], points: 1 },
      { id: "info", type: "content", text: "Информация", points: 0 },
    ],
  });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Участник" } });
  assert.equal(start.status, 201);
  const path = `/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}`;
  assert.equal((await student.request(path)).status, 401);
  const active = await admin.request(path);
  assert.equal(active.status, 200);
  assert.equal(active.data.attempt.status, "active");
  assert.deepEqual(active.data.attempt.review, []);
  assert.deepEqual(active.data.attempt.questions.map((q) => [q.id, q.options?.map((o) => o.id) || []]), start.data.questions.map((q) => [q.id, q.options?.map((o) => o.id) || []]));
  assert.equal(active.data.attempt.questions.find((q) => q.id === "zero").correct, 0);
  for (const secret of ["snapshot", "access_hash", "browser_hash", "ip_key"]) assert.equal(Object.hasOwn(active.data.attempt, secret), false);
  const submitted = await student.request(`/api/public/attempts/${start.data.id}/submit`, { method: "POST", body: { answers: { zero: 0, choice: "b" } } });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.review, undefined);
  assertNoSecrets(submitted.data);
  const detail = (await admin.request(path)).data;
  assert.equal(detail.quiz.title, quiz.title);
  assert.equal(detail.attempt.answers.zero, 0);
  assert.equal(detail.attempt.score, 2);
  assert.equal(detail.attempt.maxScore, 5);
  assert.deepEqual(detail.attempt.review.find((q) => q.questionId === "zero"), { questionId: "zero", correct: true, points: 2, maxPoints: 2, expected: ["0"] });
  assert.equal(detail.attempt.review.find((q) => q.questionId === "choice").points, 0);
  assert.equal(detail.attempt.review.find((q) => q.questionId === "constructor").points, 0);
  assert.equal(detail.attempt.review.find((q) => q.questionId === "toString").points, 0);
  assert.equal(detail.attempt.questions.some((q) => q.type === "content"), true);
  const other = await quizFor(admin);
  assert.equal((await admin.request(`/api/admin/quizzes/${other.id}/attempts/${start.data.id}`)).status, 404);
  assert.equal((await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/not-found`)).status, 404);
  assert.equal((await admin.request(path, { method: "DELETE" })).status, 200);
  assert.equal((await admin.request(path)).status, 404);
});

test("individual invalidated report assigns zero points even to saved correct answers", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { antiCheat: true, maxWarnings: 1 } });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Аннулированный", rulesAccepted: true, language: "ru" } });
  assert.equal(start.status, 201);
  const question = quiz.questions.find((q) => q.type === "short");
  const saved = await student.request(`/api/public/attempts/${start.data.id}/answers`, { method: "PUT", body: { answers: { [question.id]: question.correct } } });
  assert.equal(saved.status, 200);
  const violation = await student.request(`/api/public/attempts/${start.data.id}/events`, { method: "POST", body: { type: "visibility", eventId: randomUUID() } });
  assert.equal(violation.status, 200);
  const detail = await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.attempt.status, "invalidated");
  assert.equal(detail.data.attempt.score, 0);
  assert.equal(detail.data.attempt.review.find((q) => q.questionId === question.id).points, 0);
  assert.equal(detail.data.attempt.review.find((q) => q.questionId === question.id).correct, false);
});
