import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import JSZip from "jszip";
import { openDatabase } from "../server/db.js";

import { fixture, quizFor, correctAnswers, assertNoSecrets, origin, password } from "./helpers.js";

test("opted-in end feedback stays private while active and reveals original-language answers only after completion", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { showCorrectAnswersAfterTest: true } });
  assert.equal(quiz.settings.feedbackMode, "end");
  const student = browser();
  const start = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Отложенный результат", language: "kk" } },
  );
  const path = `/api/public/attempts/${start.data.id}`;
  assert.equal(start.data.review, undefined);
  assert.equal(start.data.feedback, undefined);
  assertNoSecrets(start.data);
  const answers = correctAnswers(quiz);
  answers[quiz.questions[0].id] = quiz.questions[0].options[1].id;
  const saved = await student.request(`${path}/answers`, {
    method: "PUT",
    body: { answers },
  });
  assertNoSecrets(saved.data);
  assert.equal(
    (
      await student.request(`${path}/check`, {
        method: "POST",
        body: {
          questionId: quiz.questions[0].id,
          answer: answers[quiz.questions[0].id],
        },
      })
    ).status,
    409,
  );
  const end = await student.request(`${path}/submit`, {
    method: "POST",
    body: {},
  });
  assert.equal(end.status, 200);
  assert.equal(end.data.review.length, 4);
  const first = end.data.review.find(
    (item) => item.questionId === quiz.questions[0].id,
  );
  assert.equal(first.correct, false);
  assert.deepEqual(first.expected, ["Астана"]);
  assert.equal(first.points, 0);
  assert.equal(first.maxPoints, 2);
  assert.equal(end.data.score, 8);
  assert.ok(end.data.questions.every((q) => q.correct === undefined));
  assert.deepEqual(end.data.review.find((item) => item.questionId === quiz.questions[1].id).expected, ["2", "4"]);
  assert.deepEqual(end.data.review.find((item) => item.questionId === quiz.questions[2].id).expected, ["React"]);
  assert.ok(
    end.data.review
      .find((item) => item.questionId === quiz.questions[3].id)
      .expected.includes("Франция — Париж"),
  );
  assert.equal((await browser().request(path)).status, 404);
});

test("immediate feedback locks every question type across check, autosave and final submission", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, {
    settings: { feedbackMode: "immediate", showCorrectAnswersAfterTest: true },
  });
  const student = browser();
  const start = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Проверка каждого ответа" } },
  );
  const path = `/api/public/attempts/${start.data.id}`;
  assert.deepEqual(start.data.feedback, {});
  assertNoSecrets(start.data);
  const [single, multiple, short, matching, content] = quiz.questions;
  const wrong = single.options[1].id;
  const check = await student.request(`${path}/check`, {
    method: "POST",
    body: { questionId: single.id, answer: wrong },
  });
  assert.equal(check.status, 200);
  assert.equal(check.data.feedback[single.id].correct, false);
  assert.deepEqual(Object.keys(check.data.feedback), [single.id]);
  assert.equal(check.data.review, undefined);
  assert.equal(check.data.score, undefined);
  assert.equal(
    (
      await student.request(`${path}/check`, {
        method: "POST",
        body: { questionId: single.id, answer: wrong },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await student.request(`${path}/check`, {
        method: "POST",
        body: { questionId: single.id, answer: single.correct[0] },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await student.request(`${path}/answers`, {
        method: "PUT",
        body: { answers: { [single.id]: single.correct[0] } },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await student.request(`${path}/submit`, {
        method: "POST",
        body: { answers: { [single.id]: single.correct[0] } },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await student.request(`${path}/check`, {
        method: "POST",
        body: { questionId: content.id, answer: "anything" },
      })
    ).status,
    400,
  );
  const correct = correctAnswers(quiz);
  for (const question of [multiple, short, matching]) {
    const response = await student.request(`${path}/check`, {
      method: "POST",
      body: { questionId: question.id, answer: correct[question.id] },
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.feedback[question.id].correct, true);
  }
  // Reordered multiple choices and object keys have the same answer semantics.
  assert.equal(
    (
      await student.request(`${path}/answers`, {
        method: "PUT",
        body: {
          answers: {
            [multiple.id]: [...correct[multiple.id]].reverse(),
            [matching.id]: Object.fromEntries(
              Object.entries(correct[matching.id]).reverse(),
            ),
          },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await student.request(`${path}/answers`, {
        method: "PUT",
        body: { answers: { [short.id]: "changed after checking" } },
      })
    ).status,
    409,
  );
  const end = await student.request(`${path}/submit`, {
    method: "POST",
    body: {},
  });
  assert.equal(end.data.status, "submitted");
  assert.equal(end.data.score, 8);
  assert.equal(end.data.review.length, 4);
  assert.equal(
    (
      await student.request(`${path}/check`, {
        method: "POST",
        body: { questionId: single.id, answer: wrong },
      })
    ).status,
    409,
  );
});

test("concurrent checks cannot probe two alternatives for one question", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, {
    settings: { feedbackMode: "immediate" },
  });
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Конкурирующие проверки" } },
  );
  const path = `/api/public/attempts/${started.data.id}`;
  const question = quiz.questions[0];
  const responses = await Promise.all(
    question.options.map((option) =>
      student.request(`${path}/check`, {
        method: "POST",
        body: { questionId: question.id, answer: option.id },
      }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  const current = (await student.request(path)).data;
  assert.equal(Object.keys(current.feedback).length, 1);
  const original = current.answers[question.id];
  assert.equal(
    current.feedback[question.id].correct,
    original === question.correct[0],
  );
  assert.equal(
    (
      await browser().request(`${path}/check`, {
        method: "POST",
        body: { questionId: question.id, answer: original },
      })
    ).status,
    404,
  );
});

test("hidden and invalidated results do not disclose answer reviews; expiry reveals only finalized saved answers", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const hidden = await quizFor(admin, {
    settings: { feedbackMode: "immediate", showScore: false, showCorrectAnswersAfterTest: true },
  });
  const hiddenStudent = browser();
  const hiddenStart = await hiddenStudent.request(
    `/api/public/quizzes/${hidden.slug}/start`,
    { method: "POST", body: { name: "Скрытая проверка" } },
  );
  const hiddenPath = `/api/public/attempts/${hiddenStart.data.id}`;
  assert.equal(
    (
      await hiddenStudent.request(`${hiddenPath}/check`, {
        method: "POST",
        body: {
          questionId: hidden.questions[0].id,
          answer: hidden.questions[0].correct[0],
        },
      })
    ).status,
    409,
  );
  const hiddenEnd = await hiddenStudent.request(`${hiddenPath}/submit`, {
    method: "POST",
    body: { answers: correctAnswers(hidden) },
  });
  assert.equal(hiddenEnd.data.review, undefined);
  assert.equal(hiddenEnd.data.feedback, undefined);
  assert.equal(hiddenEnd.data.score, undefined);

  const guarded = await quizFor(admin, {
    settings: { antiCheat: true, feedbackMode: "immediate", maxWarnings: 1, showCorrectAnswersAfterTest: true },
  });
  const guardedStudent = browser();
  const guardedStart = await guardedStudent.request(
    `/api/public/quizzes/${guarded.slug}/start`,
    {
      method: "POST",
      body: { name: "Аннулированный обзор", rulesAccepted: true },
    },
  );
  const guardedPath = `/api/public/attempts/${guardedStart.data.id}`;
  await guardedStudent.request(`${guardedPath}/check`, {
    method: "POST",
    body: {
      questionId: guarded.questions[0].id,
      answer: guarded.questions[0].correct[0],
    },
  });
  const annulled = await guardedStudent.request(`${guardedPath}/events`, {
    method: "POST",
    body: { type: "visibility", eventId: randomUUID() },
  });
  assert.equal(annulled.data.status, "invalidated");
  assert.equal(annulled.data.review, undefined);
  assert.equal(annulled.data.feedback, undefined);
  assert.equal(annulled.data.score, 0);

  const timed = await quizFor(admin, { settings: { showCorrectAnswersAfterTest: true } });
  const timedStudent = browser();
  const timedStart = await timedStudent.request(
    `/api/public/quizzes/${timed.slug}/start`,
    { method: "POST", body: { name: "Истёкший обзор" } },
  );
  const timedPath = `/api/public/attempts/${timedStart.data.id}`;
  await timedStudent.request(`${timedPath}/answers`, {
    method: "PUT",
    body: { answers: correctAnswers(timed) },
  });
  app.locals.db
    .prepare("UPDATE attempts SET expires_at=? WHERE id=?")
    .run(new Date(Date.now() - 1000).toISOString(), timedStart.data.id);
  const expired = (await timedStudent.request(timedPath)).data;
  assert.equal(expired.status, "expired");
  assert.equal(expired.review.length, 4);
  assert.equal(expired.score, 10);
});

test("anti-cheat start waits for explicit rules consent and audits selected language without a warning", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { antiCheat: true } });
  const student = browser();
  const startPath = `/api/public/quizzes/${quiz.slug}/start`;
  assert.equal(
    (
      await student.request(startPath, {
        method: "POST",
        body: { name: "Согласие" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await student.request(startPath, {
        method: "POST",
        body: { name: "Согласие", rulesAccepted: false, language: "kk" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await student.request(startPath, {
        method: "POST",
        body: { name: "Согласие", rulesAccepted: true, language: "en" },
      })
    ).status,
    400,
  );
  assert.equal(
    app.locals.db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE quiz_id=?")
      .get(quiz.id).n,
    0,
  );
  const before = new Date().toISOString();
  const start = await student.request(startPath, {
    method: "POST",
    body: { name: "Согласие", rulesAccepted: true, language: "kk" },
  });
  assert.equal(start.status, 201);
  assert.equal(start.data.warnings, 0);
  assert.ok(start.data.startedAt >= before);
  const report = (await admin.request(`/api/admin/quizzes/${quiz.id}/report`))
    .data;
  const event = report.attempts[0].events.find(
    (entry) => entry.type === "rules_accepted",
  );
  assert.ok(event);
  assert.equal(event.counted, 0);
  assert.equal(event.metadata.language, "kk");
  assert.equal(event.createdAt, start.data.startedAt);
  // Existing browser resumes without creating a new attempt or requiring another consent.
  assert.equal(
    (
      await student.request(startPath, {
        method: "POST",
        body: { name: "Согласие" },
      })
    ).data.id,
    start.data.id,
  );
});

test("additive migrations preserve old rows and default policy does not lock innocent metadata edits", async (t) => {
  const { administrator, browser, app, dataDir } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  delete quiz.settings.feedbackMode;
  app.locals.db
    .prepare("UPDATE quizzes SET doc=? WHERE id=?")
    .run(JSON.stringify(quiz), quiz.id);
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Старая попытка" } },
  );
  const snapshotRow = app.locals.db
    .prepare("SELECT snapshot FROM attempts WHERE id=?")
    .get(started.data.id);
  const snapshot = JSON.parse(snapshotRow.snapshot);
  delete snapshot.settings.feedbackMode;
  app.locals.db
    .prepare("UPDATE attempts SET snapshot=? WHERE id=?")
    .run(JSON.stringify(snapshot), started.data.id);
  app.locals.db.exec(
    "ALTER TABLE attempts DROP COLUMN checked; ALTER TABLE events DROP COLUMN metadata;",
  );
  const migrated = openDatabase(dataDir);
  assert.equal(
    migrated
      .prepare("SELECT checked FROM attempts WHERE id=?")
      .get(started.data.id).checked,
    "{}",
  );
  assert.ok(
    migrated
      .prepare("PRAGMA table_info(events)")
      .all()
      .some((column) => column.name === "metadata"),
  );
  migrated.close();
  openDatabase(dataDir).close();
  const current = (
    await student.request(`/api/public/attempts/${started.data.id}`)
  ).data;
  assert.equal(current.settings.feedbackMode, "end");
  assert.equal(current.review, undefined);
  const updated = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT",
    body: {
      ...quiz,
      title: "Старый квиз — новое название",
      settings: { ...quiz.settings, feedbackMode: "end" },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(
    app.locals.db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE id=?")
      .get(started.data.id).n,
    1,
  );
});

test("CLI permits only one administrator and password reset revokes existing sessions", async (t) => {
  const { administrator, dataDir } = await fixture(t);
  const admin = await administrator();
  const script = fileURLToPath(
    new URL("../server/admin-cli.js", import.meta.url),
  );
  const extra = spawnSync(
    process.execPath,
    [script, "--username", "second-admin", "--password-stdin"],
    {
      env: { ...process.env, DATA_DIR: dataDir },
      input: password + "\n",
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.notEqual(extra.status, 0);
  const replacement = randomUUID() + "-test-only";
  const reset = spawnSync(
    process.execPath,
    [script, "--username", "teacher", "--password-stdin", "--reset-password"],
    {
      env: { ...process.env, DATA_DIR: dataDir },
      input: replacement + "\n",
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal((await admin.request("/api/admin/quizzes")).status, 401);
  assert.equal(
    (
      await admin.request("/api/auth/login", {
        method: "POST",
        body: { username: "teacher", password: replacement },
      })
    ).status,
    200,
  );
});

test("first-run authentication, secure cookie flags and CSRF protect administrator mutations", async (t) => {
  const { browser } = await fixture(t);
  const stranger = browser();
  assert.deepEqual((await stranger.request("/api/auth/status")).data, {
    authenticated: false,
    setupRequired: true,
  });
  assert.equal((await stranger.request("/api/admin/quizzes")).status, 401);
  const setupBody = { username: "teacher", password };
  assert.equal(
    (
      await stranger.request("/api/auth/setup", {
        method: "POST",
        body: setupBody,
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await stranger.request("/api/auth/setup", {
        method: "POST",
        body: setupBody,
        requestOrigin: "https://attacker.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await stranger.request("/api/auth/setup", {
        method: "POST",
        body: { ...setupBody, password: "short" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await stranger.request("/api/auth/setup", {
        method: "POST",
        body: setupBody,
      })
    ).status,
    200,
  );
  assert.ok(
    (
      await browser().request("/api/auth/setup", {
        method: "POST",
        body: setupBody,
      })
    ).status >= 400,
  );
  assert.equal(
    (
      await browser().request("/api/auth/login", {
        method: "POST",
        body: { username: "teacher", password: "Incorrect-password" },
      })
    ).status,
    401,
  );
  const login = await stranger.request("/api/auth/login", {
    method: "POST",
    body: setupBody,
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(login.headers.get("set-cookie"), /SameSite=(Strict|Lax)/i);
  assert.equal(
    (
      await stranger.request("/api/admin/quizzes", {
        method: "POST",
        body: {},
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (await stranger.request("/api/auth/status")).data.authenticated,
    true,
  );
  assert.equal(
    (await stranger.request("/api/auth/logout", { method: "POST" })).status,
    200,
  );
  assert.equal((await stranger.request("/api/admin/quizzes")).status, 401);
});

test("production bootstrap API remains disabled unless explicitly enabled", async (t) => {
  const { browser } = await fixture(t, { allowSetup: false });
  const result = await browser().request("/api/auth/setup", {
    method: "POST",
    body: { username: "teacher", password },
  });
  assert.ok([403, 404].includes(result.status));
});

test("all question types validate, participant responses conceal keys and codes, and server grades answers", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  const bad = structuredClone(quiz);
  bad.questions[0].correct = [randomUUID()];
  assert.equal(
    (
      await admin.request(`/api/admin/quizzes/${quiz.id}`, {
        method: "PUT",
        body: bad,
      })
    ).status,
    400,
  );
  const publicQuiz = await browser().request(
    `/api/public/quizzes/${quiz.slug}`,
  );
  assert.equal(publicQuiz.status, 200);
  assertNoSecrets(publicQuiz.data);
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Алиса" } },
  );
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assertNoSecrets(started.data);
  assert.equal(started.data.questions.length, 5);
  assert.equal(started.data.score, undefined);
  const matching = started.data.questions.find((q) => q.type === "matching");
  assert.ok(matching.pairs.every((p) => p.right === undefined));
  assert.equal(matching.choices.length, 2);
  const attemptPath = `/api/public/attempts/${started.data.id}`;
  assert.equal((await browser().request(attemptPath)).status, 404);
  const unknown = await student.request(`${attemptPath}/answers`, {
    method: "PUT",
    body: { answers: { [randomUUID()]: "injected" } },
  });
  assert.equal(unknown.status, 400);
  const submitted = await student.request(`${attemptPath}/submit`, {
    method: "POST",
    body: {
      answers: correctAnswers(quiz),
      score: 999999,
      percent: 999,
      status: "active",
    },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.status, "submitted");
  assert.equal(submitted.data.score, 10);
  assert.equal(submitted.data.maxScore, 10);
  assert.equal(submitted.data.percent, 100);
  const mutation = await student.request(`${attemptPath}/answers`, {
    method: "PUT",
    body: { answers: {} },
  });
  assert.ok(mutation.status >= 400 || mutation.data.status === "submitted");
  const final = (await student.request(attemptPath)).data;
  assert.equal(final.score, 10);
  assert.equal(final.finishedAt, submitted.data.finishedAt);
  const events = await student.request(`${attemptPath}/events`, {
    method: "POST",
    body: { type: "visibility", eventId: randomUUID() },
  });
  assert.ok(events.status >= 400 || events.data.warnings === final.warnings);
  const repeated = await student.request(`${attemptPath}/submit`, {
    method: "POST",
    body: { answers: {} },
  });
  assert.ok(repeated.status >= 400 || repeated.data.score === 10);
  assert.equal((await student.request(attemptPath)).data.score, 10);
});

test("first browser claims roster identity, invitation codes protect students and no browser can take another name", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const group = {
    id: randomUUID(),
    name: "25-13",
    students: [
      { id: randomUUID(), name: "Алия", code: "student-private-A" },
      { id: randomUUID(), name: "Ерлан", code: "student-private-B" },
    ],
  };
  const quiz = await quizFor(admin, {
    groups: [group],
    settings: { rosterEnabled: true, requireStudentCode: true },
  });
  const [alice, bob] = group.students;
  const first = browser();
  const second = browser();
  const publicQuiz = await first.request(`/api/public/quizzes/${quiz.slug}`);
  assertNoSecrets(publicQuiz.data);
  assert.equal(
    (
      await first.request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { studentId: alice.id, code: "wrong" },
      })
    ).status,
    403,
  );
  const [a, b] = await Promise.all([
    first.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST",
      body: { studentId: alice.id, code: alice.code },
    }),
    second.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST",
      body: { studentId: alice.id, code: alice.code },
    }),
  ]);
  const winner = a.status === 201 ? first : second;
  const loser = a.status === 201 ? second : first;
  const started = a.status === 201 ? a : b;
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(
    (await loser.request(`/api/public/attempts/${started.data.id}`)).status,
    404,
  );
  assert.equal(
    (
      await winner.request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { studentId: bob.id, code: bob.code },
      })
    ).status,
    409,
  );
  const resume = await winner.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { studentId: alice.id, code: alice.code } },
  );
  assert.equal(resume.status, 200);
  assert.equal(resume.data.id, started.data.id);
  await winner.request(`/api/public/attempts/${started.data.id}/submit`, {
    method: "POST",
    body: { answers: {} },
  });
  assert.equal(
    (
      await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { studentId: alice.id, code: alice.code },
      })
    ).status,
    409,
  );
});

test("free names normalize case and whitespace, and browser identity lock survives submission", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "  Алиса   СЕРГЕЕВА " } },
  );
  assert.equal(started.status, 201);
  assert.equal(
    (
      await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: {} },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "алиса сергеева" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "Другое имя" },
      })
    ).status,
    409,
  );
  await student.request(`/api/public/attempts/${started.data.id}/submit`, {
    method: "POST",
    body: {},
  });
  assert.equal(
    (
      await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "Другое имя" },
      })
    ).status,
    409,
  );
});

test("server enforces expiry using saved answers and refuses post-expiry grading changes", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { timeLimitMinutes: 5 } });
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Таймер" } },
  );
  assert.equal(started.status, 201);
  const path = `/api/public/attempts/${started.data.id}`;
  assert.ok(
    new Date(started.data.expiresAt) > new Date(started.data.startedAt),
  );
  const oneAnswer = { [quiz.questions[0].id]: quiz.questions[0].correct[0] };
  assert.equal(
    (
      await student.request(`${path}/answers`, {
        method: "PUT",
        body: { answers: oneAnswer },
      })
    ).status,
    200,
  );
  app.locals.db
    .prepare("UPDATE attempts SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), started.data.id);
  const submitted = await student.request(`${path}/submit`, {
    method: "POST",
    body: { answers: correctAnswers(quiz) },
  });
  assert.ok(submitted.status === 200 || submitted.status === 409);
  const final = (await student.request(path)).data;
  assert.equal(final.status, "expired");
  assert.equal(final.score, 2);
  assert.equal(final.percent, 20);
  assert.ok(final.finishedAt.endsWith("Z"));
  assert.equal(
    (
      await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "Таймер" },
      })
    ).status,
    409,
  );
});

test("anti-cheat deduplicates events and third distinct warning permanently invalidates attempt", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, {
    settings: { antiCheat: true, blockPaste: true },
  });
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Античит", rulesAccepted: true } },
  );
  assert.equal(started.status, 201);
  const path = `/api/public/attempts/${started.data.id}`;
  await student.request(`${path}/answers`, {
    method: "PUT",
    body: { answers: correctAnswers(quiz) },
  });
  const eventId = randomUUID();
  const first = await student.request(`${path}/events`, {
    method: "POST",
    body: { type: "visibility", eventId },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.warnings, 1);
  const repeated = await student.request(`${path}/events`, {
    method: "POST",
    body: { type: "visibility", eventId },
  });
  assert.equal(repeated.data.warnings, 1);
  const sameTransition = await student.request(`${path}/events`, {
    method: "POST",
    body: { type: "blur", eventId },
  });
  assert.equal(sameTransition.data.warnings, 1);
  // Distinct incidents replayed immediately after reconnect must all count.
  const second = await student.request(`${path}/events`, {
    method: "POST",
    body: { type: "paste", eventId: randomUUID() },
  });
  assert.equal(second.data.warnings, 2);
  const third = await student.request(`${path}/events`, {
    method: "POST",
    body: { type: "visibility", eventId: randomUUID() },
  });
  assert.equal(third.data.status, "invalidated");
  assert.equal(third.data.warnings, 3);
  assert.equal(third.data.score, 0);
  await student.request(`${path}/submit`, {
    method: "POST",
    body: { answers: correctAnswers(quiz) },
  });
  const final = (await student.request(path)).data;
  assert.equal(final.status, "invalidated");
  assert.equal(final.score, 0);
  assert.equal(final.finishedAt, third.data.finishedAt);
  assert.equal(
    (
      await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "Античит", rulesAccepted: true },
      })
    ).status,
    409,
  );
});

test("anti-cheat is optional, and hidden score remains absent after submission", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, {
    settings: { antiCheat: false, showScore: false },
  });
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Без предупреждений" } },
  );
  assert.equal(started.status, 201);
  const path = `/api/public/attempts/${started.data.id}`;
  for (let i = 0; i < 4; i++) {
    const response = await student.request(`${path}/events`, {
      method: "POST",
      body: { type: "visibility", eventId: randomUUID() },
    });
    assert.equal(response.data.warnings, 0);
    assert.equal(response.data.status, "active");
  }
  const submitted = await student.request(`${path}/submit`, {
    method: "POST",
    body: { answers: correctAnswers(quiz) },
  });
  assert.equal(submitted.data.status, "submitted");
  assert.equal(submitted.data.score, undefined);
  assert.equal(submitted.data.percent, undefined);
  const report = await admin.request(`/api/admin/quizzes/${quiz.id}/report`);
  assert.equal(report.data.attempts[0].score, 10);
});

test("admin reports, XLSX chart package, anonymization and versioned author edits preserve finalized results", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    {
      method: "POST",
      body: { name: "=SUM(1,2)" },
      headers: {
        "CF-Connecting-IP": "203.0.113.123",
        "X-Forwarded-For": "203.0.113.123",
      },
    },
  );
  assert.equal(started.status, 201);
  await student.request(`/api/public/attempts/${started.data.id}/submit`, {
    method: "POST",
    body: { answers: correctAnswers(quiz) },
  });
  const reportPath = `/api/admin/quizzes/${quiz.id}/report`;
  assert.equal((await browser().request(reportPath)).status, 401);
  const report = await admin.request(reportPath);
  assert.equal(report.status, 200);
  assert.equal(report.data.summary.total, 1);
  assert.equal(report.data.summary.submitted, 1);
  assert.equal(report.data.summary.averagePercent, 100);
  assert.equal(report.data.attempts[0].name, "=SUM(1,2)");
  assert.notEqual(
    report.data.attempts[0].ip,
    "203.0.113.123",
    "Forwarded IP headers require explicit proxy trust",
  );
  assert.ok(report.data.attempts[0].startedAt.endsWith("Z"));
  assert.ok(report.data.attempts[0].finishedAt.endsWith("Z"));
  const changed = structuredClone(quiz);
  changed.questions[0].correct = [changed.questions[0].options[1].id];
  const edited = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT",
    body: changed,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.contentRevision, quiz.contentRevision + 1);
  const preserved = await admin.request(reportPath);
  assert.equal(preserved.data.attempts[0].percent, 100, "Changing the answer key must not regrade completed work");
  assert.equal(preserved.data.questions[0].total, 0, "Earlier revision results must not be attached to the changed answer key");
  const renamed = { ...edited.data, title: "Новое название" };
  assert.equal(
    (
      await admin.request(`/api/admin/quizzes/${quiz.id}`, {
        method: "PUT",
        body: renamed,
      })
    ).status,
    200,
  );
  const workbook = await admin.request(
    `/api/admin/quizzes/${quiz.id}/export.xlsx`,
  );
  assert.equal(workbook.status, 200);
  assert.match(workbook.headers.get("content-type"), /spreadsheetml/);
  assert.equal(workbook.data.subarray(0, 2).toString(), "PK");
  const zip = await JSZip.loadAsync(workbook.data);
  assert.ok(zip.file("xl/workbook.xml"));
  const sheets = Object.keys(zip.files).filter((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  assert.ok(
    sheets.length >= 4,
    "Report requires summary, attempts, questions and events worksheets",
  );
  const chart = Object.keys(zip.files).find((name) =>
    /^xl\/charts\/chart\d+\.xml$/.test(name),
  );
  assert.ok(chart, "Report should contain an actual Excel chart");
  assert.match(await zip.file(chart).async("string"), /chartSpace/);
  const sheetXml = (
    await Promise.all(sheets.map((name) => zip.file(name).async("string")))
  ).join("\n");
  assert.ok(
    !/<f[^>]*>\s*SUM\(1,2\)/i.test(sheetXml),
    "User-controlled names must remain strings, never Excel formulas",
  );
  const anonymized = await admin.request(
    `/api/admin/quizzes/${quiz.id}/anonymize`,
    { method: "POST" },
  );
  assert.equal(anonymized.status, 200);
  const after = await admin.request(reportPath);
  assert.ok(!after.data.attempts[0].ip);
  assert.equal(after.data.attempts[0].score, 10);
  assert.equal(
    (
      await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
        method: "POST",
        body: { name: "=SUM(1,2)" },
      })
    ).status,
    409,
  );
  const clone = await admin.request(`/api/admin/quizzes/${quiz.id}/clone`, {
    method: "POST",
  });
  assert.equal(clone.status, 201);
  assert.notEqual(clone.data.id, quiz.id);
  assert.notEqual(clone.data.slug, quiz.slug);
  assert.equal(clone.data.status, "draft");
  assert.equal(
    (await admin.request(`/api/admin/quizzes/${clone.data.id}/report`)).data
      .summary.total,
    0,
  );
  assert.equal(
    (
      await admin.request(`/api/admin/quizzes/${clone.data.id}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
});

test("SVG and forged raster uploads are rejected; valid PNGs are served with safe headers", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const svg =
    "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ).toString("base64");
  assert.equal(
    (
      await browser().request("/api/admin/uploads", {
        method: "POST",
        body: { data: svg },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await admin.request("/api/admin/uploads", {
        method: "POST",
        body: { data: svg },
      })
    ).status,
    400,
  );
  const forged =
    "data:image/png;base64," +
    Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
  assert.equal(
    (
      await admin.request("/api/admin/uploads", {
        method: "POST",
        body: { data: forged },
      })
    ).status,
    400,
  );
  const data =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kF9sAAAAASUVORK5CYII=";
  const upload = await admin.request("/api/admin/uploads", {
    method: "POST",
    body: { data },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  assert.match(upload.data.url, /^\/uploads\/[a-zA-Z0-9-]+\.png$/);
  const served = await browser().request(upload.data.url);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /image\/png/);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});

test("publication, closed quizzes and deadlines enforce access while an active student may finish a closed quiz", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const draft = await quizFor(admin, { status: "draft" });
  const draftStart = await browser().request(
    `/api/public/quizzes/${draft.slug}/start`,
    { method: "POST", body: { name: "Черновик" } },
  );
  assert.ok([403, 404, 409].includes(draftStart.status));
  const elapsed = await quizFor(admin, {
    settings: { deadline: new Date(Date.now() - 1000).toISOString() },
  });
  const elapsedStart = await browser().request(
    `/api/public/quizzes/${elapsed.slug}/start`,
    { method: "POST", body: { name: "Дедлайн" } },
  );
  assert.ok([403, 409, 410].includes(elapsedStart.status));
  const quiz = await quizFor(admin);
  const student = browser();
  const started = await student.request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Продолжение" } },
  );
  assert.equal(started.status, 201);
  assert.equal(
    (
      await admin.request(`/api/admin/quizzes/${quiz.id}`, {
        method: "PUT",
        body: { ...quiz, status: "closed" },
      })
    ).status,
    200,
  );
  const closedStart = await browser().request(
    `/api/public/quizzes/${quiz.slug}/start`,
    { method: "POST", body: { name: "Опоздавший" } },
  );
  assert.ok([403, 409].includes(closedStart.status));
  const submitted = await student.request(
    `/api/public/attempts/${started.data.id}/submit`,
    { method: "POST", body: { answers: correctAnswers(quiz) } },
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.status, "submitted");
  assert.equal(submitted.data.percent, 100);
});

test("a class behind one tunnel IP does not exhaust another student’s start quota", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  for (let i = 0; i < 65; i++) {
    const student = browser();
    const invite = await student.request(`/api/public/quizzes/${quiz.slug}`);
    assert.equal(invite.status, 200);
    const started = await student.request(
      `/api/public/quizzes/${quiz.slug}/start`,
      { method: "POST", body: { name: `Студент ${i}` } },
    );
    assert.equal(
      started.status,
      201,
      `Student ${i + 1}: ${JSON.stringify(started.data)}`,
    );
  }
  const report = await admin.request(`/api/admin/quizzes/${quiz.id}/report`);
  assert.equal(report.data.summary.active, 65);
});

test("IP restriction is optional and untrusted forwarded headers cannot bypass it", async (t) => {
  const { administrator, browser } = await fixture(t, { trustCloudflareIp: false });
  const admin = await administrator();
  const quiz = await quizFor(admin);
  assert.equal(quiz.settings.oneAttemptPerIp, false);
  for (const name of ["Общий адрес один", "Общий адрес два"]) {
    const start = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", body: { name },
    });
    assert.equal(start.status, 201, JSON.stringify(start.data));
  }
  const protectedQuiz = await quizFor(admin, { settings: { oneAttemptPerIp: true } });
  for (const [index, ip] of ["203.0.113.10", "203.0.113.11"].entries()) {
    const start = await browser().request(`/api/public/quizzes/${protectedQuiz.slug}/start`, {
      method: "POST",
      body: { name: `Подменённый адрес ${index}` },
      headers: { "CF-Connecting-IP": ip, "X-Forwarded-For": ip },
    });
    assert.equal(start.status, index === 0 ? 201 : 409, JSON.stringify(start.data));
  }
});

test("trusted IPv4, mapped IPv4 and IPv6 equivalent forms share one attempt while other addresses remain independent", async (t) => {
  const { administrator, browser } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { oneAttemptPerIp: true } });
  const equivalent = [
    ["203.0.113.1", "::ffff:203.0.113.1", "0000:0000:0000:0000:0000:ffff:cb00:7101"],
    ["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1", "2001:0db8:0000:0000:0001:0000:0000:0001"],
  ];
  for (const [groupIndex, addresses] of equivalent.entries()) {
    const owner = browser();
    let attemptId;
    for (const [index, ip] of addresses.entries()) {
      const start = await (index === 0 ? owner : browser()).request(
        `/api/public/quizzes/${quiz.slug}/start`,
        {
          method: "POST",
          headers: { "CF-Connecting-IP": ip },
          body: { name: `IP ${groupIndex} ${index}` },
        },
      );
      assert.equal(start.status, index === 0 ? 201 : 409, `${ip}: ${JSON.stringify(start.data)}`);
      if (index === 0) attemptId = start.data.id;
    }
    const resume = await owner.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST",
      headers: { "CF-Connecting-IP": addresses.at(-1) },
      body: { name: `IP ${groupIndex} 0` },
    });
    assert.equal(resume.status, 200);
    assert.equal(resume.data.id, attemptId);
  }
  const distinct = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: { "CF-Connecting-IP": "2001:db8::1:0:0:2" },
    body: { name: "Другой IPv6" },
  });
  assert.equal(distinct.status, 201);
  const concurrent = await Promise.all(["203.0.113.9", "::ffff:203.0.113.9"].map((ip, index) =>
    browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", headers: { "CF-Connecting-IP": ip },
      body: { name: `Одновременный IP ${index}` },
    }),
  ));
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 409]);
});

test("IP restriction covers every attempt status and anonymization retains the duplicate guard", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  for (const status of ["active", "submitted", "expired", "invalidated"]) {
    const quiz = await quizFor(admin, {
      settings: { oneAttemptPerIp: true, antiCheat: true, maxWarnings: 1 },
    });
    const headers = { "CF-Connecting-IP": "2001:db8::42" };
    const student = browser();
    const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", headers, body: { name: `Исходный ${status}`, rulesAccepted: true },
    });
    assert.equal(start.status, 201);
    const path = `/api/public/attempts/${start.data.id}`;
    if (status === "submitted") {
      await student.request(`${path}/submit`, { method: "POST", body: {} });
    } else if (status === "expired") {
      app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), start.data.id);
    } else if (status === "invalidated") {
      await student.request(`${path}/events`, {
        method: "POST", body: { type: "visibility", eventId: randomUUID() },
      });
    }
    assert.equal((await student.request(path)).data.status, status);
    const anonymized = await admin.request(`/api/admin/quizzes/${quiz.id}/anonymize`, { method: "POST" });
    assert.equal(anonymized.status, 200);
    const report = (await admin.request(`/api/admin/quizzes/${quiz.id}/report`)).data;
    assert.equal(report.attempts[0].ip, null);
    assert.equal(report.attempts[0].ip_key, undefined);
    assert.equal(report.attempts[0].ipKey, undefined);
    const repeated = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", headers, body: { name: `Другое имя ${status}`, rulesAccepted: true },
    });
    assert.equal(repeated.status, 409, `${status}: ${JSON.stringify(repeated.data)}`);
  }
});

test("IP restriction can be enabled after earlier attempts and disabled for a shared address", async (t) => {
  const { administrator, browser } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  let quiz = await quizFor(admin);
  const headers = { "CF-Connecting-IP": "203.0.113.88" };
  for (const [index, restricted] of [false, true, false, true].entries()) {
    const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...quiz, settings: { ...quiz.settings, oneAttemptPerIp: restricted } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    quiz = saved.data;
    const start = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", headers, body: { name: `Переключение ${index}` },
    });
    assert.equal(start.status, restricted ? 409 : 201, JSON.stringify(start.data));
  }
  const report = (await admin.request(`/api/admin/quizzes/${quiz.id}/report`)).data;
  assert.equal(report.summary.total, 2);
});

test("post-publication settings update active attempts while edited content preserves started and completed attempts", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  const activeStudent = browser();
  const finishedStudent = browser();
  const active = await activeStudent.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Продолжает" },
  });
  const finished = await finishedStudent.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Завершил" },
  });
  const activePath = `/api/public/attempts/${active.data.id}`;
  const finishedPath = `/api/public/attempts/${finished.data.id}`;
  const final = await finishedStudent.request(`${finishedPath}/submit`, {
    method: "POST", body: { answers: correctAnswers(quiz) },
  });
  const settings = {
    ...quiz.settings,
    antiCheat: true, oneAttemptPerIp: true, maxWarnings: 2, blockPaste: true,
    requireName: false, requireStudentCode: false,
    shuffleQuestions: false, shuffleOptions: false,
    showScore: false, feedbackMode: "immediate", timeLimitMinutes: 10,
  };
  const updated = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT", body: { ...quiz, title: "Правила обновлены", settings },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const current = (await activeStudent.request(activePath)).data;
  assert.deepEqual(current.settings, settings);
  assert.equal(current.status, "active");
  assert.equal(current.maxWarnings, 2);
  assert.deepEqual(current.questions, active.data.questions, "Existing randomized order stays stable");
  const unchanged = (await finishedStudent.request(finishedPath)).data;
  for (const field of ["status", "score", "maxScore", "percent", "finishedAt", "settings", "review"])
    assert.deepEqual(unchanged[field], final.data[field], `Finalized ${field} changed`);
  for (const change of [
    { slug: `${quiz.slug}-changed` },
    { groups: [{ id: randomUUID(), name: "Новый состав", students: [] }] },
    { questions: quiz.questions.map((question, index) => index ? question : { ...question, text: "Новый вопрос" }) },
  ]) {
    const response = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...updated.data, ...change },
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual((await activeStudent.request(activePath)).data.questions, active.data.questions, "Editing the shared link, roster or questions must preserve a started attempt");
    const preserved = (await finishedStudent.request(finishedPath)).data;
    for (const field of ["status", "score", "maxScore", "percent", "finishedAt", "review"])
      assert.deepEqual(preserved[field], final.data[field], `Content edit changed finalized ${field}`);
  }
  const violation = await activeStudent.request(`${activePath}/events`, {
    method: "POST", body: { type: "paste", eventId: randomUUID() },
  });
  assert.equal(violation.data.warnings, 1, "Active attempt uses newly enabled anti-cheat");
});

test("lowering warning limit waits for the next counted incident and anti-cheat can be toggled during a session", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, { settings: { antiCheat: true, maxWarnings: 3 } });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Новые предупреждения", rulesAccepted: true },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  for (let index = 0; index < 2; index++) {
    const event = await student.request(`${path}/events`, {
      method: "POST", body: { type: "visibility", eventId: randomUUID() },
    });
    assert.equal(event.data.status, "active");
  }
  for (const antiCheat of [false, true]) {
    const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...quiz, settings: { ...quiz.settings, antiCheat, maxWarnings: 1 } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    quiz = saved.data;
    assert.equal((await student.request(path)).data.status, "active");
    const ignored = await student.request(`${path}/events`, {
      method: "POST", body: { type: antiCheat ? "paste" : "visibility", eventId: randomUUID() },
    });
    assert.equal(ignored.data.status, "active");
    assert.equal(ignored.data.warnings, 2);
    const presence = await student.request(`${path}/presence`, {
      method: "POST", body: { visibility: "hidden", focused: false },
    });
    assert.equal(presence.data.status, "active");
    assert.equal(presence.data.warnings, 2);
  }
  const violation = await student.request(`${path}/events`, {
    method: "POST", body: { type: "blur", eventId: randomUUID() },
  });
  assert.equal(violation.data.status, "invalidated");
  assert.equal(violation.data.warnings, 3);
});

test("active time limits and deadlines can be extended, removed or shortened without reviving an expired attempt", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin, {
    settings: { timeLimitMinutes: 5, deadline: new Date(Date.now() + 180000).toISOString() },
  });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Изменяемый таймер" },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  assert.equal(start.data.expiresAt, quiz.settings.deadline);
  const cases = [
    { timeLimitMinutes: 10, deadline: null, expiresAt: new Date(Date.parse(start.data.startedAt) + 600000).toISOString() },
    { timeLimitMinutes: 0, deadline: null, expiresAt: null },
    { timeLimitMinutes: 0, deadline: new Date(Date.now() + 120000).toISOString() },
    { timeLimitMinutes: 1, deadline: null, expiresAt: new Date(Date.parse(start.data.startedAt) + 60000).toISOString() },
  ];
  for (const { expiresAt, ...settings } of cases) {
    const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...quiz, settings: { ...quiz.settings, ...settings } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    quiz = saved.data;
    const current = (await student.request(path)).data;
    assert.equal(current.status, "active");
    assert.equal(current.expiresAt, expiresAt === undefined ? settings.deadline : expiresAt);
  }
  await student.request(`${path}/answers`, {
    method: "PUT", body: { answers: { [quiz.questions[0].id]: quiz.questions[0].correct[0] } },
  });
  app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?")
    .run(new Date(Date.now() - 1000).toISOString(), start.data.id);
  const extended = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT", body: { ...quiz, settings: { ...quiz.settings, timeLimitMinutes: 20 } },
  });
  assert.equal(extended.status, 200);
  const final = (await student.request(path)).data;
  assert.equal(final.status, "expired");
  assert.equal(final.score, 2);
});

test("presence is browser-bound, validates input and records focus and progress without anti-cheat warnings", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { antiCheat: true, maxWarnings: 1 } });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Наблюдаемый", rulesAccepted: true },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  const presencePath = `${path}/presence`;
  const reportAttempt = async () => (await admin.request(`/api/admin/quizzes/${quiz.id}/report`))
    .data.attempts.find((attempt) => attempt.id === start.data.id);
  const body = { visibility: "hidden", focused: false, questionId: quiz.questions[0].id };
  assert.equal((await browser().request(presencePath, { method: "POST", body })).status, 404);
  assert.equal((await student.request(presencePath, { method: "POST", body, csrf: false })).status, 403);
  for (const invalid of [
    { ...body, visibility: "elsewhere" },
    { ...body, focused: "false" },
    { ...body, questionId: randomUUID() },
  ]) {
    assert.equal((await student.request(presencePath, { method: "POST", body: invalid })).status, 400);
  }
  const hidden = await student.request(presencePath, { method: "POST", body });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
  assert.equal(hidden.data.id, start.data.id);
  assert.equal(hidden.data.status, "active");
  assert.equal(hidden.data.warnings, 0);
  assertNoSecrets(hidden.data);
  let presence = (await reportAttempt()).presence;
  assert.equal(presence.status, "away");
  assert.equal(presence.visibility, "hidden");
  assert.equal(presence.focused, false);
  assert.equal(presence.questionId, quiz.questions[0].id);
  assert.equal(presence.totalQuestions, 4, "Content-only pages do not count toward answer progress");
  assert.equal(presence.answeredCount, 0);
  assert.ok(presence.lastSeenAt.endsWith("Z"));
  const visible = { visibility: "visible", focused: true, questionId: quiz.questions[1].id };
  await student.request(presencePath, { method: "POST", body: visible });
  presence = (await reportAttempt()).presence;
  assert.equal(presence.status, "active");
  const answers = correctAnswers(quiz);
  answers[quiz.questions[1].id] = [];
  answers[quiz.questions[2].id] = "   ";
  answers[quiz.questions[3].id] = {};
  await student.request(`${path}/answers`, { method: "PUT", body: { answers } });
  presence = (await reportAttempt()).presence;
  assert.equal(presence.answeredCount, 1, "Empty answers do not count as answered");
  assert.equal(presence.lastAction, "answers");
  assert.ok(presence.lastActionAt.endsWith("Z"));
  app.locals.db.prepare("UPDATE attempts SET last_seen_at=? WHERE id=?")
    .run(new Date(Date.now() - 36000).toISOString(), start.data.id);
  assert.equal((await reportAttempt()).presence.status, "offline");
  const renewed = await student.request(presencePath, { method: "POST", body: visible });
  assert.equal(renewed.data.warnings, 0);
  assert.equal((await reportAttempt()).presence.status, "active");
  await student.request(`${path}/submit`, { method: "POST", body: { answers: correctAnswers(quiz) } });
  const final = await reportAttempt();
  assert.equal(final.presence.status, "finished");
  assert.equal(final.presence.answeredCount, 4);
  const finishedPresence = structuredClone(final.presence);
  await student.request(presencePath, { method: "POST", body });
  assert.deepEqual((await reportAttempt()).presence, finishedPresence, "Late presence cannot alter completed activity");
});

test("administrator live stream rejects anonymous access and announces participant actions and policy updates", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  assert.equal((await browser().request("/api/admin/live")).status, 401);
  const stream = await admin.events("/api/admin/live");
  assert.deepEqual(await stream.next("ready"), { connected: true });
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Живые события" },
  });
  assert.equal(start.status, 201);
  const forQuiz = (data) => data.quizId === quiz.id;
  assert.deepEqual(await stream.next("update", forQuiz), { quizId: quiz.id });
  const path = `/api/public/attempts/${start.data.id}`;
  await student.request(`${path}/presence`, {
    method: "POST", body: { visibility: "hidden", focused: false, questionId: quiz.questions[0].id },
  });
  await stream.next("update", forQuiz);
  await student.request(`${path}/answers`, {
    method: "PUT", body: { answers: { [quiz.questions[0].id]: quiz.questions[0].correct[0] } },
  });
  await stream.next("update", forQuiz);
  const update = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT", body: { ...quiz, settings: { ...quiz.settings, maxWarnings: 2 } },
  });
  assert.equal(update.status, 200);
  await stream.next("update", forQuiz);
  await student.request(`${path}/submit`, { method: "POST", body: {} });
  await stream.next("update", forQuiz);
  stream.close();
});

test("IP and presence migrations preserve existing rows and backfill canonical addresses idempotently", async (t) => {
  const { administrator, browser, app, dataDir } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  let quiz = await quizFor(admin);
  const student = browser();
  const started = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: { "CF-Connecting-IP": "2001:DB8:0:0:0:0:0:51" },
    body: { name: "До миграции" },
  });
  const stored = app.locals.db.prepare("SELECT snapshot FROM attempts WHERE id=?").get(started.data.id).snapshot;
  app.locals.db.exec(`
    DROP INDEX attempts_ip_key;
    ALTER TABLE attempts DROP COLUMN ip_key;
    ALTER TABLE attempts DROP COLUMN last_seen_at;
    ALTER TABLE attempts DROP COLUMN presence_visibility;
    ALTER TABLE attempts DROP COLUMN presence_focused;
    ALTER TABLE attempts DROP COLUMN current_question_id;
    ALTER TABLE attempts DROP COLUMN last_action;
    ALTER TABLE attempts DROP COLUMN last_action_at;
    ALTER TABLE attempts DROP COLUMN retake_granted;
    DROP TABLE attempt_history;
  `);
  const migrated = openDatabase(dataDir);
  const row = migrated.prepare("SELECT * FROM attempts WHERE id=?").get(started.data.id);
  assert.equal(row.snapshot, stored);
  assert.equal(row.status, "active");
  assert.equal(row.retake_granted, 0);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM attempt_history").get().n, 0);
  assert.ok(row.ip_key, "Legacy addresses need a persistent duplicate guard");
  for (const key of ["last_seen_at", "presence_visibility", "presence_focused", "current_question_id", "last_action", "last_action_at"])
    assert.ok(Object.hasOwn(row, key), `Missing migrated ${key}`);
  const key = row.ip_key;
  migrated.close();
  const reopened = openDatabase(dataDir);
  assert.equal(reopened.prepare("SELECT ip_key FROM attempts WHERE id=?").get(started.data.id).ip_key, key);
  reopened.close();
  const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT", body: { ...quiz, settings: { ...quiz.settings, oneAttemptPerIp: true } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  quiz = saved.data;
  const duplicate = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: { "CF-Connecting-IP": "2001:db8::51" }, body: { name: "После миграции" },
  });
  assert.equal(duplicate.status, 409);
});

test("individual result deletion requires administrator CSRF, respects quiz scope and releases browser, identity and IP claims", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { oneAttemptPerIp: true } });
  const otherQuiz = await quizFor(admin);
  const student = browser();
  const headers = { "CF-Connecting-IP": "2001:db8::80" };
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers, body: { name: "Удаляемый результат" },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  await student.request(`${path}/submit`, { method: "POST", body: { answers: correctAnswers(quiz) } });
  const untouched = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: { "CF-Connecting-IP": "2001:db8::81" },
    body: { name: "Сохраняемый результат" },
  });
  assert.equal(untouched.status, 201);
  const deletionPath = `/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}`;
  assert.equal((await browser().request(deletionPath, { method: "DELETE" })).status, 401);
  assert.equal((await admin.request(deletionPath, { method: "DELETE", csrf: false })).status, 403);
  assert.equal((await admin.request(`/api/admin/quizzes/${otherQuiz.id}/attempts/${start.data.id}`, {
    method: "DELETE",
  })).status, 404);
  assert.equal((await student.request(path)).data.status, "submitted");
  const removed = await admin.request(deletionPath, { method: "DELETE" });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(app.locals.db.prepare("SELECT COUNT(*) AS n FROM events WHERE attempt_id=?").get(start.data.id).n, 0);
  assert.equal((await admin.request(deletionPath, { method: "DELETE" })).status, 404);
  assert.equal((await student.request(path)).status, 404);
  const report = (await admin.request(`/api/admin/quizzes/${quiz.id}/report`)).data;
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.submitted, 0);
  assert.equal(report.attempts[0].id, untouched.data.id);
  const replacement = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers, body: { name: "Удаляемый результат" },
  });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
  assert.notEqual(replacement.data.id, start.data.id);
});

test("deleting an active roster attempt rejects stale writes and allows its student identity in another browser", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  const group = {
    id: randomUUID(), name: "Повторный вход",
    students: [{ id: randomUUID(), name: "Участник списка", code: "private-retake-test-code" }],
  };
  const quiz = await quizFor(admin, {
    groups: [group], settings: { rosterEnabled: true, oneAttemptPerIp: true },
  });
  const student = browser();
  const identity = { studentId: group.students[0].id, code: group.students[0].code };
  const headers = { "CF-Connecting-IP": "203.0.113.80" };
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers, body: identity,
  });
  assert.equal(start.status, 201);
  const path = `/api/public/attempts/${start.data.id}`;
  await student.request(`${path}/answers`, {
    method: "PUT", body: { answers: correctAnswers(quiz) },
  });
  const removed = await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  for (const [suffix, method, body] of [
    ["/answers", "PUT", { answers: correctAnswers(quiz) }],
    ["/presence", "POST", { visibility: "visible", focused: true }],
    ["/events", "POST", { type: "visibility", eventId: randomUUID() }],
    ["/submit", "POST", {}],
  ]) {
    const stale = await student.request(path + suffix, { method, body });
    assert.equal(stale.status, 404, `${suffix}: ${JSON.stringify(stale.data)}`);
  }
  assert.equal(app.locals.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE quiz_id=?").get(quiz.id).n, 0);
  const replacement = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: { "CF-Connecting-IP": "::ffff:203.0.113.80" }, body: identity,
  });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
  assert.notEqual(replacement.data.id, start.data.id);
  assert.deepEqual(replacement.data.answers, {});
  assert.equal(replacement.data.warnings, 0);
});

test("retake grants require administrator CSRF and the correct quiz and apply only to invalidated attempts", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { antiCheat: true, maxWarnings: 1 } });
  const otherQuiz = await quizFor(admin);
  for (const status of ["active", "submitted", "expired", "invalidated"]) {
    const student = browser();
    const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", body: { name: `Проверка разрешения ${status}`, rulesAccepted: true },
    });
    assert.equal(start.status, 201);
    const path = `/api/public/attempts/${start.data.id}`;
    if (status === "submitted") await student.request(`${path}/submit`, { method: "POST", body: {} });
    if (status === "expired") app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), start.data.id);
    if (status === "invalidated") await student.request(`${path}/events`, {
      method: "POST", body: { type: "visibility", eventId: randomUUID() },
    });
    const grantPath = `/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}/retake`;
    assert.equal((await browser().request(grantPath, { method: "POST", body: {} })).status, 401);
    assert.equal((await admin.request(grantPath, { method: "POST", body: {}, csrf: false })).status, 403);
    assert.equal((await admin.request(`/api/admin/quizzes/${otherQuiz.id}/attempts/${start.data.id}/retake`, {
      method: "POST", body: {},
    })).status, 404);
    const granted = await admin.request(grantPath, { method: "POST", body: {} });
    assert.equal(granted.status, status === "invalidated" ? 200 : 409, JSON.stringify(granted.data));
    const current = (await student.request(path)).data;
    assert.equal(current.status, status);
    assert.equal(current.retakeGranted, status === "invalidated");
  }
  const missing = await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${randomUUID()}/retake`, {
    method: "POST", body: {},
  });
  assert.equal(missing.status, 404);
});

test("granted retake waits for participant consent, resets once with a fresh timer and preserves prior history until deletion", async (t) => {
  const { administrator, browser, app } = await fixture(t, { trustCloudflareIp: true });
  const admin = await administrator();
  let quiz = await quizFor(admin, {
    settings: { antiCheat: true, oneAttemptPerIp: true, maxWarnings: 1, timeLimitMinutes: 5, feedbackMode: "immediate" },
  });
  const student = browser();
  const oldHeaders = { "CF-Connecting-IP": "203.0.113.90" };
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: oldHeaders, body: { name: "Повторное прохождение", rulesAccepted: true },
  });
  assert.equal(start.status, 201);
  const oldPath = `/api/public/attempts/${start.data.id}`;
  await student.request(`${oldPath}/check`, {
    method: "POST", body: { questionId: quiz.questions[0].id, answer: quiz.questions[0].correct[0] },
  });
  const invalidated = await student.request(`${oldPath}/events`, {
    method: "POST", body: { type: "visibility", eventId: randomUUID() },
  });
  assert.equal(invalidated.data.status, "invalidated");
  const original = app.locals.db.prepare("SELECT * FROM attempts WHERE id=?").get(start.data.id);
  const historyCount = () => app.locals.db.prepare("SELECT COUNT(*) AS n FROM attempt_history WHERE quiz_id=?").get(quiz.id).n;
  assert.equal(historyCount(), 0);
  const grantPath = `/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}/retake`;
  for (let index = 0; index < 2; index++) {
    const granted = await admin.request(grantPath, { method: "POST", body: {} });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    assert.equal(granted.data.retakeGranted, true);
  }
  const waiting = (await student.request(oldPath)).data;
  assert.equal(waiting.retakeGranted, true);
  assert.equal(waiting.status, "invalidated");
  for (const field of ["startedAt", "expiresAt", "finishedAt", "warnings", "score", "answers"])
    assert.deepEqual(waiting[field], invalidated.data[field], `Grant changed ${field}`);
  assert.equal(historyCount(), 0, "Grant must not begin or archive a retake");
  const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT", body: { ...quiz, settings: { ...quiz.settings, timeLimitMinutes: 2 } },
  });
  assert.equal(saved.status, 200);
  quiz = saved.data;
  const newHeaders = { "CF-Connecting-IP": "2001:db8::90" };
  for (const body of [{}, { rulesAccepted: false }, { rulesAccepted: true, language: "en" }]) {
    const denied = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", headers: newHeaders, body,
    });
    assert.equal(denied.status, 400, JSON.stringify(denied.data));
  }
  assert.equal(historyCount(), 0);
  const foreign = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: oldHeaders, body: { name: "Другое имя", rulesAccepted: true },
  });
  assert.equal(foreign.status, 409, "A grant does not release the old IP claim");
  const beforeRestart = new Date().toISOString();
  const restarted = await Promise.all([0, 1].map(() => student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: newHeaders, body: { rulesAccepted: true, language: "kk" },
  })));
  assert.deepEqual(restarted.map((response) => response.status).sort(), [200, 201]);
  const next = restarted.find((response) => response.status === 201).data;
  assert.equal(restarted[0].data.id, restarted[1].data.id);
  assert.notEqual(next.id, start.data.id, "Stale requests must not target the new attempt");
  assert.equal(next.status, "active");
  assert.equal(next.retakeGranted, false);
  assert.equal(next.name, start.data.name);
  assert.equal(next.warnings, 0);
  assert.equal(next.finishedAt, null);
  assert.deepEqual(next.answers, {});
  assert.deepEqual(next.feedback, {});
  assert.equal(next.score, undefined);
  assert.ok(next.startedAt >= beforeRestart);
  assert.equal(next.expiresAt, new Date(Date.parse(next.startedAt) + 120000).toISOString());
  assert.equal(historyCount(), 1, "Concurrent starts must archive exactly once");
  const archived = app.locals.db.prepare("SELECT * FROM attempt_history WHERE quiz_id=?").get(quiz.id);
  assert.equal(archived.attempt_id, next.id);
  assert.equal(archived.ip_key, original.ip_key);
  const history = JSON.parse(archived.doc);
  for (const [field, column] of Object.entries({
    status: "status", startedAt: "started_at", expiresAt: "expires_at", finishedAt: "finished_at", warnings: "warnings",
  })) assert.deepEqual(history[field], original[column], `History lost original ${field}`);
  for (const field of ["snapshot", "answers", "checked", "result"])
    assert.deepEqual(history[field], JSON.parse(original[field]), `History lost original ${field}`);
  assert.ok(history.events.some((event) => event.type === "visibility" && event.counted === 1));
  assert.equal(history.ip, undefined);
  assert.equal(history.browser_hash, undefined);
  for (const [suffix, method, body] of [
    ["", "GET", undefined],
    ["/answers", "PUT", { answers: correctAnswers(quiz) }],
    ["/events", "POST", { type: "visibility", eventId: randomUUID() }],
    ["/submit", "POST", {}],
  ]) {
    assert.equal((await student.request(oldPath + suffix, { method, body })).status, 404);
  }
  const oldIpBlocked = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: oldHeaders, body: { name: "Старый IP после повтора", rulesAccepted: true },
  });
  assert.equal(oldIpBlocked.status, 409, "Previous IP remains reserved in archived history");
  const newPath = `/api/public/attempts/${next.id}`;
  const report = (await admin.request(`/api/admin/quizzes/${quiz.id}/report`)).data;
  assert.equal(report.summary.total, 1);
  assert.equal(report.attempts[0].id, next.id);
  assert.ok(report.attempts[0].events.some((event) => event.type === "retake_started"));
  const submitted = await student.request(`${newPath}/submit`, { method: "POST", body: { answers: correctAnswers(quiz) } });
  assert.equal(submitted.data.status, "submitted");
  assert.equal(submitted.data.score, 10);
  const deleted = await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${next.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(historyCount(), 0, "Deleting a result also removes its retained history and old IP claim");
  const released = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", headers: oldHeaders, body: { name: "Старый IP после удаления", rulesAccepted: true },
  });
  assert.equal(released.status, 201, JSON.stringify(released.data));
});

test("roster retakes in a new browser always require a real personal code and advertise that requirement", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const group = {
    id: randomUUID(), name: "Пересдача в другом браузере",
    students: [
      { id: randomUUID(), name: "С личным кодом", code: "retake-private-identity-code" },
      { id: randomUUID(), name: "Без личного кода", code: "" },
      { id: randomUUID(), name: "Обычная занятая попытка", code: "another-private-code" },
    ],
  };
  const quiz = await quizFor(admin, {
    groups: [group],
    settings: { rosterEnabled: true, requireStudentCode: false, antiCheat: true, maxWarnings: 1 },
  });
  const owners = group.students.map(() => browser());
  const attempts = [];
  for (const [index, student] of group.students.entries()) {
    const start = await owners[index].request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", body: { studentId: student.id, rulesAccepted: true },
    });
    assert.equal(start.status, 201, JSON.stringify(start.data));
    attempts.push(start.data);
    if (index === 2) continue;
    const invalidated = await owners[index].request(`/api/public/attempts/${start.data.id}/events`, {
      method: "POST", body: { type: "visibility", eventId: randomUUID() },
    });
    assert.equal(invalidated.data.status, "invalidated");
    const granted = await admin.request(`/api/admin/quizzes/${quiz.id}/attempts/${start.data.id}/retake`, {
      method: "POST", body: {},
    });
    assert.equal(granted.status, 200);
  }
  const newcomer = browser();
  const publicQuiz = await newcomer.request(`/api/public/quizzes/${quiz.slug}`);
  assert.equal(publicQuiz.status, 200);
  assertNoSecrets(publicQuiz.data);
  const [coded, noCode, occupied] = group.students.map((student) => publicQuiz.data.groups[0].students
    .find((option) => option.id === student.id));
  assert.equal(publicQuiz.data.settings.requireStudentCode, false);
  assert.equal(coded.available, true);
  assert.equal(coded.requiresRetakeCode, true);
  assert.equal(noCode.available, false, "A browser without the original cookie cannot prove a student identity without a configured code");
  assert.equal(noCode.requiresRetakeCode, false);
  assert.equal(occupied.available, false);
  assert.equal(occupied.requiresRetakeCode, false);
  for (const code of [undefined, "", "wrong-code", null]) {
    const denied = await newcomer.request(`/api/public/quizzes/${quiz.slug}/start`, {
      method: "POST", body: { studentId: group.students[0].id, code, rulesAccepted: true },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
  }
  const deniedNoCode = await browser().request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { studentId: group.students[1].id, code: "", rulesAccepted: true },
  });
  assert.equal(deniedNoCode.status, 403);
  const stillWaiting = (await owners[0].request(`/api/public/attempts/${attempts[0].id}`)).data;
  assert.equal(stillWaiting.retakeGranted, true);
  assert.equal(stillWaiting.status, "invalidated");
  const transferred = await newcomer.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { studentId: group.students[0].id, code: group.students[0].code, rulesAccepted: true },
  });
  assert.equal(transferred.status, 201, JSON.stringify(transferred.data));
  assert.notEqual(transferred.data.id, attempts[0].id);
  assert.equal(transferred.data.name, group.students[0].name);
  assert.equal(transferred.data.retakeGranted, false);
  assert.equal((await owners[0].request(`/api/public/attempts/${transferred.data.id}`)).status, 404);
  assert.equal((await owners[0].request(`/api/public/attempts/${attempts[0].id}`)).status, 404);
  const reclaimed = await owners[0].request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { studentId: group.students[0].id, code: group.students[0].code, rulesAccepted: true },
  });
  assert.equal(reclaimed.status, 409, "A consumed grant cannot be reused by its former browser");
  const originalNoCodeBrowser = await owners[1].request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { rulesAccepted: true },
  });
  assert.equal(originalNoCodeBrowser.status, 201, JSON.stringify(originalNoCodeBrowser.data));
  assert.equal(originalNoCodeBrowser.data.name, group.students[1].name);
});

test("correct answers stay hidden by default on every completed-attempt delivery path, including expiry", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  assert.equal(quiz.settings.showCorrectAnswersAfterTest, false);
  assert.equal(quiz.settings.showScore, true);
  for (const status of ["submitted", "expired"]) {
    const student = browser();
    const name = `Скрытые ответы ${status}`;
    const publicPath = `/api/public/quizzes/${quiz.slug}`;
    const invitation = await student.request(publicPath);
    assert.equal(invitation.data.settings.showCorrectAnswersAfterTest, false);
    const start = await student.request(`${publicPath}/start`, {
      method: "POST", body: { name },
    });
    assert.equal(start.status, 201);
    assert.equal(start.data.review, undefined);
    const path = `/api/public/attempts/${start.data.id}`;
    await student.request(`${path}/answers`, {
      method: "PUT", body: { answers: correctAnswers(quiz) },
    });
    let completed;
    if (status === "expired") {
      app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), start.data.id);
      completed = await student.request(path);
    } else {
      completed = await student.request(`${path}/submit`, {
        method: "POST", body: { showCorrectAnswersAfterTest: true },
      });
    }
    const deliveries = [
      completed.data,
      (await student.request(path)).data,
      (await student.request(publicPath)).data.attempt,
      (await student.request(`${publicPath}/start`, { method: "POST", body: { name } })).data,
      (await student.request(`${path}/submit`, { method: "POST", body: {} })).data,
    ];
    for (const attempt of deliveries) {
      assert.equal(attempt.status, status);
      assert.equal(attempt.score, 10, "Answer disclosure does not suppress the requested score");
      assert.equal(attempt.percent, 100);
      assert.equal(attempt.settings.showCorrectAnswersAfterTest, false);
      assert.equal(attempt.review, undefined);
      assert.equal(attempt.feedback, undefined);
      assertNoSecrets(attempt);
    }
  }
});

test("explicit immediate checks remain available while post-test answer disclosure is disabled", async (t) => {
  const { administrator, browser } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin, { settings: { feedbackMode: "immediate" } });
  assert.equal(quiz.settings.showCorrectAnswersAfterTest, false);
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Проверка без итоговых ответов" },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  const question = quiz.questions[0];
  const checked = await student.request(`${path}/check`, {
    method: "POST", body: { questionId: question.id, answer: question.correct[0] },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.status, "active");
  assert.equal(checked.data.feedback[question.id].correct, true);
  assert.deepEqual(checked.data.feedback[question.id].expected, ["Астана"]);
  assert.equal(checked.data.review, undefined);
  const submitted = await student.request(`${path}/submit`, { method: "POST", body: {} });
  assert.equal(submitted.data.score, 2);
  assert.equal(submitted.data.review, undefined);
  assert.equal(submitted.data.feedback, undefined);
  assertNoSecrets(submitted.data);
});

test("administrators can reveal and revoke completed answer reviews without changing frozen results or snapshots", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  for (const status of ["submitted", "expired"]) {
    let quiz = await quizFor(admin);
    const student = browser();
    const name = `Разрешение ответов ${status}`;
    const publicPath = `/api/public/quizzes/${quiz.slug}`;
    const start = await student.request(`${publicPath}/start`, { method: "POST", body: { name } });
    const path = `/api/public/attempts/${start.data.id}`;
    const answers = correctAnswers(quiz);
    answers[quiz.questions[0].id] = quiz.questions[0].options[1].id;
    await student.request(`${path}/answers`, { method: "PUT", body: { answers } });
    if (status === "expired") {
      app.locals.db.prepare("UPDATE attempts SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), start.data.id);
    } else await student.request(`${path}/submit`, { method: "POST", body: {} });
    const initial = (await student.request(path)).data;
    assert.equal(initial.status, status);
    assert.equal(initial.score, 8);
    assert.equal(initial.review, undefined);
    const frozen = app.locals.db.prepare("SELECT snapshot,result,finished_at,expires_at FROM attempts WHERE id=?").get(start.data.id);
    for (const enabled of [true, false, true, false]) {
      const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
        method: "PUT", body: { ...quiz, settings: { ...quiz.settings, showCorrectAnswersAfterTest: enabled } },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      quiz = saved.data;
      for (const attempt of [
        (await student.request(path)).data,
        (await student.request(publicPath)).data.attempt,
        (await student.request(`${publicPath}/start`, { method: "POST", body: { name } })).data,
      ]) {
        assert.equal(attempt.settings.showCorrectAnswersAfterTest, enabled, "Public permission must reflect the current quiz setting");
        assert.equal(attempt.status, initial.status);
        assert.equal(attempt.score, initial.score);
        assert.equal(attempt.percent, initial.percent);
        assert.equal(attempt.finishedAt, initial.finishedAt);
        if (enabled) {
          assert.equal(attempt.review.length, 4);
          assert.equal(attempt.review.find((item) => item.questionId === quiz.questions[0].id).correct, false);
          assert.deepEqual(attempt.review.find((item) => item.questionId === quiz.questions[2].id).expected, ["React"]);
        } else {
          assert.equal(attempt.review, undefined);
          assert.equal(attempt.feedback, undefined);
          assertNoSecrets(attempt);
        }
      }
      assert.deepEqual(app.locals.db.prepare("SELECT snapshot,result,finished_at,expires_at FROM attempts WHERE id=?").get(start.data.id), frozen);
    }
  }
});

test("legacy quizzes and snapshots without an answer-disclosure flag keep completed answers hidden", async (t) => {
  const { administrator, browser, app } = await fixture(t);
  const admin = await administrator();
  const quiz = await quizFor(admin);
  delete quiz.settings.showCorrectAnswersAfterTest;
  app.locals.db.prepare("UPDATE quizzes SET doc=? WHERE id=?").run(JSON.stringify(quiz), quiz.id);
  const student = browser();
  const start = await student.request(`/api/public/quizzes/${quiz.slug}/start`, {
    method: "POST", body: { name: "Старый квиз без разрешения" },
  });
  const path = `/api/public/attempts/${start.data.id}`;
  const snapshot = JSON.parse(app.locals.db.prepare("SELECT snapshot FROM attempts WHERE id=?").get(start.data.id).snapshot);
  delete snapshot.settings.showCorrectAnswersAfterTest;
  app.locals.db.prepare("UPDATE attempts SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), start.data.id);
  const submitted = await student.request(`${path}/submit`, {
    method: "POST", body: { answers: correctAnswers(quiz) },
  });
  for (const attempt of [submitted.data, (await student.request(path)).data]) {
    assert.equal(attempt.score, 10);
    assert.equal(attempt.settings.showCorrectAnswersAfterTest, false);
    assert.equal(attempt.review, undefined);
    assertNoSecrets(attempt);
  }
  // A stale opt-in in an old snapshot does not override a missing current permission.
  snapshot.settings.showCorrectAnswersAfterTest = true;
  app.locals.db.prepare("UPDATE attempts SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), start.data.id);
  const current = (await student.request(path)).data;
  assert.equal(current.settings.showCorrectAnswersAfterTest, false);
  assert.equal(current.review, undefined);
  assertNoSecrets(current);
});

test("post-test answer disclosure accepts boolean settings and rejects truthy substitutes", async (t) => {
  const { administrator } = await fixture(t);
  const admin = await administrator();
  let quiz = await quizFor(admin);
  for (const enabled of [true, false]) {
    const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...quiz, settings: { ...quiz.settings, showCorrectAnswersAfterTest: enabled } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.showCorrectAnswersAfterTest, enabled);
    quiz = saved.data;
  }
  for (const value of [null, 0, 1, "true", "false", {}, []]) {
    const invalid = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
      method: "PUT", body: { ...quiz, settings: { ...quiz.settings, showCorrectAnswersAfterTest: value } },
    });
    assert.equal(invalid.status, 400, `Invalid setting ${JSON.stringify(value)} was accepted`);
  }
  const current = (await admin.request(`/api/admin/quizzes/${quiz.id}`)).data;
  assert.equal(current.settings.showCorrectAnswersAfterTest, false);
});
