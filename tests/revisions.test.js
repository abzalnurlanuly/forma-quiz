import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import JSZip from "jszip";
import { fixture, quizFor, assertNoSecrets } from "./helpers.js";
import { surveyFor } from "./survey-helpers.js";

async function ok(client, path, method = "GET", body, status = 200) {
  const result = await client.request(path, { method, body });
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const quizPath = (quiz) => `/api/admin/quizzes/${quiz.id}`;
const surveyPath = (survey) => `/api/admin/surveys/${survey.id}`;
const attemptPath = (attempt) => `/api/public/attempts/${attempt.id}`;
const responsePath = (response) => `/api/public/responses/${response.id}`;
const startQuiz = (student, quiz, name) => ok(student, `/api/public/quizzes/${quiz.slug}/start`, "POST", { name, rulesAccepted: true }, 201);
const startSurvey = (student, survey) => ok(student, `/api/public/surveys/${survey.slug}/start`, "POST", {}, 201);
function rowState(app, table, id) { return app.locals.db.prepare(`SELECT snapshot,answers,status,finished_at FROM ${table} WHERE id=?`).get(id); }
function snapshot(app, table, id) { return JSON.parse(rowState(app, table, id).snapshot); }

test("published quiz edits create a new content revision without replacing active or submitted question snapshots", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { settings: { shuffleQuestions: false, shuffleOptions: false }, questions: [
    { id: "same", type: "single", text: "Вопрос прежней версии", points: 2, options: [{ id: "a", text: "Старый первый" }, { id: "b", text: "Старый второй" }], correct: ["a"] },
    { id: "removed", type: "number", text: "Удаляемый вопрос", points: 3, correct: 7, tolerance: 0 },
    { id: "renamed", type: "short", text: "Переименовываемый ID", points: 1, correct: "старый" },
    { id: "order", type: "ordering", text: "Прежний порядок", points: 4, options: [{ id: "x", text: "Альфа" }, { id: "y", text: "Бета" }, { id: "z", text: "Гамма" }], correct: ["x", "y", "z"] },
  ] });
  const previousRevision = quiz.contentRevision;
  assert.ok(Number.isSafeInteger(previousRevision) && previousRevision >= 1);
  const oldQuiz = structuredClone(quiz);
  const activeStudent = browser(), finishedStudent = browser();
  const active = await startQuiz(activeStudent, quiz, "Начал до изменения");
  const finished = await startQuiz(finishedStudent, quiz, "Сдал до изменения");
  const oldAnswers = { same: "a", removed: 7, renamed: "старый", order: ["x", "y", "z"] };
  await ok(activeStudent, `${attemptPath(active)}/answers`, "PUT", { answers: { same: "a" } });
  const completed = await ok(finishedStudent, `${attemptPath(finished)}/submit`, "POST", { answers: oldAnswers });
  assert.equal(completed.percent, 100);
  const frozenActive = snapshot(app, "attempts", active.id);
  const frozenFinished = rowState(app, "attempts", finished.id);
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, contentRevision: 999999, title: "Новая редакция квиза", questions: [
    { ...quiz.questions[3], text: "Новый порядок", options: quiz.questions[3].options.map((option) => ({ ...option, text: `${option.text} новой версии` })), correct: ["z", "y", "x"] },
    { id: "same", type: "number", text: "Тот же ID, другой тип", points: 3, correct: 99, tolerance: 0 },
    { id: "added", type: "single", text: "Новый вопрос", points: 5, options: [{ id: "a", text: "Новый первый" }, { id: "b", text: "Новый второй" }], correct: ["b"] },
    { id: "new-id", type: "short", text: "Новый идентификатор", points: 1, correct: "новый" },
  ] });
  assert.equal(quiz.contentRevision, previousRevision + 1, "The server owns revision numbers");
  assert.deepEqual(snapshot(app, "attempts", active.id).questions, frozenActive.questions);
  assert.deepEqual(rowState(app, "attempts", finished.id), frozenFinished);
  const resumed = await ok(activeStudent, attemptPath(active));
  assert.deepEqual(resumed.questions, active.questions, "Randomized presentation order and option labels are immutable");
  assert.equal(resumed.contentRevision, previousRevision);
  assertNoSecrets(resumed);
  assert.equal((await activeStudent.request(`${attemptPath(active)}/answers`, { method: "PUT", body: { answers: { same: 99 } } })).status, 400, "An old single-choice question cannot accept the new numeric type");
  await ok(activeStudent, `${attemptPath(active)}/answers`, "PUT", { answers: oldAnswers });
  const oldFinal = await ok(activeStudent, `${attemptPath(active)}/submit`, "POST", {});
  assert.equal(oldFinal.percent, 100, "Old attempts use their original keys, including ordering");
  const newStudent = browser(), newest = await startQuiz(newStudent, quiz, "Начал новую версию");
  assert.equal(newest.contentRevision, quiz.contentRevision);
  assert.deepEqual(newest.questions.map((q) => q.id), quiz.questions.map((q) => q.id));
  assert.equal(newest.questions.find((q) => q.id === "same").type, "number");
  assertNoSecrets(newest);
  const newFinal = await ok(newStudent, `${attemptPath(newest)}/submit`, "POST", { answers: { same: 99, added: "b", "new-id": "новый", order: ["z", "y", "x"] } });
  assert.equal(newFinal.percent, 100);
  const detail = await ok(admin, `${quizPath(quiz)}/attempts/${finished.id}`);
  assert.deepEqual(detail.attempt.questions, JSON.parse(frozenFinished.snapshot).questions);
  assert.equal(detail.attempt.contentRevision, previousRevision);
  assert.deepEqual(detail.attempt.review.find((q) => q.questionId === "same").expected, ["Старый первый"]);
  const report = await ok(admin, `${quizPath(quiz)}/report`);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.questionsContentRevision, quiz.contentRevision);
  assert.equal(report.summary.questionsAttemptCount, 1);
  assert.equal(report.summary.questionsFinalizedCount, 1);
  assert.ok(report.questions.every((q) => q.total === 1), "Old results with reused question IDs cannot enter current-version statistics");
  assert.equal(report.revisions.find((r) => r.contentRevision === previousRevision).summary.total, 2);
  assert.equal(report.revisions.find((r) => r.contentRevision === quiz.contentRevision).summary.total, 1);
  const settingsOnly = await ok(admin, quizPath(quiz), "PUT", { ...quiz, title: "Новое описание без новой структуры", description: "Только подпись", contentRevision: 1, settings: { ...quiz.settings, maxWarnings: 2 } });
  assert.equal(settingsOnly.contentRevision, quiz.contentRevision);
  assert.equal(oldQuiz.questions[0].text, "Вопрос прежней версии");
});

test("active immediate checks retain their original keys and answer locks after questions and anti-cheat settings change", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { settings: { feedbackMode: "immediate", antiCheat: false, maxWarnings: 3 }, questions: [{ id: "same", type: "single", text: "Старый ключ", points: 2, options: [{ id: "a", text: "Первый" }, { id: "b", text: "Второй" }], correct: ["a"] }] });
  const student = browser(), active = await startQuiz(student, quiz, "Проверил до изменения");
  const checked = await ok(student, `${attemptPath(active)}/check`, "POST", { questionId: "same", answer: "a" });
  assert.equal(checked.feedback.same.correct, true);
  const revision = quiz.contentRevision;
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, antiCheat: true, maxWarnings: 2, blockPaste: true }, questions: [{ ...quiz.questions[0], text: "Ключ изменён", correct: ["b"] }] });
  assert.equal(quiz.contentRevision, revision + 1);
  const current = await ok(student, attemptPath(active));
  assert.equal(current.settings.antiCheat, true);
  assert.equal(current.settings.maxWarnings, 2);
  assert.equal(current.contentRevision, revision);
  assert.equal(current.feedback.same.correct, true);
  assert.equal((await student.request(`${attemptPath(active)}/answers`, { method: "PUT", body: { answers: { same: "b" } } })).status, 409);
  assert.equal((await ok(student, `${attemptPath(active)}/events`, "POST", { type: "paste", eventId: randomUUID() })).warnings, 1);
  assert.equal((await ok(student, `${attemptPath(active)}/submit`, "POST", {})).percent, 100);
  const newStudent = browser(), next = await startQuiz(newStudent, quiz, "Новый ключ");
  assert.equal((await ok(newStudent, `${attemptPath(next)}/check`, "POST", { questionId: "same", answer: "b" })).feedback.same.correct, true);
});

test("survey edits preserve required fields and option semantics for old responses while aggregates use the current revision", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let survey = await surveyFor(admin, { title: "Исходный опрос", questions: [
    { id: "same", type: "single", text: "Прежний выбор", required: true, options: [{ id: "a", text: "Старая альфа" }, { id: "b", text: "Старая бета" }] },
    { id: "removed", type: "long", text: "Удаляемое поле", required: true },
    { id: "renamed", type: "number", text: "Переименованный ID", required: true, min: 0, max: 100, step: 1 },
  ] });
  const oldRevision = survey.contentRevision, original = structuredClone(survey);
  const activeStudent = browser(), finishedStudent = browser();
  const active = await startSurvey(activeStudent, survey), finished = await startSurvey(finishedStudent, survey);
  const oldAnswers = { same: "a", removed: "Сохранённое объяснение", renamed: 0 };
  await ok(activeStudent, `${responsePath(active)}/answers`, "PUT", { answers: { removed: oldAnswers.removed } });
  await ok(finishedStudent, `${responsePath(finished)}/submit`, "POST", { answers: oldAnswers });
  const frozen = rowState(app, "survey_responses", finished.id);
  survey = await ok(admin, surveyPath(survey), "PUT", { ...survey, title: "Опрос после изменений", contentRevision: 9000, questions: [
    { id: "new-id", type: "number", text: "Новый ID", required: true, min: 0, max: 100, step: 1 },
    { id: "same", type: "number", text: "Тот же ID теперь число", required: true, min: 0, max: 100, step: 1 },
    { id: "added", type: "multiple", text: "Новый обязательный вопрос", required: true, options: [{ id: "a", text: "Новая альфа" }, { id: "b", text: "Новая бета" }] },
  ] });
  assert.equal(survey.contentRevision, oldRevision + 1);
  assert.deepEqual(rowState(app, "survey_responses", finished.id), frozen, "Published edits do not rewrite completed answers or snapshots");
  const resumed = await ok(activeStudent, responsePath(active));
  assert.deepEqual(resumed.questions, active.questions);
  assert.equal(resumed.contentRevision, oldRevision);
  assert.equal(resumed.title, original.title);
  assert.equal((await activeStudent.request(`${responsePath(active)}/answers`, { method: "PUT", body: { answers: { same: 20 } } })).status, 400);
  assert.equal((await activeStudent.request(`${responsePath(active)}/submit`, { method: "POST", body: { answers: { same: "a" } } })).status, 400, "Removing or renaming a required field in the editor does not erase it from a started form");
  await ok(activeStudent, `${responsePath(active)}/answers`, "PUT", { answers: oldAnswers });
  assert.equal((await ok(activeStudent, `${responsePath(active)}/submit`, "POST", {})).status, "submitted");
  const newStudent = browser(), newest = await startSurvey(newStudent, survey);
  assert.equal(newest.contentRevision, survey.contentRevision);
  assert.deepEqual(newest.questions, survey.questions);
  assert.equal((await newStudent.request(`${responsePath(newest)}/submit`, { method: "POST", body: { answers: { same: 20, "new-id": 0 } } })).status, 400);
  await ok(newStudent, `${responsePath(newest)}/submit`, "POST", { answers: { same: 20, "new-id": 0, added: ["b"] } });
  const report = await ok(admin, `${surveyPath(survey)}/report`);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.questionsContentRevision, survey.contentRevision);
  assert.equal(report.summary.questionsResponseCount, 1);
  assert.equal(report.summary.questionsSubmittedCount, 1);
  assert.equal(report.questions.find((q) => q.id === "same").aggregates.average, 20, "String answers from an older single-choice field cannot enter the new number average");
  assert.deepEqual(report.questions.find((q) => q.id === "added").aggregates.options.map((o) => o.count), [0, 1]);
  const oldResponse = report.responses.find((r) => r.id === finished.id);
  assert.deepEqual(oldResponse.questions, JSON.parse(frozen.snapshot).questions);
  assert.equal(oldResponse.title, original.title);
  assert.equal(oldResponse.contentRevision, oldRevision);
  assert.equal(report.revisions.find((r) => r.contentRevision === oldRevision).summary.total, 2);
  const same = await ok(admin, surveyPath(survey), "PUT", { ...survey, description: "Только описание", settings: { ...survey.settings, deadline: new Date(Date.now() + 600000).toISOString() } });
  assert.equal(same.contentRevision, survey.contentRevision);
});

test("changing public links and quiz rosters preserves old identity, browser binding and frozen form content", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const groupId = randomUUID(), studentId = randomUUID();
  let quiz = await quizFor(admin, { groups: [{ id: groupId, name: "Прежняя группа", students: [{ id: studentId, name: "Прежнее имя", code: "123456" }] }], settings: { rosterEnabled: true, requireStudentCode: true } });
  const client = browser();
  const active = await ok(client, `/api/public/quizzes/${quiz.slug}/start`, "POST", { groupId, studentId, code: "123456" }, 201);
  const oldSlug = quiz.slug, revision = quiz.contentRevision, frozen = snapshot(app, "attempts", active.id).questions;
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, slug: `${quiz.slug}-renamed`, groups: [{ id: groupId, name: "Новая группа", students: [{ id: studentId, name: "Новое имя", code: "654321" }] }] });
  assert.equal(quiz.contentRevision, revision, "Link and roster changes do not change question statistics");
  assert.equal((await ok(browser(), `/api/public/quizzes/${oldSlug}`)).id, quiz.id);
  assert.equal((await ok(client, `/api/public/quizzes/${oldSlug}`)).attempt.id, active.id, "The original invitation still resumes a bound attempt after a link change");
  assert.equal((await browser().request(`/api/public/quizzes/${quiz.slug}`)).status, 200);
  const continued = await ok(client, attemptPath(active));
  assert.equal(continued.name, "Прежнее имя");
  assert.equal(continued.group, "Прежняя группа");
  assert.deepEqual(snapshot(app, "attempts", active.id).questions, frozen);
  assert.equal((await browser().request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { groupId, studentId, code: "654321" } })).status, 409, "Roster edits do not release a student's duplicate claim");
  let survey = await surveyFor(admin, { questions: [{ id: "text", type: "short", text: "Исходный текст", required: true }] });
  const respondent = browser(), response = await startSurvey(respondent, survey), previousSlug = survey.slug;
  const surveyRevision = survey.contentRevision;
  survey = await ok(admin, surveyPath(survey), "PUT", { ...survey, slug: `${survey.slug}-renamed` });
  assert.equal(survey.contentRevision, surveyRevision);
  assert.equal((await ok(browser(), `/api/public/surveys/${previousSlug}`)).id, survey.id);
  assert.equal((await ok(respondent, `/api/public/surveys/${previousSlug}`)).response.id, response.id);
  await ok(respondent, `${responsePath(response)}/submit`, "POST", { answers: { text: "Ответ по старой ссылке сохранён" } });
  assert.equal((await browser().request(`/api/public/surveys/${survey.slug}`)).status, 200);
});

test("legacy quiz and survey documents and snapshots without revision fields are revision one and stay frozen after editing", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { questions: [{ id: "same", type: "short", text: "Старый вопрос", points: 1, correct: "первый" }] });
  const student = browser(), active = await startQuiz(student, quiz, "Старый формат");
  let survey = await surveyFor(admin, { questions: [{ id: "same", type: "short", text: "Старая анкета", required: true }] });
  const respondent = browser(), response = await startSurvey(respondent, survey);
  for (const [table, recordId] of [["quizzes", quiz.id], ["surveys", survey.id]]) {
    const doc = JSON.parse(app.locals.db.prepare(`SELECT doc FROM ${table} WHERE id=?`).get(recordId).doc);
    delete doc.contentRevision;
    app.locals.db.prepare(`UPDATE ${table} SET doc=? WHERE id=?`).run(JSON.stringify(doc), recordId);
  }
  for (const [table, recordId] of [["attempts", active.id], ["survey_responses", response.id]]) {
    const doc = snapshot(app, table, recordId);
    delete doc.contentRevision;
    app.locals.db.prepare(`UPDATE ${table} SET snapshot=? WHERE id=?`).run(JSON.stringify(doc), recordId);
  }
  assert.equal((await ok(student, attemptPath(active))).contentRevision, 1);
  assert.equal((await ok(respondent, responsePath(response))).contentRevision, 1);
  quiz = await ok(admin, quizPath(quiz));
  survey = await ok(admin, surveyPath(survey));
  assert.equal(quiz.contentRevision, 1);
  assert.equal(survey.contentRevision, 1);
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, questions: [{ ...quiz.questions[0], text: "Новый вопрос", correct: "второй" }] });
  survey = await ok(admin, surveyPath(survey), "PUT", { ...survey, questions: [{ ...survey.questions[0], text: "Новая анкета" }] });
  assert.equal(quiz.contentRevision, 2);
  assert.equal(survey.contentRevision, 2);
  assert.equal((await ok(student, `${attemptPath(active)}/submit`, "POST", { answers: { same: "первый" } })).percent, 100);
  await ok(respondent, `${responsePath(response)}/submit`, "POST", { answers: { same: "Старый ответ" } });
  assert.equal((await ok(admin, `${quizPath(quiz)}/report`)).attempts[0].contentRevision, 1);
  assert.equal((await ok(admin, `${surveyPath(survey)}/report`)).responses[0].contentRevision, 1);
});

test("failed structural edits are atomic and cannot change content revisions or active snapshots", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin), survey = await surveyFor(admin);
  const active = await startQuiz(browser(), quiz, "Проверка атомарности"), response = await startSurvey(browser(), survey);
  const quizBefore = app.locals.db.prepare("SELECT doc FROM quizzes WHERE id=?").get(quiz.id).doc;
  const surveyBefore = app.locals.db.prepare("SELECT doc FROM surveys WHERE id=?").get(survey.id).doc;
  const quizSnapshot = rowState(app, "attempts", active.id), surveySnapshot = rowState(app, "survey_responses", response.id);
  assert.equal((await admin.request(quizPath(quiz), { method: "PUT", body: { ...quiz, questions: [{ id: "bad", type: "number", text: "Неверный ключ", correct: "NaN", points: 1 }] } })).status, 400);
  assert.equal((await admin.request(surveyPath(survey), { method: "PUT", body: { ...survey, questions: [{ id: "bad", type: "number", text: "Неверные границы", min: 5, max: 1 }] } })).status, 400);
  assert.equal(app.locals.db.prepare("SELECT doc FROM quizzes WHERE id=?").get(quiz.id).doc, quizBefore);
  assert.equal(app.locals.db.prepare("SELECT doc FROM surveys WHERE id=?").get(survey.id).doc, surveyBefore);
  assert.deepEqual(rowState(app, "attempts", active.id), quizSnapshot);
  assert.deepEqual(rowState(app, "survey_responses", response.id), surveySnapshot);
});

test("versioned Excel reports retain old question definitions while public exports omit all versions of participant answers and keys", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { questions: [{ id: "old", type: "short", text: "OLD_REVISION_QUESTION_TEXT", points: 1, correct: "PRIVATE_KEY_OLD_REVISION" }, { id: "option", type: "single", text: "OLD_CHOICE_QUESTION", points: 1, options: [{ id: "a", text: "OLD_REVISION_OPTION_TEXT" }, { id: "b", text: "Old other" }], correct: ["a"] }] });
  const oldStudent = browser(), old = await startQuiz(oldStudent, quiz, "До редактирования");
  await ok(oldStudent, `${attemptPath(old)}/submit`, "POST", { answers: { old: "PRIVATE_PARTICIPANT_OLD_REVISION", option: "b" } });
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, questions: [{ id: "new", type: "short", text: "NEW_REVISION_QUESTION_TEXT", points: 1, correct: "PRIVATE_KEY_NEW_REVISION" }] });
  const newStudent = browser(), next = await startQuiz(newStudent, quiz, "После редактирования");
  await ok(newStudent, `${attemptPath(next)}/submit`, "POST", { answers: { new: "PRIVATE_PARTICIPANT_NEW_REVISION" } });
  for (const variant of ["public", "private"]) {
    const result = await admin.request(`${quizPath(quiz)}/export.xlsx?variant=${variant}`);
    assert.equal(result.status, 200);
    const zip = await JSZip.loadAsync(result.data);
    const xml = (await Promise.all(Object.values(zip.files).filter((file) => !file.dir && file.name.endsWith(".xml")).map((file) => file.async("string")))).join("\n");
    for (const text of ["OLD_REVISION_QUESTION_TEXT", "OLD_REVISION_OPTION_TEXT", "NEW_REVISION_QUESTION_TEXT"]) assert.ok(xml.includes(text), `${variant} lost ${text}`);
    for (const text of ["PRIVATE_KEY_OLD_REVISION", "PRIVATE_KEY_NEW_REVISION", "PRIVATE_PARTICIPANT_OLD_REVISION", "PRIVATE_PARTICIPANT_NEW_REVISION"]) assert.equal(xml.includes(text), variant === "private", `${variant}: ${text}`);
  }
});

test("an authorized retake starts the current revision and archives the invalidated run with its original questions and answers", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { settings: { antiCheat: true, maxWarnings: 1 }, questions: [{ id: "same", type: "short", text: "Старая попытка", points: 1, correct: "старый ключ" }] });
  const student = browser(), active = await startQuiz(student, quiz, "Пересдача новой версии");
  const previousRevision = quiz.contentRevision;
  await ok(student, `${attemptPath(active)}/answers`, "PUT", { answers: { same: "Старый ответ" } });
  assert.equal((await ok(student, `${attemptPath(active)}/events`, "POST", { type: "visibility", eventId: randomUUID() })).status, "invalidated");
  const previousSnapshot = snapshot(app, "attempts", active.id);
  quiz = await ok(admin, quizPath(quiz), "PUT", { ...quiz, questions: [{ id: "same", type: "number", text: "Новая попытка", points: 2, correct: 0, tolerance: 0 }] });
  await ok(admin, `${quizPath(quiz)}/attempts/${active.id}/retake`, "POST", {});
  const retry = await startQuiz(student, quiz, "Пересдача новой версии");
  assert.notEqual(retry.id, active.id);
  assert.equal(retry.contentRevision, quiz.contentRevision);
  assert.equal(retry.questions[0].type, "number");
  assert.deepEqual(retry.answers, {});
  const archived = JSON.parse(app.locals.db.prepare("SELECT doc FROM attempt_history WHERE attempt_id=?").get(retry.id).doc);
  assert.deepEqual(archived.snapshot, previousSnapshot);
  assert.equal(archived.snapshot.contentRevision, previousRevision);
  assert.deepEqual(archived.answers, { same: "Старый ответ" });
  assert.equal((await ok(student, `${attemptPath(retry)}/submit`, "POST", { answers: { same: 0 } })).percent, 100);
  assert.equal((await student.request(`${attemptPath(active)}/answers`, { method: "PUT", body: { answers: { same: "поздний старый ответ" } } })).status, 404);
});

test("old quiz and survey invitation aliases remain browser-bound, cannot be hijacked and are cleared on cloning", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  for (const kind of ["quiz", "survey"]) {
    const forms = kind === "quiz" ? "quizzes" : "surveys";
    let form = kind === "quiz" ? await quizFor(admin) : await surveyFor(admin);
    const other = kind === "quiz" ? await quizFor(admin) : await surveyFor(admin);
    const initialSlug = form.slug, path = `/api/admin/${forms}/${form.id}`, participant = browser();
    const started = kind === "quiz" ? await startQuiz(participant, form, "Старая ссылка") : await startSurvey(participant, form);
    const firstSlug = `${initialSlug}-first`, finalSlug = `${initialSlug}-final`;
    const revision = form.contentRevision;
    for (const slug of [firstSlug, finalSlug]) form = await ok(admin, path, "PUT", { ...form, slug, slugAliases: ["forged-alias-that-was-never-owned"] });
    assert.equal(form.contentRevision, revision);
    assert.deepEqual([...form.slugAliases].sort(), [initialSlug, firstSlug].sort());
    assert.equal(form.slugAliases.includes("forged-alias-that-was-never-owned"), false);
    for (const slug of [initialSlug, firstSlug, finalSlug]) {
      const continued = await ok(participant, `/api/public/${forms}/${slug}`);
      assert.equal(continued.id, form.id);
      assert.equal((continued.attempt || continued.response).id, started.id);
      const resumed = await ok(participant, `/api/public/${forms}/${slug}/start`, "POST", kind === "quiz" ? { name: "Старая ссылка" } : {});
      assert.equal(resumed.id, started.id);
    }
    assert.equal((await browser().request(`/api/public/${forms}/forged-alias-that-was-never-owned`)).status, 404);
    for (const slug of [initialSlug, firstSlug, finalSlug]) assert.equal((await admin.request(`/api/admin/${forms}/${other.id}`, { method: "PUT", body: { ...other, slug } })).status, 409, `A ${kind} cannot claim another form's current or earlier invitation`);
    assert.equal((await admin.request(path, { method: "PUT", body: { ...form, slug: other.slug } })).status, 409);
    form = await ok(admin, path, "PUT", { ...form, slug: initialSlug, slugAliases: [] });
    assert.ok(form.slugAliases.includes(finalSlug), "Returning to an owned alias preserves the previous current invitation");
    assert.equal(form.slugAliases.includes(initialSlug), false, "A current link is not duplicated among its aliases");
    const clone = await ok(admin, `${path}/clone`, "POST", {}, 201);
    assert.deepEqual(clone.slugAliases, []);
    assert.notEqual(clone.slug, form.slug);
    assert.equal((await ok(participant, `/api/public/${forms}/${firstSlug}`)).id, form.id);
  }
});

test("survey Excel exports retain removed question variants and resolve old response text using its own content revision", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let survey = await surveyFor(admin, { questions: [
    { id: "same", type: "short", text: "SURVEY_QUESTION_PREVIOUS_REVISION", required: true },
    { id: "removed", type: "single", text: "SURVEY_REMOVED_CHOICE", options: [{ id: "a", text: "SURVEY_PREVIOUS_OPTION_ALPHA" }, { id: "b", text: "SURVEY_PREVIOUS_OPTION_BETA" }] },
  ] });
  const student = browser(), response = await startSurvey(student, survey);
  await ok(student, `${responsePath(response)}/submit`, "POST", { answers: { same: "PRIVATE_SURVEY_RESPONSE_PREVIOUS", removed: "a" } });
  survey = await ok(admin, surveyPath(survey), "PUT", { ...survey, questions: [
    { id: "same", type: "number", text: "SURVEY_QUESTION_CURRENT_REVISION", required: true, min: 0, max: 100, step: 1 },
    { id: "new", type: "short", text: "SURVEY_ADDED_QUESTION", required: true },
  ] });
  const nextStudent = browser(), next = await startSurvey(nextStudent, survey);
  await ok(nextStudent, `${responsePath(next)}/submit`, "POST", { answers: { same: 0, new: "PRIVATE_SURVEY_RESPONSE_CURRENT" } });
  for (const variant of ["public", "private"]) {
    const result = await admin.request(`${surveyPath(survey)}/export.xlsx?variant=${variant}`);
    assert.equal(result.status, 200);
    const zip = await JSZip.loadAsync(result.data);
    const xml = (await Promise.all(Object.values(zip.files).filter((file) => !file.dir && file.name.endsWith(".xml")).map((file) => file.async("string")))).join("\n");
    for (const value of ["SURVEY_QUESTION_PREVIOUS_REVISION", "SURVEY_PREVIOUS_OPTION_ALPHA", "SURVEY_PREVIOUS_OPTION_BETA", "SURVEY_QUESTION_CURRENT_REVISION"]) assert.ok(xml.includes(value), `${variant} lost ${value}`);
    for (const value of ["PRIVATE_SURVEY_RESPONSE_PREVIOUS", "PRIVATE_SURVEY_RESPONSE_CURRENT"]) assert.equal(xml.includes(value), variant === "private", `${variant}: ${value}`);
  }
});
