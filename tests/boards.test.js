import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture, quizFor } from "./helpers.js";
import { projectBoardParticipant } from "../server/board.js";
import { normalizeSettings } from "../server/model.js";

const adminPath = (quiz) => `/api/admin/quizzes/${quiz.id}`;
const boardPath = (token) => `/api/public/boards/${token}`;
const participantPath = (attempt) => `/api/public/attempts/${attempt.id}`;
const tokenOf = (quiz) => quiz.publicBoardToken;
async function ok(client, path, method = "GET", body, status = 200, extra = {}) {
  const result = await client.request(path, { method, body, ...extra });
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const start = (client, quiz, name = randomUUID(), headers) => ok(client, `/api/public/quizzes/${quiz.slug}/start`, "POST", { name, rulesAccepted: true }, 201, { headers });
const enabledQuiz = (admin, overrides = {}) => quizFor(admin, { ...overrides, settings: { ...overrides.settings, publicBoardEnabled: true } });
function keys(value, expected, label) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label); }
function safeBoard(board, forbiddenValues = []) {
  keys(board, ["title", "status", "joinPath", "serverNow", "presentation", "summary", "participants"], "Public board top-level allowlist");
  assert.ok(board.joinPath === null || /^\/q\/[a-z0-9][a-z0-9-]{2,79}$/.test(board.joinPath), "The optional invitation is a same-origin quiz path");
  keys(board.presentation, ["showNames", "showScores"], "Public board presentation allowlist");
  for (const flag of ["showNames", "showScores"]) assert.equal(typeof board.presentation[flag], "boolean");
  keys(board.summary, ["total", "active", "submitted", "expired", "invalidated", "online", "away", "offline"], "Public board summary allowlist");
  assert.ok(Number.isFinite(Date.parse(board.serverNow)));
  for (const row of board.participants) {
    keys(row, ["boardCode", "label", "maskedIp", "contentRevision", "status", "startedAt", "finishedAt", "expiresAt", "durationSeconds", "questionCount", "answerableCount", "answeredCount", "currentQuestionNumber", "presence", "questions",
      ...(Object.hasOwn(row, "name") ? ["name"] : []),
      ...(Object.hasOwn(row, "score") ? ["score", "maxScore", "percent"] : []),
    ], "Public participant allowlist");
    if (Object.hasOwn(row, "name")) { assert.equal(board.presentation.showNames, true); assert.equal(typeof row.name, "string"); }
    if (Object.hasOwn(row, "score")) {
      assert.equal(board.presentation.showScores, true);
      assert.ok(["submitted", "expired"].includes(row.status));
      for (const key of ["score", "maxScore", "percent"]) assert.ok(Number.isFinite(row[key]));
    }
    assert.match(row.boardCode, /^[A-F0-9]{12}$/);
    assert.equal(row.label, `Участник #${row.boardCode}`);
    keys(row.presence, ["status", "lastSeenAt"], "Public presence allowlist");
    for (const question of row.questions) {
      keys(question, ["number", "answerable", "answered", "current", "checked"], "Public question allowlist");
      for (const flag of ["answerable", "answered", "current", "checked"]) assert.equal(typeof question[flag], "boolean");
    }
  }
  const serialized = JSON.stringify(board);
  for (const value of forbiddenValues.filter((value) => value !== null && value !== undefined && String(value).length)) assert.ok(!serialized.includes(String(value)), `Public board leaked ${value}`);
  return board;
}
function noBoardCredential(value, token) {
  assert.ok(!JSON.stringify(value).includes(token), "The public access token is administrator-only");
  for (const name of ["publicBoardToken", "boardToken", "publicBoardUrl", "boardUrl"]) assert.equal(value[name], undefined, `Public API exposed ${name}`);
}

// A second ephemeral listener exposes the existing fixture app, database and event
// bus to a raw SSE reader without changing the shared HTTP test helper.
async function streamHost(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function stream(t, host, token, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(`${host}${boardPath(token)}/live`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = [], waiters = new Set();
  let ended = false;
  const announce = () => {
    for (const waiter of waiters) {
      const found = events.find((event) => !event.consumed && event.type === waiter.type);
      if (found) { found.consumed = true; clearTimeout(waiter.timeout); waiters.delete(waiter); waiter.resolve(found.data); }
    }
  };
  const done = (async () => {
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, end).split("\n"); buffer = buffer.slice(end + 2);
          const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (type && data) { events.push({ type, data: JSON.parse(data), consumed: false }); announce(); }
        }
      }
    } catch (error) { if (error.name !== "AbortError") throw error; }
    finally { ended = true; }
  })();
  // Attach a handler immediately; assertions below still await the same promise.
  done.catch(() => {});
  const close = () => controller.abort();
  t.after(async () => { close(); await done; });
  return {
    response, events, close, done, get ended() { return ended; },
    async next(type, timeoutMs = 3000) {
      const found = events.find((event) => !event.consumed && event.type === type);
      if (found) { found.consumed = true; return found.data; }
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timeout: null };
        waiter.timeout = setTimeout(() => { waiters.delete(waiter); reject(new Error(`SSE event ${type} not received`)); }, timeoutMs);
        waiters.add(waiter); announce();
      });
    },
  };
}
async function endedSoon(connection) {
  await Promise.race([connection.done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Revoked SSE connection remained open")), 2000); timer.unref(); })]);
  assert.equal(connection.ended, true);
}

test("public boards default to off, validate strict booleans and keep tokens server-owned across clone and rotation", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin);
  assert.equal(quiz.settings.publicBoardEnabled, false);
  assert.equal(quiz.settings.publicBoardShowNames, false);
  assert.equal(quiz.settings.publicBoardShowScores, true);
  assert.equal(tokenOf(quiz), null);
  for (const key of ["publicBoardEnabled", "publicBoardShowNames", "publicBoardShowScores"])
    for (const value of [null, 0, 1, "true", "false", {}, []]) assert.equal((await admin.request(adminPath(quiz), { method: "PUT", body: { ...quiz, settings: { ...quiz.settings, [key]: value } } })).status, 400);
  assert.equal((await browser().request(`${adminPath(quiz)}/board/rotate`, { method: "POST", body: {} })).status, 401);
  assert.equal((await admin.request(`${adminPath(quiz)}/board/rotate`, { method: "POST", body: {}, csrf: false })).status, 403);
  assert.equal((await admin.request(`${adminPath(quiz)}/board/rotate`, { method: "POST", body: {}, requestOrigin: "https://other.invalid" })).status, 403);
  assert.equal((await admin.request(`${adminPath(quiz)}/board/rotate`, { method: "POST", body: {} })).status, 409);
  const revision = quiz.contentRevision;
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, publicBoardToken: "FORGEDTOKENVALUE1", settings: { ...quiz.settings, publicBoardEnabled: true } });
  assert.match(tokenOf(quiz), /^[A-Za-z0-9_-]{16}$/);
  assert.equal(Buffer.from(tokenOf(quiz), "base64url").length, 12);
  assert.notEqual(tokenOf(quiz), "FORGEDTOKENVALUE1");
  assert.equal(quiz.contentRevision, revision);
  const current = tokenOf(quiz);
  const ignored = await ok(admin, adminPath(quiz), "PUT", { ...quiz, publicBoardToken: "FORGEDTOKENVALUE2" });
  assert.equal(tokenOf(ignored), current);
  const clone = await ok(admin, `${adminPath(quiz)}/clone`, "POST", {}, 201);
  assert.equal(clone.settings.publicBoardEnabled, false);
  assert.equal(tokenOf(clone), null);
  const rotated = await ok(admin, `${adminPath(quiz)}/board/rotate`, "POST", {});
  keys(rotated, ["publicBoardToken"]);
  assert.match(rotated.publicBoardToken, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(rotated.publicBoardToken, current);
  assert.equal((await browser().request(boardPath(current))).status, 404);
  assert.equal((await browser().request(boardPath(rotated.publicBoardToken))).status, 200);
});

test("public board JSON and SSE hints have strict allowlists and never expose names, full IPs, private IDs, questions, answers or keys", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const groupId = randomUUID(), studentId = randomUUID(), questionId = randomUUID();
  const quiz = await enabledQuiz(admin, { title: "Публичное занятие", groups: [{ id: groupId, name: "PRIVATE_GROUP_NAME", students: [{ id: studentId, name: "PRIVATE_STUDENT_NAME", code: "529471" }] }], settings: { rosterEnabled: true, requireStudentCode: true }, questions: [{ id: questionId, type: "short", text: "PRIVATE_QUESTION_TEXT", points: 1, correct: "PRIVATE_CORRECT_KEY" }] });
  const student = browser();
  const active = await ok(student, `/api/public/quizzes/${quiz.slug}/start`, "POST", { groupId, studentId, code: "529471" }, 201, { headers: { "CF-Connecting-IP": "203.0.113.73", "User-Agent": "PRIVATE_USER_AGENT" } });
  await ok(student, `${participantPath(active)}/answers`, "PUT", { answers: { [questionId]: "PRIVATE_TYPED_ANSWER" } });
  app.locals.db.prepare("UPDATE events SET metadata=? WHERE attempt_id=?").run(JSON.stringify({ detail: "PRIVATE_EVENT_METADATA" }), active.id);
  const forbidden = [tokenOf(quiz), quiz.id, active.id, groupId, studentId, questionId, "PRIVATE_GROUP_NAME", "PRIVATE_STUDENT_NAME", "529471", "PRIVATE_QUESTION_TEXT", "PRIVATE_CORRECT_KEY", "203.0.113.73", "PRIVATE_USER_AGENT", "PRIVATE_TYPED_ANSWER", "PRIVATE_EVENT_METADATA"];
  const response = await browser().request(boardPath(tokenOf(quiz)));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const board = safeBoard(response.data, forbidden);
  assert.equal(board.participants.length, 1);
  assert.equal(board.participants[0].boardCode, active.boardCode);
  assert.equal(board.participants[0].maskedIp, "203.0.*.*");
  noBoardCredential(await ok(student, participantPath(active)), tokenOf(quiz));
  noBoardCredential(await ok(student, `/api/public/quizzes/${quiz.slug}`), tokenOf(quiz));
  const host = await streamHost(t, app), connection = await stream(t, host, tokenOf(quiz));
  const ready = await connection.next("ready"); keys(ready, ["serverNow"]);
  await ok(student, `${participantPath(active)}/presence`, "POST", { visibility: "visible", focused: true, questionId });
  const update = await connection.next("update"); keys(update, ["serverNow"]);
  for (const payload of [ready, update]) for (const value of forbidden) assert.ok(!JSON.stringify(payload).includes(value));
  connection.close(); await connection.done;
});

test("mixed question progress treats numeric zero as answered, excludes content from graded counts and exposes checked flags without correctness", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await enabledQuiz(admin, { settings: { feedbackMode: "immediate", shuffleQuestions: false, shuffleOptions: false }, questions: [
    { id: "intro", type: "content", text: "Информация", points: 0 },
    { id: "zero", type: "number", text: "Ноль", points: 1, correct: 0, tolerance: 0 },
    { id: "middle", type: "content", text: "Информационная страница", points: 0 },
    { id: "single", type: "single", text: "Выбор", points: 1, options: [{ id: "a", text: "Первый" }, { id: "b", text: "Второй" }], correct: ["a"] },
    { id: "multiple", type: "multiple", text: "Несколько", points: 1, options: [{ id: "a", text: "А" }, { id: "b", text: "Б" }], correct: ["a"] },
    { id: "short", type: "short", text: "Слово", points: 1, correct: "верно" },
    { id: "matching", type: "matching", text: "Пары", points: 1, pairs: [{ id: "p", left: "Слева", right: "Справа" }, { id: "q", left: "Лево", right: "Право" }] },
    { id: "ordering", type: "ordering", text: "Порядок", points: 1, options: [{ id: "x", text: "Первый" }, { id: "y", text: "Второй" }], correct: ["x", "y"] },
  ] });
  const student = browser(), active = await start(student, quiz);
  await ok(student, `${participantPath(active)}/answers`, "PUT", { answers: { zero: 0, multiple: [], short: "   ", matching: {}, ordering: [] } });
  await ok(student, `${participantPath(active)}/presence`, "POST", { visibility: "visible", focused: true, questionId: "middle" });
  let row = safeBoard(await ok(browser(), boardPath(tokenOf(quiz)))).participants[0];
  assert.equal(row.questionCount, 8); assert.equal(row.answerableCount, 6); assert.equal(row.answeredCount, 1); assert.equal(row.currentQuestionNumber, 3);
  assert.deepEqual(row.questions.map((q) => q.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const index of [0, 2]) assert.deepEqual(row.questions[index], { number: index + 1, answerable: false, answered: false, current: index === 2, checked: false });
  assert.equal(row.questions[1].answered, true);
  assert.ok(row.questions.slice(3).every((q) => !q.answered));
  const checked = await ok(student, `${participantPath(active)}/check`, "POST", { questionId: "single", answer: "b" });
  assert.equal(checked.feedback.single.correct, false);
  row = safeBoard(await ok(browser(), boardPath(tokenOf(quiz)))).participants[0];
  assert.equal(row.answeredCount, 2); assert.equal(row.questions[3].checked, true);
  assert.equal(row.questions[3].answered, true); assert.equal(row.questions[3].correct, undefined);
  await ok(student, `${participantPath(active)}/submit`, "POST", {});
  const completed = safeBoard(await ok(browser(), boardPath(tokenOf(quiz)))).participants[0];
  assert.equal(completed.status, "submitted"); assert.equal(completed.questions[3].checked, true); assert.equal(completed.questions[1].answered, true);
  assert.equal(completed.boardCode, active.boardCode);
});

test("board states restore submitted, expired and invalidated work while active presence can be online, away or offline", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await enabledQuiz(admin, { settings: { antiCheat: true, maxWarnings: 1 }, questions: [{ id: "n", type: "number", text: "Число", points: 1, correct: 0, tolerance: 0 }] });
  const clients = [browser(), browser(), browser(), browser()], runs = [];
  for (const [index, client] of clients.entries()) runs.push(await start(client, quiz, `Участник ${index}`));
  await ok(clients[1], `${participantPath(runs[1])}/submit`, "POST", { answers: { n: 0 } });
  await ok(clients[2], `${participantPath(runs[2])}/answers`, "PUT", { answers: { n: 0 } });
  app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), runs[2].id);
  await ok(clients[3], `${participantPath(runs[3])}/events`, "POST", { type: "visibility", eventId: randomUUID() });
  await ok(clients[0], `${participantPath(runs[0])}/presence`, "POST", { visibility: "visible", focused: true, questionId: "n" });
  let board = safeBoard(await ok(browser(), boardPath(tokenOf(quiz))));
  assert.deepEqual(board.summary, { total: 4, active: 1, submitted: 1, expired: 1, invalidated: 1, online: 1, away: 0, offline: 0 });
  const byCode = (value, code) => value.participants.find((row) => row.boardCode === code);
  assert.equal(byCode(board, runs[2].boardCode).answeredCount, 1);
  assert.equal(byCode(board, runs[2].boardCode).status, "expired");
  assert.equal(byCode(board, runs[3].boardCode).status, "invalidated");
  await ok(clients[0], `${participantPath(runs[0])}/presence`, "POST", { visibility: "hidden", focused: false, questionId: "n" });
  assert.equal((await ok(browser(), boardPath(tokenOf(quiz)))).summary.away, 1);
  app.locals.db.prepare("UPDATE attempts SET started_at=?,last_seen_at=? WHERE id=?").run(new Date(Date.now() - 300000).toISOString(), new Date(Date.now() - 90000).toISOString(), runs[0].id);
  board = safeBoard(await ok(browser(), boardPath(tokenOf(quiz))));
  assert.equal(board.summary.offline, 1);
  assert.equal(byCode(board, runs[0].boardCode).presence.status, "offline");
  assert.ok(byCode(board, runs[0].boardCode).durationSeconds >= 300);
});

test("each board row uses its own question revision, snapshot page count and frozen answer types", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await enabledQuiz(admin, { settings: { shuffleQuestions: false }, questions: [{ id: "info", type: "content", text: "Информация", points: 0 }, { id: "same", type: "short", text: "Прежний вопрос", points: 1, correct: "старый" }, { id: "old", type: "number", text: "Прежний номер", points: 1, correct: 0, tolerance: 0 }] });
  const previous = quiz.contentRevision, token = tokenOf(quiz), oldStudent = browser(), old = await start(oldStudent, quiz);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, questions: [{ id: "same", type: "single", text: "Новый тип", points: 1, options: [{ id: "a", text: "А" }, { id: "b", text: "Б" }], correct: ["b"] }] });
  assert.equal(tokenOf(quiz), token);
  const newStudent = browser(), next = await start(newStudent, quiz);
  await ok(oldStudent, `${participantPath(old)}/answers`, "PUT", { answers: { same: "Старый ответ", old: 0 } });
  await ok(oldStudent, `${participantPath(old)}/presence`, "POST", { visibility: "visible", focused: true, questionId: "old" });
  await ok(newStudent, `${participantPath(next)}/answers`, "PUT", { answers: { same: "b" } });
  const board = safeBoard(await ok(browser(), boardPath(token)));
  const before = board.participants.find((row) => row.boardCode === old.boardCode), after = board.participants.find((row) => row.boardCode === next.boardCode);
  assert.equal(before.contentRevision, previous); assert.equal(before.questionCount, 3); assert.equal(before.answerableCount, 2); assert.equal(before.answeredCount, 2); assert.equal(before.currentQuestionNumber, 3);
  assert.equal(after.contentRevision, quiz.contentRevision); assert.equal(after.questionCount, 1); assert.equal(after.answerableCount, 1); assert.equal(after.answeredCount, 1);
  assert.notEqual(before.boardCode, after.boardCode);
});

test("masked addresses canonicalize IPv4, mapped IPv4 and equivalent IPv6 without leaking full addresses", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator(), quiz = await enabledQuiz(admin), codes = [];
  const addresses = ["203.0.113.73", "::ffff:203.0.113.73", "2001:0DB8:0000:0001:0000:0000:0000:00AB", "2001:db8:0:1::ab"];
  for (const address of addresses) { const active = await start(browser(), quiz, randomUUID(), { "CF-Connecting-IP": address }); codes.push(active.boardCode); }
  const noIp = await start(browser(), quiz), invalidIp = await start(browser(), quiz);
  app.locals.db.prepare("UPDATE attempts SET ip=? WHERE id=?").run("not-an-address", invalidIp.id);
  const board = safeBoard(await ok(browser(), boardPath(tokenOf(quiz))), addresses);
  const mask = (code) => board.participants.find((row) => row.boardCode === code).maskedIp;
  assert.equal(mask(codes[0]), "203.0.*.*"); assert.equal(mask(codes[1]), "203.0.*.*");
  assert.equal(mask(codes[2]), "2001:db8:0::…"); assert.equal(mask(codes[3]), "2001:db8:0::…");
  assert.equal(mask(noIp.boardCode), null); assert.equal(mask(invalidIp.boardCode), null);
});

test("late opt-in applies to existing participants, settings updates retain tokens and disabling removes their own public board code", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin), student = browser(), active = await start(student, quiz);
  assert.equal(active.boardCode, undefined);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardEnabled: true } });
  const token = tokenOf(quiz), own = await ok(student, participantPath(active));
  assert.match(own.boardCode, /^[A-F0-9]{12}$/);
  assert.equal((await ok(browser(), boardPath(token))).participants[0].boardCode, own.boardCode);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, status: "closed", settings: { ...quiz.settings, maxWarnings: 2, timeLimitMinutes: 30, deadline: new Date(Date.now() + 1200000).toISOString() } });
  assert.equal(tokenOf(quiz), token);
  assert.equal((await ok(browser(), boardPath(token))).status, "closed");
  assert.equal((await ok(student, participantPath(active))).boardCode, own.boardCode);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardEnabled: false } });
  assert.equal(tokenOf(quiz), null);
  assert.equal((await ok(student, participantPath(active))).boardCode, undefined);
  assert.equal((await browser().request(boardPath(token))).status, 404);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardEnabled: true } });
  assert.notEqual(tokenOf(quiz), token);
  assert.equal((await ok(student, participantPath(active))).boardCode, own.boardCode);
});

test("malformed, random, disabled and rotated board tokens have one unavailable response and expose no quiz metadata", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator(), quiz = await enabledQuiz(admin);
  const invalid = ["short", "a".repeat(15), "a".repeat(17), "!".repeat(16), "A".repeat(16), `${tokenOf(quiz)}=`, "..", "null"];
  for (const token of invalid) {
    if (token === tokenOf(quiz)) continue;
    const response = await browser().request(boardPath(encodeURIComponent(token)));
    assert.equal(response.status, 404);
    assert.ok(!JSON.stringify(response.data).includes(quiz.title));
    assert.ok(!JSON.stringify(response.data).includes(quiz.id));
  }
  const disabled = await quizFor(admin);
  assert.equal((await browser().request(boardPath("B".repeat(16)))).status, 404);
  assert.equal(disabled.settings.publicBoardEnabled, false);
});

test("disabling, rotating and deleting a board immediately revokes and closes existing SSE connections", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator(), host = await streamHost(t, app);
  let quiz = await enabledQuiz(admin), token = tokenOf(quiz), connection = await stream(t, host, token);
  keys(await connection.next("ready"), ["serverNow"]);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardEnabled: false } });
  assert.deepEqual(await connection.next("revoked"), { reason: "unavailable" }); await endedSoon(connection);
  assert.equal((await browser().request(`${boardPath(token)}/live`)).status, 404);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardEnabled: true } }); token = tokenOf(quiz);
  connection = await stream(t, host, token); await connection.next("ready");
  const rotated = await ok(admin, `${adminPath(quiz)}/board/rotate`, "POST", {});
  assert.deepEqual(await connection.next("revoked"), { reason: "unavailable" }); await endedSoon(connection);
  assert.equal((await browser().request(boardPath(token))).status, 404); token = rotated.publicBoardToken;
  quiz = await ok(admin, adminPath(quiz));
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, status: "closed" });
  connection = await stream(t, host, token); await connection.next("ready");
  await ok(admin, adminPath(quiz), "DELETE");
  assert.deepEqual(await connection.next("revoked"), { reason: "unavailable" }); await endedSoon(connection);
  assert.equal((await browser().request(boardPath(token))).status, 404);
});

test("public SSE updates are scoped to one quiz and closeLive releases every board connection", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator(), host = await streamHost(t, app), first = await enabledQuiz(admin, { title: "Первое занятие" }), second = await enabledQuiz(admin, { title: "Второе занятие" });
  const one = await stream(t, host, tokenOf(first)), two = await stream(t, host, tokenOf(second));
  await one.next("ready"); await two.next("ready");
  await start(browser(), second);
  keys(await two.next("update"), ["serverNow"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(one.events.filter((event) => event.type === "update").length, 0, "Another quiz must not wake this board's stream");
  const twoCount = two.events.filter((event) => event.type === "update").length;
  await start(browser(), first);
  keys(await one.next("update"), ["serverNow"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(two.events.filter((event) => event.type === "update").length, twoCount);
  assert.equal((await ok(browser(), boardPath(tokenOf(first)))).participants.length, 1);
  assert.equal((await ok(browser(), boardPath(tokenOf(second)))).participants.length, 1);
  app.locals.closeLive();
  await endedSoon(one); await endedSoon(two);
});

test("viewer connection limits release on disconnect and independent viewers behind the same IP remain independent", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator(), quiz = await enabledQuiz(admin), host = await streamHost(t, app), first = await stream(t, host, tokenOf(quiz));
  await first.next("ready");
  const cookieHeader = first.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookieHeader, "Connection accounting needs an opaque viewer cookie");
  assert.ok(first.response.headers.getSetCookie().every((value) => /httponly/i.test(value)));
  const connections = [first];
  for (let index = 1; index < 4; index++) { const connection = await stream(t, host, tokenOf(quiz), { Cookie: cookieHeader }); await connection.next("ready"); connections.push(connection); }
  const blocked = await fetch(`${host}${boardPath(tokenOf(quiz))}/live`, { headers: { Cookie: cookieHeader } });
  assert.equal(blocked.status, 429); await blocked.arrayBuffer();
  const independent = await stream(t, host, tokenOf(quiz)); await independent.next("ready");
  first.close(); await first.done; await new Promise((resolve) => setTimeout(resolve, 100));
  const replacement = await stream(t, host, tokenOf(quiz), { Cookie: cookieHeader }); await replacement.next("ready");
  for (const connection of [...connections, independent, replacement]) connection.close();
  await Promise.all([...connections, independent, replacement].map((connection) => connection.done));
  assert.equal((await browser().request(boardPath(tokenOf(quiz)))).status, 200);
});

test("public board request limits apply per opaque viewer without exhausting a class sharing one address", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator(), quiz = await enabledQuiz(admin), viewer = browser();
  let blocked = false;
  for (let index = 0; index < 182; index++) {
    const result = await viewer.request(boardPath(tokenOf(quiz)));
    if (result.status === 429) { blocked = true; break; }
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  assert.equal(blocked, true, "A repeated viewer must be bounded");
  assert.equal((await browser().request(boardPath(tokenOf(quiz)))).status, 200, "Another viewer behind the same NAT needs an independent quota");
  assert.equal((await viewer.request(`/api/public/quizzes/${quiz.slug}`)).status, 200, "Board polling cannot exhaust participant traffic");
});

test("forged viewer cookies cannot bypass the bootstrap budget while an already signed viewer retains its independent quota", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator(), quiz = await enabledQuiz(admin), legitimate = browser(), forger = browser();
  const initial = await legitimate.request(boardPath(tokenOf(quiz)));
  assert.equal(initial.status, 200);
  const cookie = initial.headers.getSetCookie().find((value) => /httponly/i.test(value));
  assert.ok(cookie, "Public viewers need a signed HttpOnly cookie");
  const name = cookie.slice(0, cookie.indexOf("="));
  let blocked = false;
  for (let index = 0; index < 62; index++) {
    forger.cookies.set(name, `${"A".repeat(43)}.${"B".repeat(43)}`);
    const result = await forger.request(boardPath(tokenOf(quiz)));
    if (result.status === 429) { blocked = true; break; }
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  assert.equal(blocked, true, "An invalid signature must stay subject to the bounded bootstrap path");
  assert.equal((await legitimate.request(boardPath(tokenOf(quiz)))).status, 200);
});

test("board QR invitations use the current public quiz path, remain available for closed-session resumption and are absent for drafts", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await enabledQuiz(admin), token = tokenOf(quiz);
  let board = safeBoard(await ok(browser(), boardPath(token)));
  assert.equal(board.joinPath, `/q/${quiz.slug}`);
  const student = browser(), active = await start(student, quiz, "Возвращающийся участник");
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, status: "closed", joinPath: "https://external.invalid/forged-invitation" });
  board = safeBoard(await ok(browser(), boardPath(token)));
  assert.equal(board.status, "closed");
  assert.equal(board.joinPath, `/q/${quiz.slug}`);
  assert.equal((await browser().request(`/api/public/quizzes/${quiz.slug}/start`, { method: "POST", body: { name: "Новая попытка" } })).status, 403);
  assert.equal((await ok(student, `/api/public/quizzes/${quiz.slug}`)).attempt.id, active.id, "A previously bound student can still resume from the invitation");
  const previousSlug = quiz.slug;
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, slug: `${quiz.slug}-current` });
  assert.equal(tokenOf(quiz), token);
  assert.equal((await ok(browser(), boardPath(token))).joinPath, `/q/${quiz.slug}`);
  assert.equal((await ok(student, `/api/public/quizzes/${previousSlug}`)).attempt.id, active.id, "Older invitation aliases retain the original bound attempt");
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, status: "draft" });
  board = safeBoard(await ok(browser(), boardPath(token)));
  assert.equal(board.status, "draft");
  assert.equal(board.joinPath, null);
  assert.equal((await browser().request(`/api/public/quizzes/${quiz.slug}`)).status, 404);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, status: "published" });
  assert.equal((await ok(browser(), boardPath(token))).joinPath, `/q/${quiz.slug}`);
});

test("public names are author-controlled and live changes apply to existing attempts without exposing other identity fields", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await enabledQuiz(admin);
  const revision = quiz.contentRevision, token = tokenOf(quiz), student = browser();
  const active = await start(student, quiz, "<script>Тестовое имя</script>");
  const forbidden = [active.id, token, "PRIVATE_GROUP", "PRIVATE_USER_AGENT", "PRIVATE_STUDENT_CODE"];
  app.locals.db.prepare("UPDATE attempts SET group_name=?,user_agent=?,identity_key=? WHERE id=?")
    .run("PRIVATE_GROUP", "PRIVATE_USER_AGENT", "PRIVATE_STUDENT_CODE", active.id);
  let board = safeBoard(await ok(browser(), `${boardPath(token)}?showNames=true`), [...forbidden, "Тестовое имя"]);
  assert.deepEqual(board.presentation, { showNames: false, showScores: true });
  assert.equal(board.participants[0].name, undefined);
  const host = await streamHost(t, app), connection = await stream(t, host, token);
  await connection.next("ready");
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardShowNames: true } });
  keys(await connection.next("update"), ["serverNow"]);
  assert.equal(quiz.contentRevision, revision);
  assert.equal(tokenOf(quiz), token);
  board = safeBoard(await ok(browser(), boardPath(token)), forbidden);
  assert.equal(board.presentation.showNames, true);
  assert.equal(board.participants[0].name, "<script>Тестовое имя</script>");
  assert.equal(board.participants[0].boardCode, active.boardCode);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardShowNames: false } });
  keys(await connection.next("update"), ["serverNow"]);
  board = safeBoard(await ok(browser(), boardPath(token)), [...forbidden, "Тестовое имя"]);
  assert.equal(board.presentation.showNames, false);
  assert.equal(Object.hasOwn(board.participants[0], "name"), false);
  assert.equal(board.participants[0].boardCode, active.boardCode);
  connection.close(); await connection.done;
});

test("boards show only finalized aggregate scores and current author permissions can hide or restore existing results", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await enabledQuiz(admin, { settings: { antiCheat: true, maxWarnings: 1 }, questions: [
    { id: "private-question-id", type: "number", text: "PRIVATE_QUESTION_TEXT", points: 3, correct: 0, tolerance: 0 },
  ] });
  const token = tokenOf(quiz), revision = quiz.contentRevision, students = [browser(), browser(), browser(), browser(), browser()], attempts = [];
  for (const [index, student] of students.entries()) attempts.push(await start(student, quiz, `PRIVATE_NAME_${index}`));
  await ok(students[1], `${participantPath(attempts[1])}/submit`, "POST", { answers: { "private-question-id": 0 } });
  await ok(students[2], `${participantPath(attempts[2])}/submit`, "POST", { answers: { "private-question-id": 1 } });
  await ok(students[3], `${participantPath(attempts[3])}/answers`, "PUT", { answers: { "private-question-id": 0 } });
  app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), attempts[3].id);
  await ok(students[4], `${participantPath(attempts[4])}/events`, "POST", { type: "visibility", eventId: randomUUID() });
  // Even a result column present on unfinished work cannot expose live grades.
  app.locals.db.prepare("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify({ score: 3, maxScore: 3, percent: 100, questionResults: { private: true } }), attempts[0].id);
  const forbidden = [token, ...attempts.map((attempt) => attempt.id), "PRIVATE_NAME_", "PRIVATE_QUESTION_TEXT", "private-question-id", "questionResults"];
  let board = safeBoard(await ok(browser(), boardPath(token)), forbidden);
  const byIndex = (index) => board.participants.find((row) => row.boardCode === attempts[index].boardCode);
  for (const [index, expected] of [[1, [3, 3, 100]], [2, [0, 3, 0]], [3, [3, 3, 100]]])
    assert.deepEqual([byIndex(index).score, byIndex(index).maxScore, byIndex(index).percent], expected);
  for (const index of [0, 4]) for (const key of ["score", "maxScore", "percent"]) assert.equal(Object.hasOwn(byIndex(index), key), false);
  assert.equal(byIndex(3).status, "expired");
  assert.equal(byIndex(4).status, "invalidated");
  const savedResults = app.locals.db.prepare("SELECT id,result FROM attempts ORDER BY id").all();
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardShowScores: false } });
  board = safeBoard(await ok(browser(), boardPath(token)), forbidden);
  assert.equal(board.presentation.showScores, false);
  for (const row of board.participants) for (const key of ["score", "maxScore", "percent"]) assert.equal(Object.hasOwn(row, key), false);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, publicBoardShowScores: true, showScore: false } });
  board = safeBoard(await ok(browser(), boardPath(token)), forbidden);
  assert.equal(board.presentation.showScores, false, "A hidden quiz score cannot be disclosed by the board");
  for (const row of board.participants) for (const key of ["score", "maxScore", "percent"]) assert.equal(Object.hasOwn(row, key), false);
  quiz = await ok(admin, adminPath(quiz), "PUT", { ...quiz, settings: { ...quiz.settings, showScore: true } });
  board = safeBoard(await ok(browser(), boardPath(token)), forbidden);
  assert.equal(board.presentation.showScores, true);
  assert.equal(byIndex(1).score, 3);
  assert.equal(byIndex(2).score, 0);
  assert.equal(tokenOf(quiz), token);
  assert.equal(quiz.contentRevision, revision);
  assert.deepEqual(app.locals.db.prepare("SELECT id,result FROM attempts ORDER BY id").all(), savedResults, "Presentation changes must not recalculate saved grades");
});

test("legacy board presentation defaults and direct projections remain private and malformed result objects never spread", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator(), quiz = await enabledQuiz(admin), student = browser();
  assert.equal(normalizeSettings({}).publicBoardShowNames, false);
  assert.equal(normalizeSettings({}).publicBoardShowScores, true);
  assert.equal(normalizeSettings({ publicBoardShowNames: "true", publicBoardShowScores: "true" }).publicBoardShowNames, false);
  assert.equal(normalizeSettings({ publicBoardShowScores: "true" }).publicBoardShowScores, false);
  const attempt = await start(student, quiz, "PRIVATE_PROJECTION_NAME");
  await ok(student, `${participantPath(attempt)}/submit`, "POST", {});
  const row = app.locals.db.prepare("SELECT * FROM attempts WHERE id=?").get(attempt.id);
  const privateProjection = projectBoardParticipant(row, "test-secret");
  for (const field of ["name", "score", "maxScore", "percent"]) assert.equal(Object.hasOwn(privateProjection, field), false);
  for (const result of ["{", "null", "[]", "{}", '{"score":-1,"maxScore":3,"percent":0}', '{"score":4,"maxScore":3,"percent":100}', '{"score":0,"maxScore":3,"percent":101}', '{"score":"0","maxScore":3,"percent":0}']) {
    const projected = projectBoardParticipant({ ...row, result }, "test-secret", Date.now(), { showScores: true });
    for (const field of ["score", "maxScore", "percent"]) assert.equal(Object.hasOwn(projected, field), false);
  }
  const blankName = projectBoardParticipant({ ...row, name: "  " }, "test-secret", Date.now(), { showNames: true });
  assert.equal(Object.hasOwn(blankName, "name"), false, "Anonymous work retains its board code");
});
