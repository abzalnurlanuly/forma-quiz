import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../server/db.js";
import { fixture, quizFor, correctAnswers } from "./helpers.js";

import { surveyFor, surveyAnswers } from "./survey-helpers.js";

function assertPrivateTechnicalFieldsAbsent(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["access_hash", "browser_key", "ip_key", "user_agent", "snapshot", "collection", "userAgent", "ip"].includes(key), `Public response leaked ${key}`);
    assertPrivateTechnicalFieldsAbsent(child);
  }
}

test("survey administration enforces authentication, CSRF, publication, unique slugs and validated theme/media", async (t) => {
  const { administrator, browser } = await fixture(t);
  const anonymous = browser();
  assert.equal((await anonymous.request("/api/admin/surveys")).status, 401);
  assert.equal((await anonymous.request("/api/admin/surveys", { method: "POST", body: {} })).status, 401);
  const admin = await administrator();
  assert.equal((await admin.request("/api/admin/surveys", { method: "POST", body: {}, csrf: false })).status, 403);
  const draft = await surveyFor(admin, { status: "draft" });
  const path = `/api/admin/surveys/${draft.id}`;
  assert.equal((await anonymous.request(`/api/public/surveys/${draft.slug}`)).status, 404);
  assert.equal((await anonymous.request(`/api/public/surveys/${draft.slug}/start`, { method: "POST", body: {} })).status, 403);
  for (const change of [
    { slug: "UPPER CASE" }, { status: "visible" }, { title: "" }, { settings: { anonymous: "true" } },
    { settings: { deadline: "not-a-date" } }, { theme: { font: "remote-font" } },
    { theme: { layout: "invalid" } }, { theme: { accentColor: "red" } },
    { theme: { backgroundColor: "url(https://invalid.example/x)" } },
    { theme: { logo: "/uploads/../../secret.png" } },
    { theme: { cover: `/uploads/${randomUUID()}.png` } },
    { questions: [{ id: randomUUID(), type: "short", text: "" }] },
    { questions: [{ id: randomUUID(), type: "unknown", text: "Неверный тип" }] },
    { questions: [{ id: randomUUID(), type: "number", text: "Нулевой шаг", step: 0 }] },
    { questions: [{ id: randomUUID(), type: "number", text: "Обратные границы", min: 10, max: 0 }] },
    { questions: [{ id: randomUUID(), type: "rating", text: "Дробная шкала", min: 0.5, max: 5 }] },
    { questions: [{ id: randomUUID(), type: "scale", text: "Слишком большая шкала", min: 0, max: 101 }] },
  ]) assert.equal((await admin.request(path, { method: "PUT", body: { ...draft, ...change } })).status, 400, JSON.stringify(change));
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kF9sAAAAASUVORK5CYII=";
  const uploaded = await admin.request("/api/admin/uploads", { method: "POST", body: { data: png } });
  assert.equal(uploaded.status, 201);
  const published = await admin.request(path, { method: "PUT", body: {
    ...draft, status: "published", theme: { ...draft.theme, logo: uploaded.data.url, cover: uploaded.data.url, font: "serif", layout: "wide", accentColor: "#ABCDEF" },
    questions: draft.questions.map((q, index) => index ? q : { ...q, image: uploaded.data.url }),
  } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.theme.accentColor, "#abcdef");
  const publicSurvey = await anonymous.request(`/api/public/surveys/${draft.slug}`);
  assert.equal(publicSurvey.data.theme.logo, uploaded.data.url);
  assert.equal(publicSurvey.data.questions[0].image, uploaded.data.url);
  assert.equal((await admin.request(path, { method: "DELETE" })).status, 409);
  const other = await surveyFor(admin);
  assert.equal((await admin.request(`/api/admin/surveys/${other.id}`, { method: "PUT", body: { ...other, slug: draft.slug } })).status, 409);
  const clone = await admin.request(`${path}/clone`, { method: "POST" });
  assert.equal(clone.status, 201);
  assert.equal(clone.data.status, "draft");
  assert.notEqual(clone.data.slug, draft.slug);
  assert.equal(clone.data.responseCount, 0);
  assert.ok(clone.data.questions.every((q, index) => q.id !== published.data.questions[index].id));
  assert.ok(clone.data.questions.filter((q) => q.options.length).every((q) => !published.data.questions.flatMap((p) => p.options.map((o) => o.id)).includes(q.options[0].id)));
  assert.equal((await admin.request(`/api/admin/surveys/${clone.data.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await admin.request(`/api/admin/surveys/${clone.data.id}`)).status, 404);
});

test("all ten survey question types validate drafts, required answers, numeric zero, steps and real dates", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin);
  assert.equal(survey.questions.length, 10);
  assert.equal(survey.questions.find((q) => q.type === "content").required, false);
  const student = browser();
  const start = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
  assert.equal(start.status, 201);
  const path = `/api/public/responses/${start.data.id}`;
  assert.equal((await student.request(`${path}/submit`, { method: "POST", body: {} })).status, 400);
  const answers = surveyAnswers(survey);
  for (const q of survey.questions.filter((q) => q.type !== "content")) {
    const incomplete = { ...answers };
    delete incomplete[q.id];
    const response = await student.request(`${path}/submit`, { method: "POST", body: { answers: incomplete } });
    assert.equal(response.status, 400, `Required ${q.type} was skipped`);
  }
  const byType = (type) => survey.questions.find((q) => q.type === type);
  for (const [questionId, value] of [
    [randomUUID(), "injected"], [byType("content").id, "not an answer"],
    [byType("short").id, "x".repeat(2001)], [byType("long").id, "x".repeat(12001)],
    [byType("short").id, {}], [byType("single").id, "missing-option"], [byType("dropdown").id, [byType("dropdown").options[0].id]],
    [byType("multiple").id, [byType("multiple").options[0].id, byType("multiple").options[0].id]],
    [byType("rating").id, 0], [byType("rating").id, 5.5], [byType("scale").id, 3],
    [byType("number").id, -1.5], [byType("number").id, 0.25], [byType("number").id, "0"],
    [byType("date").id, "2025-02-29"], [byType("date").id, "2024-02-30"], [byType("date").id, "23/10/2026"],
  ]) assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [questionId]: value } } })).status, 400, `${questionId}: ${JSON.stringify(value)}`);
  const partial = await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [byType("number").id]: 0 } } });
  assert.equal(partial.status, 200);
  assert.equal(partial.data.answers[byType("number").id], 0);
  const submitted = await student.request(`${path}/submit`, { method: "POST", body: { answers } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.status, "submitted");
  assert.equal(submitted.data.presence.answeredCount, 9);
  assert.equal(submitted.data.presence.totalQuestions, 9);
  assert.equal(submitted.data.score, undefined);
  assert.equal(submitted.data.review, undefined);
  assert.deepEqual(submitted.data.answers, answers);
});

test("survey drafts resume with their access cookie, merge autosaves, stay private and become immutable on completion", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin);
  const student = browser();
  const startPath = `/api/public/surveys/${survey.slug}/start`;
  const start = await student.request(startPath, { method: "POST", body: {} });
  const path = `/api/public/responses/${start.data.id}`;
  const answers = surveyAnswers(survey);
  const [first, second] = Object.entries(answers);
  for (const entry of [first, second]) assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers: Object.fromEntries([entry]) } })).status, 200);
  const resumed = await student.request(startPath, { method: "POST", body: {} });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.id, start.data.id);
  assert.deepEqual(resumed.data.answers, Object.fromEntries([first, second]));
  assert.equal((await student.request(`/api/public/surveys/${survey.slug}`)).data.response.id, start.data.id);
  const stranger = browser();
  assert.equal((await stranger.request(`/api/public/surveys/${survey.slug}`)).data.response, null);
  for (const [suffix, method, body] of [["", "GET"], ["/answers", "PUT", { answers }], ["/submit", "POST", { answers }], ["/presence", "POST", { visibility: "visible", focused: true }]])
    assert.equal((await stranger.request(path + suffix, { method, body })).status, 404);
  assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers }, csrf: false })).status, 403);
  const final = await student.request(`${path}/submit`, { method: "POST", body: { answers } });
  assert.equal(final.status, 200);
  assertPrivateTechnicalFieldsAbsent(final.data);
  assert.equal((await student.request(`${path}/answers`, { method: "PUT", body: { answers: { [first[0]]: "changed" } } })).status, 409);
  const again = await student.request(`${path}/submit`, { method: "POST", body: { answers: {} } });
  assert.deepEqual(again.data, final.data);
  assertPrivateTechnicalFieldsAbsent((await student.request(path)).data);
  const another = await stranger.request(startPath, { method: "POST", body: {} });
  assert.equal(another.status, 201);
  assert.deepEqual(another.data.answers, {});
});

test("survey content and links remain editable while closure permits active submission and deadlines expire saved drafts", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let survey = await surveyFor(admin);
  const student = browser();
  const start = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
  const path = `/api/public/responses/${start.data.id}`;
  for (const change of [{ slug: `${survey.slug}-changed` }, { questions: survey.questions.map((q, i) => i ? q : { ...q, text: "Изменённый вопрос" }) }]) {
    const edited = await admin.request(`/api/admin/surveys/${survey.id}`, { method: "PUT", body: { ...survey, ...change } });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    survey = edited.data;
  }
  let saved = await admin.request(`/api/admin/surveys/${survey.id}`, { method: "PUT", body: { ...survey, status: "closed" } });
  assert.equal(saved.status, 200);
  survey = saved.data;
  assert.equal((await browser().request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} })).status, 403);
  assert.equal((await student.request(`${path}/submit`, { method: "POST", body: { answers: surveyAnswers(survey) } })).data.status, "submitted");
  const timed = await surveyFor(admin, { settings: { deadline: new Date(Date.now() + 600000).toISOString() } });
  const timedStudent = browser();
  const timedStart = await timedStudent.request(`/api/public/surveys/${timed.slug}/start`, { method: "POST", body: {} });
  const timedPath = `/api/public/responses/${timedStart.data.id}`;
  const answer = { [timed.questions[0].id]: "Сохранённый черновик" };
  await timedStudent.request(`${timedPath}/answers`, { method: "PUT", body: { answers: answer } });
  app.locals.db.prepare("UPDATE survey_responses SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), timedStart.data.id);
  const expired = await timedStudent.request(`${timedPath}/submit`, { method: "POST", body: { answers: surveyAnswers(timed) } });
  assert.equal(expired.data.status, "expired");
  assert.deepEqual(expired.data.answers, answer);
  assert.equal((await timedStudent.request(`${timedPath}/answers`, { method: "PUT", body: { answers: {} } })).status, 409);
  saved = await admin.request(`/api/admin/surveys/${timed.id}`, { method: "PUT", body: { ...timed, settings: { ...timed.settings, deadline: new Date(Date.now() + 1200000).toISOString() } } });
  assert.equal(saved.status, 200);
  assert.equal((await timedStudent.request(timedPath)).data.status, "expired");
  const elapsed = await surveyFor(admin, { settings: { deadline: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await browser().request(`/api/public/surveys/${elapsed.slug}/start`, { method: "POST", body: {} })).status, 403);
});

test("anonymous survey defaults force collection off and store only opted-in technical duplicate digests", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  for (const restricted of [false, true]) {
    const survey = await surveyFor(admin, { settings: { anonymous: true, collectName: true, collectIp: true, collectUserAgent: true, oneResponsePerIp: restricted, oneResponsePerBrowser: restricted } });
    for (const field of ["collectName", "collectIp", "collectUserAgent"]) assert.equal(survey.settings[field], false);
    const student = browser();
    const started = await student.request(`/api/public/surveys/${survey.slug}/start`, {
      method: "POST", body: { name: "RAW_NAME_MUST_NOT_BE_STORED", consent: true },
      headers: { "CF-Connecting-IP": "203.0.113.201", "User-Agent": "RAW_UA_MUST_NOT_BE_STORED" },
    });
    assert.equal(started.status, 201);
    const row = app.locals.db.prepare("SELECT * FROM survey_responses WHERE id=?").get(started.data.id);
    for (const key of ["name", "ip", "user_agent"]) assert.equal(row[key], null);
    assert.equal(!!row.ip_key, restricted);
    assert.equal(!!row.browser_key, restricted);
    assert.match(row.access_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(row).includes("RAW_NAME_MUST_NOT_BE_STORED"));
    assert.ok(!JSON.stringify(row).includes("RAW_UA_MUST_NOT_BE_STORED"));
    assert.ok(!JSON.stringify(row).includes("203.0.113.201"));
    const collection = JSON.parse(row.collection);
    assert.deepEqual(Object.keys(collection).sort(), ["anonymous", "capturedAt", "collectIp", "collectName", "collectUserAgent"]);
    assert.equal(collection.anonymous, true);
    assert.equal(collection.capturedAt, row.started_at);
    assert.equal(collection.consent, undefined, "Collection policy is a capture manifest, not invented explicit consent");
    assert.equal(student.cookies.has("aq_browser"), restricted);
    assertPrivateTechnicalFieldsAbsent(started.data);
  }
});

test("survey metadata collection is explicit and disabling collection purges active and completed raw data permanently", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  let survey = await surveyFor(admin, { settings: { anonymous: false, collectName: true, collectIp: true, collectUserAgent: true } });
  const student = browser();
  assert.equal((await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} })).status, 400);
  const ids = [];
  for (const [index, client] of [student, browser()].entries()) {
    const start = await client.request(`/api/public/surveys/${survey.slug}/start`, {
      method: "POST", body: { name: `Имя ${index}` },
      headers: { "CF-Connecting-IP": `203.0.113.${210 + index}`, "User-Agent": `Survey-UA-${index}` },
    });
    assert.equal(start.status, 201);
    ids.push(start.data.id);
    if (index) await client.request(`/api/public/responses/${start.data.id}/submit`, { method: "POST", body: { answers: surveyAnswers(survey) } });
    const row = app.locals.db.prepare("SELECT * FROM survey_responses WHERE id=?").get(start.data.id);
    assert.equal(row.name, `Имя ${index}`);
    assert.equal(row.ip, `203.0.113.${210 + index}`);
    assert.equal(row.user_agent, `Survey-UA-${index}`);
    assert.equal(JSON.parse(row.collection).collectIp, true);
    assert.equal(JSON.parse(row.collection).consent, undefined);
  }
  const path = `/api/admin/surveys/${survey.id}`;
  for (const settings of [
    { ...survey.settings, collectName: false, collectIp: false, collectUserAgent: false },
    { ...survey.settings, collectName: true, collectIp: true, collectUserAgent: true },
    { ...survey.settings, anonymous: true },
  ]) {
    const saved = await admin.request(path, { method: "PUT", body: { ...survey, settings } });
    assert.equal(saved.status, 200);
    survey = saved.data;
    await student.request(`/api/public/responses/${ids[0]}/presence`, { method: "POST", body: { visibility: "visible", focused: true }, headers: { "CF-Connecting-IP": "203.0.113.255", "User-Agent": "No-Reconstruction" } });
    for (const id of ids) {
      const row = app.locals.db.prepare("SELECT * FROM survey_responses WHERE id=?").get(id);
      for (const key of ["name", "ip", "user_agent"]) assert.equal(row[key], null, `${key} was reconstructed`);
    }
    const report = (await admin.request(`${path}/report`)).data;
    assert.ok(report.responses.every((row) => row.name === null && row.ip === null && row.userAgent === null));
  }
});

test("survey IP and browser limits enforce canonical addresses and concurrent starts while unrestricted completed responses can repeat", async (t) => {
  const { administrator, browser } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const survey = await surveyFor(admin, { settings: { oneResponsePerIp: true } });
  for (const [index, ip] of ["203.0.113.202", "::ffff:203.0.113.202", "0000:0000:0000:0000:0000:ffff:cb00:71ca"].entries()) {
    const client = browser();
    const start = await client.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {}, headers: { "CF-Connecting-IP": ip } });
    assert.equal(start.status, index ? 409 : 201, JSON.stringify(start.data));
    if (!index) await client.request(`/api/public/responses/${start.data.id}/submit`, { method: "POST", body: { answers: surveyAnswers(survey) } });
  }
  const concurrent = await Promise.all(["2001:DB8:0:0::202", "2001:db8::202"].map((ip) => browser().request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {}, headers: { "CF-Connecting-IP": ip } })));
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await browser().request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} })).status, 400);
  const browserLimited = await surveyFor(admin, { settings: { oneResponsePerBrowser: true } });
  const student = browser();
  await student.request(`/api/public/surveys/${browserLimited.slug}`);
  const browserStart = await student.request(`/api/public/surveys/${browserLimited.slug}/start`, { method: "POST", body: {} });
  await student.request(`/api/public/responses/${browserStart.data.id}/submit`, { method: "POST", body: { answers: surveyAnswers(browserLimited) } });
  student.cookies.delete(`aq_survey_${browserLimited.id}`);
  assert.equal((await student.request(`/api/public/surveys/${browserLimited.slug}/start`, { method: "POST", body: {} })).status, 409);
  const unlimited = await surveyFor(admin);
  const repeater = browser();
  const ids = new Set();
  for (let index = 0; index < 3; index++) {
    const start = await repeater.request(`/api/public/surveys/${unlimited.slug}/start`, { method: "POST", body: {} });
    assert.equal(start.status, 201);
    ids.add(start.data.id);
    await repeater.request(`/api/public/responses/${start.data.id}/submit`, { method: "POST", body: { answers: surveyAnswers(unlimited) } });
  }
  assert.equal(ids.size, 3);
});

test("survey aggregates count only submitted answers and monitoring combines live forms without exposing answers", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin);
  const clients = [browser(), browser(), browser()];
  const starts = [];
  for (const [index, client] of clients.entries()) {
    const start = await client.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
    starts.push(start.data);
    const answers = surveyAnswers(survey, `SECRET_AGGREGATE_TEXT_${index}`);
    answers[survey.questions.find((q) => q.type === "number").id] = index === 1 ? 2 : 0;
    answers[survey.questions.find((q) => q.type === "single").id] = survey.questions.find((q) => q.type === "single").options[index === 1 ? 1 : 0].id;
    if (index < 2) await client.request(`/api/public/responses/${start.data.id}/submit`, { method: "POST", body: { answers } });
    else await client.request(`/api/public/responses/${start.data.id}/answers`, { method: "PUT", body: { answers } });
  }
  const report = (await admin.request(`/api/admin/surveys/${survey.id}/report`)).data;
  assert.equal(report.summary.submitted, 2);
  assert.equal(report.summary.active, 1);
  const numeric = report.questions.find((q) => q.type === "number").aggregates;
  assert.deepEqual(numeric, { answered: 2, skipped: 0, average: 1, min: 0, max: 2, distribution: [{ value: 0, count: 1 }, { value: 2, count: 1 }] });
  assert.deepEqual(report.questions.find((q) => q.type === "single").aggregates.options.map((o) => o.count), [1, 1]);
  const quiz = await quizFor(admin);
  const quizStudent = browser();
  const quizStart = await quizStudent.request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Участник квиза" } });
  await quizStudent.request(`/api/public/attempts/${quizStart.data.id}/answers`, { method: "PUT", body: { answers: correctAnswers(quiz) } });
  const presencePath = `/api/public/responses/${starts[2].id}/presence`;
  assert.equal((await browser().request(presencePath, { method: "POST", body: { visibility: "hidden", focused: false } })).status, 404);
  assert.equal((await clients[2].request(presencePath, { method: "POST", body: { visibility: "visible", focused: true, questionId: randomUUID() } })).status, 400);
  await clients[2].request(presencePath, { method: "POST", body: { visibility: "hidden", focused: true, questionId: survey.questions[0].id } });
  assert.equal((await browser().request("/api/admin/monitoring")).status, 401);
  assert.equal((await browser().request(`/api/admin/surveys/${survey.id}/report`)).status, 401);
  const monitor = (await admin.request("/api/admin/monitoring")).data;
  assert.equal(monitor.summary.active, 2);
  const liveSurvey = monitor.participants.find((row) => row.kind === "survey");
  assert.equal(liveSurvey.responseId, starts[2].id);
  assert.equal(liveSurvey.presence.status, "away");
  assert.equal(liveSurvey.presence.focused, false);
  assert.equal(liveSurvey.presence.answeredCount, 9);
  assert.ok(monitor.participants.some((row) => row.kind === "quiz" && row.attemptId === quizStart.data.id));
  for (const participant of monitor.participants) for (const field of ["answers", "questions", "snapshot", "answerKey", "userAgent", "ip"]) assert.equal(participant[field], undefined);
  assert.ok(!JSON.stringify(monitor).includes("SECRET_AGGREGATE_TEXT"));
  app.locals.db.prepare("UPDATE survey_responses SET last_seen_at=? WHERE id=?").run(new Date(Date.now() - 36000).toISOString(), starts[2].id);
  assert.equal((await admin.request("/api/admin/monitoring")).data.participants.find((row) => row.id === starts[2].id).presence.status, "offline");
});

test("survey changes broadcast authenticated live updates and scoped response deletion releases duplicate claims", async (t) => {
  const { administrator, browser } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const survey = await surveyFor(admin, { settings: { oneResponsePerIp: true, oneResponsePerBrowser: true } });
  const other = await surveyFor(admin);
  const stream = await admin.events("/api/admin/live");
  await stream.next("ready");
  const student = browser();
  const headers = { "CF-Connecting-IP": "2001:db8::203" };
  const start = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {}, headers });
  assert.equal(start.status, 201);
  const forSurvey = (data) => data.surveyId === survey.id;
  assert.deepEqual(await stream.next("update", forSurvey), { surveyId: survey.id });
  const path = `/api/public/responses/${start.data.id}`;
  await student.request(`${path}/answers`, { method: "PUT", body: { answers: surveyAnswers(survey) } });
  await stream.next("update", forSurvey);
  await student.request(`${path}/presence`, { method: "POST", body: { visibility: "visible", focused: true } });
  await stream.next("update", forSurvey);
  await student.request(`${path}/submit`, { method: "POST", body: {} });
  await stream.next("update", forSurvey);
  const report = (await admin.request(`/api/admin/surveys/${survey.id}/report`)).data;
  const journal = report.responses.find((row) => row.id === start.data.id).events;
  for (const type of ["start", "answers", "presence", "submitted"]) assert.ok(journal.some((event) => event.type === type), `Missing survey journal ${type}`);
  assert.ok(journal.every((event) => event.counted === 0));
  assert.ok(journal.every((event) => !Object.hasOwn(event.metadata, "answers")));
  const deletionPath = `/api/admin/surveys/${survey.id}/responses/${start.data.id}`;
  assert.equal((await browser().request(deletionPath, { method: "DELETE" })).status, 401);
  assert.equal((await admin.request(deletionPath, { method: "DELETE", csrf: false })).status, 403);
  assert.equal((await admin.request(`/api/admin/surveys/${other.id}/responses/${start.data.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await admin.request(deletionPath, { method: "DELETE" })).status, 200);
  await stream.next("update", forSurvey);
  assert.equal((await student.request(`${path}/submit`, { method: "POST", body: {} })).status, 404);
  const replacement = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {}, headers });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.data.id, start.data.id);
  stream.close();
});

test("an anonymous class behind one IP receives independent survey quotas and seeded concurrent starts resume one response", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin);
  for (let index = 0; index < 65; index++) {
    const client = browser();
    const invitation = await client.request(`/api/public/surveys/${survey.slug}`);
    assert.equal(invitation.status, 200);
    const start = await client.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
    assert.equal(start.status, 201, `Student ${index + 1}: ${JSON.stringify(start.data)}`);
  }
  const student = browser();
  await student.request(`/api/public/surveys/${survey.slug}`);
  const concurrent = await Promise.all([0, 1].map(() => student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} })));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201]);
  assert.equal(concurrent[0].data.id, concurrent[1].data.id);
  assert.equal((await admin.request(`/api/admin/surveys/${survey.id}/report`)).data.summary.total, 66);
});

test("survey schema migration is additive and idempotent for existing quizzes and attempts", async (t) => {
  const { administrator, browser, app, dataDir } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  const start = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "До добавления опросов" } });
  const original = app.locals.db.prepare("SELECT * FROM attempts WHERE id=?").get(start.data.id);
  app.locals.db.exec("DROP TABLE IF EXISTS survey_events; DROP TABLE survey_responses; DROP TABLE surveys; PRAGMA user_version=4;");
  const migrated = openDatabase(dataDir);
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 5);
  assert.deepEqual(migrated.prepare("SELECT * FROM attempts WHERE id=?").get(start.data.id), original);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM surveys").get().n, 0);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM survey_responses").get().n, 0);
  migrated.close();
  openDatabase(dataDir).close();
  assert.equal((await admin.request(`/api/admin/quizzes/${quiz.id}`)).status, 200);
});

test("survey repeated question and presence changes refresh action timestamps while unchanged heartbeats do not", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin);
  const student = browser();
  const start = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
  const path = `/api/public/responses/${start.data.id}/presence`;
  const earlier = "2000-01-01T00:00:00.000Z";
  let response = await student.request(path, { method: "POST", body: { visibility: "visible", focused: true, questionId: survey.questions[0].id } });
  assert.equal(response.data.presence.lastAction, "question");
  app.locals.db.prepare("UPDATE survey_responses SET last_action_at=? WHERE id=?").run(earlier, start.data.id);
  response = await student.request(path, { method: "POST", body: { visibility: "visible", focused: true, questionId: survey.questions[1].id } });
  assert.equal(response.data.presence.lastAction, "question");
  assert.ok(response.data.presence.lastActionAt > earlier);
  await student.request(path, { method: "POST", body: { visibility: "hidden", focused: false } });
  app.locals.db.prepare("UPDATE survey_responses SET last_action_at=? WHERE id=?").run(earlier, start.data.id);
  response = await student.request(path, { method: "POST", body: { visibility: "visible", focused: true } });
  assert.equal(response.data.presence.lastAction, "presence");
  assert.ok(response.data.presence.lastActionAt > earlier);
  const changedAt = response.data.presence.lastActionAt;
  response = await student.request(path, { method: "POST", body: { visibility: "visible", focused: true } });
  assert.equal(response.data.presence.lastActionAt, changedAt);
  const report = (await admin.request(`/api/admin/surveys/${survey.id}/report`)).data;
  const events = report.responses[0].events;
  assert.equal(events.filter((event) => event.type === "question").length, 2);
  assert.equal(events.filter((event) => event.type === "presence").length, 3);
});

test("prototype-like survey IDs cannot satisfy required questions or progress without an actual own answer", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const survey = await surveyFor(admin, { questions: [
    { id: "constructor", type: "short", text: "Обязательный ответ", required: true },
    { id: "toString", type: "short", text: "Второй обязательный ответ", required: true },
  ] });
  const student = browser();
  const started = await student.request(`/api/public/surveys/${survey.slug}/start`, { method: "POST", body: {} });
  assert.equal(started.status, 201);
  assert.equal(started.data.presence.answeredCount, 0);
  const path = `/api/public/responses/${started.data.id}`;
  assert.equal((await student.request(`${path}/submit`, { method: "POST", body: { answers: {} } })).status, 400);
  const saved = await student.request(`${path}/answers`, { method: "PUT", body: { answers: { constructor: "Первый сохранён" } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.presence.answeredCount, 1);
  assert.equal((await student.request(`${path}/submit`, { method: "POST", body: {} })).status, 400);
  const final = await student.request(`${path}/submit`, { method: "POST", body: { answers: { toString: "Второй сохранён" } } });
  assert.equal(final.status, 200);
  assert.equal(final.data.status, "submitted");
  assert.equal(final.data.presence.answeredCount, 2);
});
