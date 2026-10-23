import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";

export const origin = "http://localhost:3000";
export const password = "Correct-Horse-Quiz-2026!";

export async function fixture(t, opts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "forma-quiz-test-"));
  const app = createApp({
    dataDir,
    appOrigin: origin,
    secureCookies: false,
    allowSetup: true,
    seedDemo: false,
    ...opts,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    app.locals.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function browser() {
    const cookies = new Map();
    return {
      cookies,
      async events(path) {
        const controller = new AbortController();
        t.after(() => controller.abort());
        const response = await fetch(base + path, {
          headers: {
            Cookie: [...cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
          },
          signal: controller.signal,
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        return {
          close: () => controller.abort(),
          async next(name, matches = () => true) {
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
              while (true) {
                let end;
                while ((end = buffer.indexOf("\n\n")) !== -1) {
                  const lines = buffer.slice(0, end).split("\n");
                  buffer = buffer.slice(end + 2);
                  const event = lines.find((line) => line.startsWith("event:"))
                    ?.slice(6).trim();
                  const data = lines.filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim()).join("\n");
                  if (event !== name || !data) continue;
                  const parsed = JSON.parse(data);
                  if (matches(parsed)) return parsed;
                }
                const chunk = await reader.read();
                assert.equal(chunk.done, false, `SSE closed before ${name}`);
                buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
              }
            } finally {
              clearTimeout(timeout);
            }
          },
        };
      },
      async request(
        path,
        {
          method = "GET",
          body,
          headers = {},
          csrf = true,
          requestOrigin = origin,
        } = {},
      ) {
        const reqHeaders = { ...headers };
        if (cookies.size)
          reqHeaders.Cookie = [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
        if (!["GET", "HEAD"].includes(method)) {
          if (csrf) reqHeaders["X-Quiz-Request"] = "1";
          if (requestOrigin) reqHeaders.Origin = requestOrigin;
        }
        if (body !== undefined) reqHeaders["Content-Type"] = "application/json";
        const response = await fetch(base + path, {
          method,
          headers: reqHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const raw of response.headers.getSetCookie()) {
          const first = raw.split(";")[0];
          const equal = first.indexOf("=");
          const name = first.slice(0, equal);
          const value = first.slice(equal + 1);
          if (/max-age=0/i.test(raw) || !value) cookies.delete(name);
          else cookies.set(name, value);
        }
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("json")
          ? await response.json()
          : Buffer.from(await response.arrayBuffer());
        return { status: response.status, data, headers: response.headers };
      },
    };
  }

  async function administrator() {
    const admin = browser();
    const setup = await admin.request("/api/auth/setup", {
      method: "POST",
      body: { username: "teacher", password },
    });
    assert.equal(setup.status, 200, JSON.stringify(setup.data));
    const login = await admin.request("/api/auth/login", {
      method: "POST",
      body: { username: "teacher", password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return admin;
  }

  return { app, browser, administrator, dataDir };
}

export function questionSet() {
  const id = () => randomUUID();
  const single = {
    id: id(),
    type: "single",
    text: "Столица Казахстана?",
    points: 2,
    image: null,
    options: [
      { id: id(), text: "Астана" },
      { id: id(), text: "Алматы" },
    ],
  };
  single.correct = [single.options[0].id];
  const multiple = {
    id: id(),
    type: "multiple",
    text: "Выберите чётные числа",
    points: 3,
    image: null,
    options: [
      { id: id(), text: "2" },
      { id: id(), text: "3" },
      { id: id(), text: "4" },
    ],
  };
  multiple.correct = [multiple.options[0].id, multiple.options[2].id];
  const short = {
    id: id(),
    type: "short",
    text: "Напишите слово React",
    points: 2,
    image: null,
    correct: "React",
  };
  const matching = {
    id: id(),
    type: "matching",
    text: "Соедините страны и столицы",
    points: 3,
    image: null,
    pairs: [
      { id: id(), left: "Казахстан", right: "Астана" },
      { id: id(), left: "Франция", right: "Париж" },
    ],
  };
  const content = {
    id: id(),
    type: "content",
    text: "Информационная страница",
    points: 0,
    image: null,
  };
  return [single, multiple, short, matching, content];
}

export async function quizFor(admin, overrides = {}) {
  const created = await admin.request("/api/admin/quizzes", {
    method: "POST",
    body: { title: "Проверочный квиз" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const quiz = {
    ...created.data,
    title: "Проверочный квиз",
    description: "Проверка серверной логики",
    intro: "Удачи!",
    outro: "Спасибо!",
    questions: questionSet(),
    groups: [],
    status: "published",
    ...overrides,
  };
  quiz.settings = {
    requireName: true,
    rosterEnabled: false,
    requireStudentCode: true,
    timeLimitMinutes: 0,
    deadline: null,
    antiCheat: false,
    maxWarnings: 3,
    shuffleQuestions: true,
    shuffleOptions: true,
    showScore: true,
    blockPaste: false,
    ...created.data.settings,
    ...overrides.settings,
  };
  const saved = await admin.request(`/api/admin/quizzes/${quiz.id}`, {
    method: "PUT",
    body: quiz,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return saved.data;
}

export function correctAnswers(quiz) {
  const answers = {};
  for (const q of quiz.questions) {
    if (q.type === "single") answers[q.id] = q.correct[0];
    if (q.type === "multiple") answers[q.id] = [...q.correct];
    if (q.type === "short") answers[q.id] = q.correct;
    if (q.type === "matching")
      answers[q.id] = Object.fromEntries(q.pairs.map((p) => [p.id, p.right]));
  }
  return answers;
}

export function assertNoSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        "correct",
        "code",
        "password",
        "passwordHash",
        "snapshot",
        "answerKey",
      ].includes(key),
      `Public API leaked ${key}`,
    );
    assertNoSecrets(child);
  }
}
