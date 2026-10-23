import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { fixture, quizFor, questionSet, assertNoSecrets } from "./helpers.js";
import { surveyFor, surveyAnswers } from "./survey-helpers.js";

function newTypes() {
  const boolean = { id: randomUUID(), type: "truefalse", text: "Проверка утверждения", points: 2, options: [{ id: "true", text: "Верно" }, { id: "false", text: "Неверно" }], correct: ["true"] };
  const numeric = { id: randomUUID(), type: "number", text: "Числовое значение", points: 3, correct: 0, tolerance: 0.01 };
  const ordering = { id: randomUUID(), type: "ordering", text: "Расположите по порядку", points: 4, options: [{ id: randomUUID(), text: "Первый" }, { id: randomUUID(), text: "Второй" }, { id: randomUUID(), text: "Третий" }] };
  ordering.correct = ordering.options.map((option) => option.id);
  return [boolean, numeric, ordering];
}

test("new quiz types validate author input and keep numeric keys, tolerance and correct ordering private", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const questions = newTypes();
  const quiz = await quizFor(admin, { questions });
  const student = browser();
  const started = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Новые типы" } });
  assert.equal(started.status, 201);
  assertNoSecrets(started.data);
  const publicNumber = started.data.questions.find((question) => question.type === "number");
  assert.equal(publicNumber.tolerance, undefined);
  assert.equal(publicNumber.correct, undefined);
  assert.equal(started.data.questions.find((question) => question.type === "ordering").options.length, 3);
  const draft = await quizFor(admin, { status: "draft", questions });
  const invalidQuestions = [
    { ...questions[0], options: questions[0].options.map((option) => ({ ...option, id: randomUUID() })) },
    { ...questions[0], correct: ["true", "false"] },
    { ...questions[1], correct: "0" }, { ...questions[1], correct: null },
    { ...questions[1], tolerance: -1 }, { ...questions[1], tolerance: "0.1" },
    { ...questions[2], correct: questions[2].correct.slice(0, 2) },
    { ...questions[2], correct: [questions[2].correct[0], questions[2].correct[0], questions[2].correct[2]] },
  ];
  for (const question of invalidQuestions) {
    const response = await admin.request(`/api/admin/quizzes/${draft.id}`, { method: "PUT", body: { ...draft, questions: [question] } });
    assert.equal(response.status, 400, JSON.stringify(question));
  }
});

test("truefalse and tolerance grading work server-side while ordering requires every item in its correct position", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { questions: newTypes() });
  const [boolean, numeric, ordering] = quiz.questions;
  for (const [index, answer] of [
    { numeric: "0.01", order: ordering.correct, score: 9 },
    { numeric: "-0,01", order: ordering.correct, score: 9 },
    { numeric: 0.0101, order: ordering.correct, score: 6 },
    { numeric: "0e2", order: [...ordering.correct].reverse(), score: 5 },
    { numeric: "", order: ordering.correct.slice(0, 2), score: 2 },
  ].entries()) {
    const student = browser();
    const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: `Оценка новых типов ${index}` } });
    const final = await student.request(`/api/public/attempts/${start.data.id}/submit`, { method: "POST", body: { answers: {
      [boolean.id]: "true", [numeric.id]: answer.numeric, [ordering.id]: answer.order,
    }, score: 100000 } });
    assert.equal(final.status, 200, JSON.stringify(final.data));
    assert.equal(final.data.score, answer.score);
    assert.equal(final.data.maxScore, 9);
    assert.equal(final.data.review, undefined);
  }
});

test("immediate numeric checks canonicalize zero and numeric strings, and checked ordering cannot be reordered", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { questions: newTypes(), settings: { feedbackMode: "immediate" } });
  const [boolean, numeric, ordering] = quiz.questions;
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Блокировка новых типов" } });
  const path = `/api/public/attempts/${start.data.id}`;
  for (const invalid of [null, true, "NaN", "Infinity", "0x10", "1 000", {}, []]) {
    const response = await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [numeric.id]: invalid } } });
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  const zero = await student.request(`${path}/check`, { method: "POST", body: { questionId: numeric.id, answer: "0" } });
  assert.equal(zero.status, 200);
  assert.equal(zero.data.answers[numeric.id], 0);
  assert.equal(zero.data.feedback[numeric.id].correct, true);
  for (const same of [0, "0.00", "-0", "+0e6", "0,0"]) {
    assert.equal((await student.request(`${path}/check`, { method: "POST", body: { questionId: numeric.id, answer: same } })).status, 200);
    assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [numeric.id]: same } } })).status, 200);
  }
  assert.equal((await student.request(`${path}/check`, { method: "POST", body: { questionId: numeric.id, answer: 0.001 } })).status, 409, "A different value cannot replace a checked answer, even inside grading tolerance");
  assert.equal((await student.request(`${path}/check`, { method: "POST", body: { questionId: ordering.id, answer: ordering.correct } })).status, 200);
  for (const endpoint of ["answers", "submit"]) {
    const response = await student.request(`${path}/${endpoint}`, { method: endpoint === "answers" ? "PUT" : "POST", body: { answers: { [ordering.id]: [...ordering.correct].reverse() } } });
    assert.equal(response.status, 409);
  }
  assert.equal((await student.request(`${path}/check`, { method: "POST", body: { questionId: boolean.id, answer: "true" } })).status, 200);
  assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [boolean.id]: "false" } } })).status, 409);
  const final = await student.request(`${path}/submit`, { method: "POST", body: {} });
  assert.equal(final.data.score, 9);
  assert.equal(final.data.review, undefined);
  assert.equal(final.data.feedback, undefined);
});

test("cloning new quiz types preserves semantic truefalse IDs and remaps ordering keys consistently", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { questions: newTypes() });
  const cloned = await admin.request(`/api/admin/quizzes/${quiz.id}/clone`, { method: "POST" });
  assert.equal(cloned.status, 201);
  const [boolean, numeric, ordering] = cloned.data.questions;
  assert.deepEqual(boolean.options.map((option) => option.id).sort(), ["false", "true"]);
  assert.deepEqual(boolean.correct, ["true"]);
  assert.equal(numeric.correct, 0);
  assert.equal(numeric.tolerance, 0.01);
  assert.ok(ordering.options.every((option) => !quiz.questions[2].options.some((original) => original.id === option.id)));
  assert.deepEqual(ordering.correct.map((id) => ordering.options.find((option) => option.id === id).text), ["Первый", "Второй", "Третий"]);
  const published = await admin.request(`/api/admin/quizzes/${cloned.data.id}`, { method: "PUT", body: { ...cloned.data, status: "published" } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const student = browser();
  const started = await student.request(`/api/public/quizzes/${cloned.data.slug}/start`, { method: "POST", body: { name: "Клонированные типы" } });
  const final = await student.request(`/api/public/attempts/${started.data.id}/submit`, { method: "POST", body: { answers: { [boolean.id]: "true", [numeric.id]: 0, [ordering.id]: ordering.correct } } });
  assert.equal(final.data.score, 9);
});

test("zero numeric tolerance is exact even at large magnitudes and positive tolerance cannot inflate with floating precision", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  for (const tolerance of [0, 0.1]) {
    const question = { ...newTypes()[1], correct: 1e15, tolerance };
    const quiz = await quizFor(admin, { questions: [question] });
    for (const [index, value] of [1e15, 1e15 - 0.5, 1e15 - 0.125].entries()) {
      const student = browser();
      const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: `Точная погрешность ${tolerance} ${index}` } });
      const final = await student.request(`/api/public/attempts/${start.data.id}/submit`, { method: "POST", body: { answers: { [question.id]: value } } });
      assert.equal(final.status, 200);
      assert.equal(final.data.score, index === 0 ? 3 : 0, `${value} was graded incorrectly for tolerance ${tolerance}`);
    }
  }
});

async function workbookArtifact(response) {
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.match(response.headers.get("content-type"), /spreadsheetml/);
  const zip = await JSZip.loadAsync(response.data);
  // Scan every ZIP entry, including hidden sheets, chart caches, relationships and document properties.
  const xml = (await Promise.all(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.async("string")))).join("\n");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.data);
  return { zip, xml, workbook };
}

function assertStyledCharts(artifact) {
  const summary = artifact.workbook.getWorksheet("Summary");
  const attempts = artifact.workbook.getWorksheet("Attempts");
  assert.equal(summary.getCell("A1").font.bold, true);
  assert.equal(summary.getCell("A1").fill.type, "pattern");
  assert.equal(summary.pageSetup.orientation, "landscape");
  assert.equal(attempts.views[0].state, "frozen");
  assert.equal(attempts.views[0].ySplit, 1);
  assert.ok(attempts.autoFilter);
  assert.equal(attempts.getCell("A1").font.bold, true);
  assert.ok(artifact.zip.file("xl/charts/chart1.xml"));
  assert.ok(artifact.zip.file("xl/charts/chart2.xml"));
  assert.match(artifact.xml, /doughnutChart/);
  assert.match(artifact.xml, /barChart/);
  assert.ok(artifact.zip.file("xl/drawings/_rels/drawing1.xml.rels"));
}

test("quiz public XLSX omits all answers, keys, metadata and history across the ZIP while private export includes them", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const questions = questionSet();
  const short = questions.find((q) => q.type === "short");
  short.correct = "PRIVATE_CORRECT_KEY_SENTINEL";
  const quiz = await quizFor(admin, { questions, settings: { antiCheat: true, maxWarnings: 1 } });
  const student = browser();
  const headers = { "CF-Connecting-IP": "203.0.113.240", "User-Agent": "PRIVATE_USER_AGENT_SENTINEL" };
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", headers, body: { name: "=PUBLIC_NAME_SENTINEL()", rulesAccepted: true } });
  const oldPath = `/api/public/attempts/${start.data.id}`;
  await student.request(`${oldPath}/answers`, { method: "PUT", body: { answers: { [short.id]: "PRIVATE_HISTORY_ANSWER_SENTINEL" } } });
  await student.request(`${oldPath}/events`, { method: "POST", body: { type: "visibility", eventId: randomUUID() } });
  assert.equal((await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}/retake`, { method: "POST", body: {} })).status, 200);
  const restarted = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", headers, body: { rulesAccepted: true } });
  assert.equal(restarted.status, 201);
  const answers = {
    [short.id]: "PRIVATE_STUDENT_ANSWER_SENTINEL",
    [questions[0].id]: questions[0].correct[0],
  };
  await student.request(`/api/public/attempts/${restarted.data.id}/submit`, { method: "POST", body: { answers } });
  app.locals.db.prepare("INSERT INTO events(attempt_id,event_id,type,created_at,counted,metadata) VALUES(?,?,?,?,0,?)")
    .run(restarted.data.id, randomUUID(), "presence", new Date().toISOString(), JSON.stringify({ privateData: "PRIVATE_EVENT_METADATA_SENTINEL", language: "ru" }));
  const path = `/api/admin/quizzes/${quiz.id}/export.xlsx`;
  assert.equal((await browser().request(path)).status, 401);
  assert.equal((await admin.request(`${path}?variant=invalid`)).status, 400);
  const publicArtifact = await workbookArtifact(await admin.request(path));
  assertStyledCharts(publicArtifact);
  assert.equal(publicArtifact.workbook.getWorksheet("Answers"), undefined);
  assert.equal(publicArtifact.workbook.getWorksheet("AttemptHistory"), undefined);
  for (const secret of ["PRIVATE_STUDENT_ANSWER_SENTINEL", "PRIVATE_CORRECT_KEY_SENTINEL", "PRIVATE_HISTORY_ANSWER_SENTINEL", "PRIVATE_USER_AGENT_SENTINEL", "PRIVATE_EVENT_METADATA_SENTINEL"]) assert.ok(!publicArtifact.xml.includes(secret), `Public XLSX leaked ${secret}`);
  for (const included of [restarted.data.id, "PUBLIC_NAME_SENTINEL", "203.0.113.240", short.text, questions[0].options[0].text, "Правила приняты"]) assert.ok(publicArtifact.xml.includes(included), `Public XLSX lost ${included}`);
  const attemptSheet = publicArtifact.workbook.getWorksheet("Attempts");
  assert.equal(attemptSheet.getCell("B2").value, "=PUBLIC_NAME_SENTINEL()");
  assert.equal(attemptSheet.getCell("B2").type, ExcelJS.ValueType.String);
  assert.equal(attemptSheet.getCell("K2").value, 2);
  assert.equal(attemptSheet.getCell("L2").value, 10);
  assert.equal(attemptSheet.getCell("M2").value, 20);
  const privateArtifact = await workbookArtifact(await admin.request(`${path}?variant=private`));
  assertStyledCharts(privateArtifact);
  for (const secret of ["PRIVATE_STUDENT_ANSWER_SENTINEL", "PRIVATE_CORRECT_KEY_SENTINEL", "PRIVATE_HISTORY_ANSWER_SENTINEL", "PRIVATE_USER_AGENT_SENTINEL", "PRIVATE_EVENT_METADATA_SENTINEL"]) assert.ok(privateArtifact.xml.includes(secret), `Private XLSX lost ${secret}`);
  assert.ok(privateArtifact.workbook.getWorksheet("Answers"));
  assert.ok(privateArtifact.workbook.getWorksheet("AttemptHistory"));
  assert.equal(privateArtifact.workbook.getWorksheet("Attempts").getCell("B2").type, ExcelJS.ValueType.String);
});

test("survey public XLSX excludes response text and answer aggregates while private export retains responses, metadata and event details", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const survey = await surveyFor(admin, { settings: { anonymous: false, collectName: true, collectIp: true, collectUserAgent: true } });
  const student = browser();
  const start = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: { name: "SURVEY_PUBLIC_NAME_SENTINEL" }, headers: { "CF-Connecting-IP": "203.0.113.241", "User-Agent": "SURVEY_PRIVATE_UA_SENTINEL" } });
  assert.equal(start.status, 201);
  const path = `/api/public/responses/${start.data.id}`;
  await student.request(`${path}/answers`, { method: "PUT", body: { answers: surveyAnswers(survey, "SURVEY_PRIVATE_ANSWER_SENTINEL") } });
  await student.request(`${path}/submit`, { method: "POST", body: {} });
  app.locals.db.prepare("INSERT INTO survey_events(response_id,type,created_at,metadata) VALUES(?,?,?,?)")
    .run(start.data.id, "presence", new Date().toISOString(), JSON.stringify({ privateData: "SURVEY_PRIVATE_EVENT_SENTINEL" }));
  const exportPath = `/api/admin/surveys/${survey.id}/export.xlsx`;
  assert.equal((await browser().request(exportPath)).status, 401);
  assert.equal((await admin.request(`${exportPath}?variant=invalid`)).status, 400);
  const publicArtifact = await workbookArtifact(await admin.request(exportPath));
  assertStyledCharts(publicArtifact);
  assert.equal(publicArtifact.workbook.getWorksheet("Questions").getRow(1).values.includes("Статистика ответов"), false);
  assert.equal(publicArtifact.workbook.getWorksheet("Answers"), undefined);
  for (const secret of ["SURVEY_PRIVATE_ANSWER_SENTINEL", "SURVEY_PRIVATE_UA_SENTINEL", "SURVEY_PRIVATE_EVENT_SENTINEL", "average", "distribution"]) assert.ok(!publicArtifact.xml.includes(secret), `Public survey XLSX leaked ${secret}`);
  for (const included of [start.data.id, "SURVEY_PUBLIC_NAME_SENTINEL", "203.0.113.241", survey.questions[0].text, survey.questions[2].options[0].text, "Ответы сохранены"]) assert.ok(publicArtifact.xml.includes(included), `Public survey XLSX lost ${included}`);
  const privateArtifact = await workbookArtifact(await admin.request(`${exportPath}?variant=private`));
  assertStyledCharts(privateArtifact);
  for (const secret of ["SURVEY_PRIVATE_ANSWER_SENTINEL", "SURVEY_PRIVATE_UA_SENTINEL", "SURVEY_PRIVATE_EVENT_SENTINEL"]) assert.ok(privateArtifact.xml.includes(secret), `Private survey XLSX lost ${secret}`);
  const privateQuestions = privateArtifact.workbook.getWorksheet("Questions");
  const numericRow = privateQuestions.getRows(2, privateQuestions.rowCount - 1).find((row) => row.getCell(1).value === survey.questions.find((q) => q.type === "number").id);
  const aggregate = JSON.parse(numericRow.getCell(7).value);
  assert.equal(aggregate.average, 0);
  assert.deepEqual(aggregate.distribution, [{ value: 0, count: 1 }]);
  assert.ok(privateArtifact.workbook.getWorksheet("Answers"));
  const list = privateArtifact.workbook.getWorksheet("Attempts");
  assert.equal(list.getCell("B2").value, "SURVEY_PUBLIC_NAME_SENTINEL");
});

test("XLSX detail sheets preserve large survey option sets and every selected or matched quiz element beyond a 32K overview", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const text = (prefix, index) => `${"x".repeat(1950)}${prefix}_${String(index).padStart(3, "0")}_TAIL`;
  const surveyQuestion = {
    id: randomUUID(), type: "single", text: "Сто длинных вариантов", required: false,
    options: Array.from({ length: 100 }, (_, index) => ({ id: `option_${String(index).padStart(3, "0")}`, text: text("SURVEY_OPTION", index) })),
  };
  const survey = await surveyFor(admin, { questions: [surveyQuestion] });
  for (const variant of ["public", "private"]) {
    const artifact = await workbookArtifact(await admin.request(`/api/admin/surveys/${survey.id}/export.xlsx?variant=${variant}`));
    const overview = artifact.workbook.getWorksheet("Questions").getCell("D2").value;
    assert.ok(overview.length <= 32000);
    assert.ok(!overview.includes("SURVEY_OPTION_099_TAIL"), "Fixture must exercise content beyond the overview cell limit");
    const options = artifact.workbook.getWorksheet("Options");
    assert.equal(options.rowCount, 101);
    for (const [index, option] of surveyQuestion.options.entries()) {
      assert.equal(options.getCell(index + 2, 4).value, option.id);
      assert.equal(options.getCell(index + 2, 5).value, option.text);
    }
    assert.equal(options.getCell("E101").value.endsWith("SURVEY_OPTION_099_TAIL"), true);
  }
  const multiple = {
    id: randomUUID(), type: "multiple", text: "Двадцать длинных выбранных вариантов", points: 2,
    options: Array.from({ length: 20 }, (_, index) => ({ id: `choice_${String(index).padStart(3, "0")}`, text: text("QUIZ_OPTION", index) })),
  };
  multiple.correct = multiple.options.map((option) => option.id);
  const matching = {
    id: randomUUID(), type: "matching", text: "Двадцать длинных соответствий", points: 3,
    pairs: Array.from({ length: 20 }, (_, index) => ({ id: `pair_${String(index).padStart(3, "0")}`, left: text("MATCH_LEFT", index), right: text("MATCH_RIGHT", index) })),
  };
  const quiz = await quizFor(admin, { questions: [multiple, matching] });
  const student = browser();
  const started = await student.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Длинные варианты" } });
  assert.equal(started.status, 201);
  const submitted = await student.request(`/api/public/attempts/${started.data.id}/submit`, { method: "POST", body: { answers: {
    [multiple.id]: multiple.correct,
    [matching.id]: Object.fromEntries(matching.pairs.map((pair) => [pair.id, pair.right])),
  } } });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.score, 5);
  const publicArtifact = await workbookArtifact(await admin.request(`/api/admin/quizzes/${quiz.id}/export.xlsx?variant=public`));
  const publicOptions = publicArtifact.workbook.getWorksheet("Options");
  assert.equal(publicOptions.rowCount, 61);
  assert.deepEqual(publicOptions.getRow(1).values.slice(1), ["ID вопроса", "Вопрос", "Набор", "ID элемента", "Текст элемента", "Версия вопросов"], "Public options may include revision metadata, never a key or correct position column");
  const publicMatching = publicOptions.getRows(2, publicOptions.rowCount - 1).filter((row) => row.getCell(1).value === matching.id);
  assert.equal(publicMatching.filter((row) => row.getCell(3).value === "Слева").length, 20);
  const rightRows = publicMatching.filter((row) => row.getCell(3).value === "Варианты справа");
  assert.equal(rightRows.length, 20);
  assert.ok(rightRows.every((row) => !row.getCell(4).value), "Public right-side variants cannot disclose their matching pair ID");
  assert.equal(publicArtifact.workbook.getWorksheet("AnswerDetails"), undefined);
  const artifact = await workbookArtifact(await admin.request(`/api/admin/quizzes/${quiz.id}/export.xlsx?variant=private`));
  const options = artifact.workbook.getWorksheet("Options");
  assert.equal(options.rowCount, 41);
  const details = artifact.workbook.getWorksheet("AnswerDetails");
  assert.equal(details.rowCount, 41);
  const detailRows = details.getRows(2, details.rowCount - 1);
  for (const [index, option] of multiple.options.entries()) {
    const row = detailRows.find((entry) => entry.getCell(3).value === multiple.id && entry.getCell(4).value === String(index + 1));
    assert.ok(row, `Selected option ${index + 1} is missing`);
    assert.equal(row.getCell(5).value, option.text);
    assert.equal(JSON.parse(row.getCell(6).value), option.id);
  }
  for (const pair of matching.pairs) {
    const row = detailRows.find((entry) => entry.getCell(3).value === matching.id && entry.getCell(4).value === pair.id);
    assert.ok(row, `Matching pair ${pair.id} is missing`);
    assert.equal(row.getCell(5).value, `${pair.left}: ${pair.right}`);
    assert.equal(JSON.parse(row.getCell(6).value), pair.right);
  }
  assert.ok(artifact.xml.includes("QUIZ_OPTION_019_TAIL"));
  assert.ok(artifact.xml.includes("MATCH_RIGHT_019_TAIL"));
});
