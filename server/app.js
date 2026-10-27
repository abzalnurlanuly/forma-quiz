import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  transaction,
  hash,
  token,
  passwordHash,
  passwordMatches,
  validCredentials,
  canonicalIp,
  addressKey,
} from "./db.js";
import {
  ApiError,
  fail,
  defaults,
  normalizeSettings,
  newQuiz,
  validateQuiz,
  normalizedName,
  snapshotQuiz,
  safeQuestion,
  validateAnswers,
  questionReview,
  canonicalAnswer,
  mergeLockedAnswers,
  calculateResult,
  contentRevision,
  normalizeSlugAliases,
  isPublicBoardToken,
  newPublicBoardToken,
} from "./model.js";
import { exportReport } from "./export.js";
import { imageDimensions } from "./media.js";
import { mountSurveyRoutes } from "./surveys.js";
import { mountPublicBoard } from "./board.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const date = () => new Date().toISOString();
const browserCookie = "aq_browser";
const adminCookie = "aq_admin";
const validToken = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value);
const safeEqual = (a, b) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export function createApp(options = {}) {
  const dataDir = resolve(
    options.dataDir || process.env.DATA_DIR || resolve(rootDir, "data"),
  );
  const appOrigin = new URL(
    options.appOrigin ||
      process.env.APP_ORIGIN ||
      "https://quiz.abzalnurlanuly.com",
  ).origin;
  const secureCookies =
    options.secureCookies ??
    (process.env.SECURE_COOKIES
      ? process.env.SECURE_COOKIES === "true"
      : appOrigin.startsWith("https://"));
  const allowSetup = options.allowSetup ?? process.env.ALLOW_SETUP === "true";
  const trustCloudflareIp =
    options.trustCloudflareIp ?? process.env.TRUST_CLOUDFLARE_IP === "true";
  const db = openDatabase(dataDir);
  const uploadsDir = resolve(dataDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const app = express();
  const liveClients = new Set();
  const presenceStates = new Map();
  let surveys = null;
  let boards = null;
  const notifyChange = (change) => {
    for (const client of liveClients) {
      if (!db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(client.sessionHash, date())) {
        client.res.end();
        liveClients.delete(client);
      } else client.res.write(`event: update\ndata: ${JSON.stringify(change)}\n\n`);
    }
  };
  const notifyQuiz = (quizId) => {
    notifyChange({ quizId });
    boards?.notify(quizId);
  };
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: secureCookies ? [] : null,
        },
      },
      strictTransportSecurity: secureCookies
        ? { maxAge: 31536000, includeSubDomains: false }
        : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use((req, res, next) => {
    res.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  app.use(cookieParser());
  const ipAddress = (req) =>
    canonicalIp(trustCloudflareIp && isIP(req.get("CF-Connecting-IP") || "")
      ? req.get("CF-Connecting-IP")
      : req.socket.remoteAddress || "") || "";
  const participantIp = (req) => trustCloudflareIp
    ? (isIP(req.get("CF-Connecting-IP") || "") ? canonicalIp(req.get("CF-Connecting-IP")) : null)
    : canonicalIp(req.socket.remoteAddress || "");
  // The tunnel shares one socket address across the class. Once an opaque browser cookie
  // exists, use its hash to avoid throttling the entire class as a single participant.
  const rateKey = (req) => {
    if (validToken(req.cookies[browserCookie]))
      return `browser:${hash(req.cookies[browserCookie])}`;
    // Anonymous surveys already have an opaque resume credential. Use it to
    // avoid sharing the whole classroom's request budget behind one NAT.
    const access = Object.entries(req.cookies).find(([name, value]) =>
      /^aq_survey_[a-f0-9-]{36}$/.test(name) && validToken(value));
    return access ? `survey:${hash(access[1])}` : `ip:${ipKeyGenerator(ipAddress(req))}`;
  };
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Quiz-Request") !== "1")
        return res
          .status(403)
          .json({ error: "Запрос не прошёл проверку CSRF." });
      const origin = req.get("Origin");
      if (origin && origin !== appOrigin)
        return res
          .status(403)
          .json({ error: "Недопустимый источник запроса." });
      const hasBody =
        Number(req.get("Content-Length") || 0) > 0 ||
        !!req.get("Transfer-Encoding");
      if (hasBody && !req.is("application/json"))
        return res.status(415).json({ error: "Ожидается application/json." });
    }
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      keyGenerator: rateKey,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (req) => /^\/public\/boards\/[^/]+(?:\/live)?\/?$/.test(req.path),
      message: { error: "Слишком много запросов. Подождите минуту." },
    }),
  );
  app.use(express.json({ limit: "5mb", strict: true }));
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
  };
  const browserHash = (req, res) => {
    if (!req.browserHash) {
      let value = req.cookies[browserCookie];
      if (!validToken(value)) {
        value = token();
        res.cookie(browserCookie, value, {
          ...cookieOptions,
          maxAge: 400 * 24 * 60 * 60 * 1000,
        });
      }
      req.browserHash = hash(value);
    }
    return req.browserHash;
  };
  const getQuiz = (id) => {
    const row = db.prepare("SELECT doc FROM quizzes WHERE id = ?").get(id);
    if (!row) fail(404, "Квиз не найден.");
    const quiz = JSON.parse(row.doc);
    quiz.settings = normalizeSettings(quiz.settings);
    quiz.publicBoardToken = quiz.settings.publicBoardEnabled && isPublicBoardToken(quiz.publicBoardToken) ? quiz.publicBoardToken : null;
    quiz.contentRevision = contentRevision(quiz);
    quiz.slugAliases = normalizeSlugAliases(quiz);
    return quiz;
  };
  const getQuizSlug = (slug) => {
    const row = db.prepare("SELECT doc FROM quizzes WHERE slug = ?").get(slug) || db.prepare(
      "SELECT q.doc FROM quizzes q WHERE EXISTS (SELECT 1 FROM json_each(q.doc, '$.slugAliases') alias WHERE alias.value = ?) LIMIT 1",
    ).get(slug);
    if (!row) fail(404, "Квиз не найден.");
    const quiz = JSON.parse(row.doc);
    quiz.settings = normalizeSettings(quiz.settings);
    quiz.publicBoardToken = quiz.settings.publicBoardEnabled && isPublicBoardToken(quiz.publicBoardToken) ? quiz.publicBoardToken : null;
    quiz.contentRevision = contentRevision(quiz);
    quiz.slugAliases = normalizeSlugAliases(quiz);
    return quiz;
  };
  const quizSlugTaken = (slug, quizId) => !!db.prepare(
    "SELECT 1 FROM quizzes q WHERE q.id != ? AND (q.slug = ? OR EXISTS (SELECT 1 FROM json_each(q.doc, '$.slugAliases') alias WHERE alias.value = ?)) LIMIT 1",
  ).get(quizId, slug, slug);
  const insertQuiz = (quiz) => transaction(db, () => {
    while (quizSlugTaken(quiz.slug, quiz.id)) quiz.slug = `quiz-${randomUUID().slice(0, 8)}`;
    db.prepare("INSERT INTO quizzes(id,slug,doc) VALUES(?,?,?)").run(quiz.id, quiz.slug, JSON.stringify(quiz));
  });
  const getAttempt = (id) =>
    db.prepare("SELECT * FROM attempts WHERE id = ?").get(id);
  const getBoundAttempt = (req, res) => {
    const row = getAttempt(req.params.id);
    if (!row || row.browser_hash !== browserHash(req, res))
      fail(404, "Попытка не найдена в этом браузере.");
    return expire(row);
  };
  const recordAction = (row, type, metadata = {}, eventId = randomUUID()) => {
    const now = date();
    db.prepare("INSERT OR IGNORE INTO events(attempt_id,event_id,type,created_at,counted,metadata) VALUES(?,?,?,?,0,?)")
      .run(row.id, eventId, type, now, JSON.stringify(metadata));
    db.prepare("UPDATE attempts SET last_action = ?, last_action_at = ? WHERE id = ?")
      .run(type, now, row.id);
  };
  const seen = (id) => db.prepare("UPDATE attempts SET last_seen_at = ? WHERE id = ? AND status = 'active'").run(date(), id);
  function presence(row) {
    const snapshot = JSON.parse(row.snapshot);
    const questions = snapshot.questions.filter((q) => q.type !== "content");
    const answers = JSON.parse(row.answers);
    const answeredCount = questions.filter((q) => {
      const answer = answers[q.id];
      if (["short", "single", "truefalse"].includes(q.type)) return typeof answer === "string" && !!answer.trim();
      if (q.type === "number") return typeof answer === "number" && Number.isFinite(answer);
      if (["multiple", "ordering"].includes(q.type)) return Array.isArray(answer) && answer.length > 0;
      return answer && typeof answer === "object" && Object.values(answer).some(Boolean);
    }).length;
    const fresh = !!row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 35_000;
    return {
      status: row.status !== "active" ? "finished" : !fresh ? "offline" : row.presence_visibility === "hidden" || row.presence_focused === 0 ? "away" : "active",
      lastSeenAt: row.last_seen_at || null,
      visibility: row.presence_visibility || null,
      focused: row.presence_focused === null || row.presence_focused === undefined ? null : !!row.presence_focused,
      questionId: row.current_question_id || null,
      questionNumber: row.current_question_id ? snapshot.questions.findIndex((q) => q.id === row.current_question_id) + 1 || null : null,
      answeredCount,
      totalQuestions: questions.length,
      lastAction: row.last_action || null,
      lastActionAt: row.last_action_at || null,
    };
  }
  function finalize(row, status, finishedAt = date()) {
    if (row.status !== "active") return row;
    const result = calculateResult(
      JSON.parse(row.snapshot),
      JSON.parse(row.answers),
      status === "invalidated",
    );
    db.prepare(
      "UPDATE attempts SET status = ?, finished_at = ?, result = ? WHERE id = ? AND status = ?",
    ).run(status, finishedAt, JSON.stringify(result), row.id, "active");
    recordAction(row, status);
    notifyQuiz(row.quiz_id);
    return getAttempt(row.id);
  }
  function expire(row) {
    if (row?.status === "active" && row.expires_at && row.expires_at <= date())
      return finalize(row, "expired", row.expires_at);
    return row;
  }
  function sweep() {
    transaction(db, () => {
      for (const row of db
        .prepare(
          "SELECT * FROM attempts WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
        )
        .all(date()))
        expire(row);
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(date());
      db.prepare(
        "DELETE FROM login_limits WHERE window_start < ? AND blocked_until < ?",
      ).run(Date.now() - 86_400_000, Date.now());
      const active = db.prepare("SELECT * FROM attempts WHERE status = 'active'").all();
      const ids = new Set(active.map((row) => row.id));
      for (const id of presenceStates.keys()) if (!ids.has(id)) presenceStates.delete(id);
      for (const row of active) {
        const state = presence(row).status;
        if (presenceStates.has(row.id) && presenceStates.get(row.id) !== state) notifyQuiz(row.quiz_id);
        presenceStates.set(row.id, state);
      }
      surveys?.sweep();
    });
  }
  function participant(row) {
    const snapshot = JSON.parse(row.snapshot);
    snapshot.settings = normalizeSettings(snapshot.settings);
    const currentQuiz = getQuiz(row.quiz_id);
    const boardCode = boards?.ownCode(row, currentQuiz);
    snapshot.settings.publicBoardEnabled = !!boardCode;
    // Post-test answer disclosure is a current publishing permission, independent
    // of the frozen grading snapshot. Missing legacy settings default to hidden.
    if (row.status !== "active")
      snapshot.settings.showCorrectAnswersAfterTest =
        currentQuiz.settings.showCorrectAnswersAfterTest === true;
    const result = {
      id: row.id,
      quizId: row.quiz_id,
      contentRevision: contentRevision(snapshot),
      title: snapshot.title,
      ...(boardCode ? { boardCode } : {}),
      status: row.status,
      name: row.name,
      group: row.group_name,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      finishedAt: row.finished_at,
      warnings: row.warnings,
      retakeGranted: !!row.retake_granted,
      maxWarnings: snapshot.settings.maxWarnings,
      answers: JSON.parse(row.answers),
      questions: snapshot.questions.map(safeQuestion),
      settings: snapshot.settings,
      presence: presence(row),
    };
    if (row.status !== "active" && snapshot.settings.showScore !== false) {
      const { score, maxScore, percent } = JSON.parse(row.result);
      Object.assign(result, { score, maxScore, percent });
    }
    if (snapshot.settings.showScore !== false) {
      if (
        row.status === "active" &&
        snapshot.settings.feedbackMode === "immediate"
      )
        result.feedback = JSON.parse(row.checked || "{}");
      else if (
        ["submitted", "expired"].includes(row.status) &&
        snapshot.settings.showCorrectAnswersAfterTest === true
      )
        result.review = snapshot.questions
          .filter((question) => question.type !== "content")
          .map((question) =>
            questionReview(question, result.answers[question.id]),
          );
    }
    return result;
  }
  const auth = (req, res, next) => {
    const value = req.cookies[adminCookie];
    if (validToken(value)) {
      const session = db
        .prepare(
          "SELECT admin_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
        )
        .get(hash(value), date());
      if (session) {
        req.adminId = session.admin_id;
        req.sessionHash = hash(value);
        return next();
      }
    }
    res.status(401).json({ error: "Войдите в панель администратора." });
  };
  app.locals.db = db;
  app.locals.sweep = sweep;
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      console.error("Quiz expiry sweep failed:", error.message);
    }
  }, 15_000);
  sweeper.unref();
  app.locals.closeLive = () => {
    for (const client of liveClients) client.res.end();
    liveClients.clear();
    boards?.close();
  };
  app.locals.close = () => {
    clearInterval(sweeper);
    clearInterval(liveKeepalive);
    app.locals.closeLive();
    db.close();
  };
  const liveKeepalive = setInterval(() => {
    boards?.keepalive();
    for (const client of liveClients) {
      const valid = db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(client.sessionHash, date());
      if (!valid) {
        client.res.end();
        liveClients.delete(client);
      } else client.res.write(": keepalive\n\n");
    }
  }, 15_000);
  liveKeepalive.unref();

  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/api/auth/status", (req, res) => {
    const value = req.cookies[adminCookie];
    const authenticated =
      validToken(value) &&
      !!db
        .prepare(
          "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?",
        )
        .get(hash(value), date());
    res.json({
      authenticated: !!authenticated,
      setupRequired:
        allowSetup && !db.prepare("SELECT 1 FROM admins LIMIT 1").get(),
    });
  });
  app.post("/api/auth/setup", async (req, res) => {
    if (!allowSetup || db.prepare("SELECT 1 FROM admins LIMIT 1").get())
      fail(
        403,
        "Первичная настройка через веб отключена. Используйте admin:create.",
      );
    const { username, password } = req.body || {};
    if (!validCredentials(username, password))
      fail(
        400,
        "Логин: 3–64 латинских символа, цифры, ._-; пароль: 12–128 символов.",
      );
    const stored = await passwordHash(password);
    transaction(db, () => {
      if (db.prepare("SELECT 1 FROM admins LIMIT 1").get())
        fail(409, "Администратор уже создан.");
      db.prepare(
        "INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)",
      ).run(randomUUID(), username, stored, date());
    });
    res.json({ ok: true });
  });
  function loginKeys(req, username) {
    return [
      hash(`ip:${ipAddress(req)}`),
      hash(`name:${username.toLowerCase()}`),
    ];
  }
  function checkLogin(keys) {
    for (const key of keys) {
      const state = db
        .prepare("SELECT * FROM login_limits WHERE key = ?")
        .get(key);
      if (state && state.blocked_until > Date.now())
        fail(429, "Слишком много попыток входа. Повторите через 15 минут.");
    }
  }
  function failedLogin(keys) {
    const now = Date.now();
    transaction(db, () => {
      for (const [index, key] of keys.entries()) {
        const old = db
          .prepare("SELECT * FROM login_limits WHERE key = ?")
          .get(key);
        const failures =
          old && now - old.window_start < 900_000 ? old.failures + 1 : 1;
        const windowStart =
          old && now - old.window_start < 900_000 ? old.window_start : now;
        db.prepare(
          "INSERT OR REPLACE INTO login_limits(key,failures,window_start,blocked_until) VALUES(?,?,?,?)",
        ).run(
          key,
          failures,
          windowStart,
          failures >= (index ? 20 : 10) ? now + 900_000 : 0,
        );
      }
    });
  }
  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      username.length > 64 ||
      typeof password !== "string" ||
      password.length > 128
    )
      fail(400, "Некорректные данные входа.");
    const keys = loginKeys(req, username);
    checkLogin(keys);
    const admin = db
      .prepare("SELECT * FROM admins WHERE username = ? COLLATE NOCASE")
      .get(username);
    const matched = await passwordMatches(
      password,
      admin?.password_hash ||
        `scrypt$32768$8$3$${"0".repeat(32)}$${"0".repeat(128)}`,
    );
    if (!admin || !matched) {
      failedLogin(keys);
      fail(401, "Неверный логин или пароль.");
    }
    let credentialVersion = admin.password_hash;
    if (!admin.password_hash.startsWith("scrypt$32768$8$3$")) {
      const upgraded = await passwordHash(password);
      const update = db
        .prepare(
          "UPDATE admins SET password_hash = ? WHERE id = ? AND password_hash = ?",
        )
        .run(upgraded, admin.id, admin.password_hash);
      if (!update.changes) fail(401, "Пароль был изменён. Войдите заново.");
      credentialVersion = upgraded;
    }
    checkLogin(keys);
    const value = token();
    transaction(db, () => {
      // A concurrent CLI password reset revokes both existing and in-flight logins.
      const currentAdmin = db
        .prepare("SELECT password_hash FROM admins WHERE id = ?")
        .get(admin.id);
      if (!currentAdmin || currentAdmin.password_hash !== credentialVersion)
        fail(401, "Пароль был изменён. Войдите заново.");
      // Regenerate a session on every successful login and remove the current cookie's old session.
      if (validToken(req.cookies[adminCookie]))
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
          hash(req.cookies[adminCookie]),
        );
      db.prepare("DELETE FROM login_limits WHERE key IN (?,?)").run(...keys);
      db.prepare(
        "INSERT INTO sessions(token_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)",
      ).run(
        hash(value),
        admin.id,
        new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        date(),
      );
    });
    res.cookie(adminCookie, value, {
      ...cookieOptions,
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });
  app.post("/api/auth/logout", (req, res) => {
    if (validToken(req.cookies[adminCookie])) {
      const sessionHash = hash(req.cookies[adminCookie]);
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
        sessionHash,
      );
      for (const client of liveClients) if (client.sessionHash === sessionHash) {
        client.res.end();
        liveClients.delete(client);
      }
    }
    res.clearCookie(adminCookie, cookieOptions).json({ ok: true });
  });

  app.use("/api/admin", auth);
  app.get("/api/admin/monitoring", (req, res) => {
    const quizParticipants = db.prepare("SELECT a.*,q.doc AS quiz_doc FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE a.status = 'active' ORDER BY a.started_at DESC").all().map((row) => {
      const current = expire(row);
      const quiz = JSON.parse(row.quiz_doc);
      return { kind: "quiz", id: row.id, attemptId: row.id, quizId: row.quiz_id, title: quiz.title, slug: quiz.slug,
        contentRevision: contentRevision(JSON.parse(current.snapshot)),
        name: row.name, group: row.group_name, status: current.status, startedAt: row.started_at, expiresAt: row.expires_at, finishedAt: current.finished_at,
        warnings: row.warnings, presence: presence(current) };
    }).filter((row) => row.status === "active");
    const participants = [...quizParticipants, ...(surveys?.monitoring() || [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    res.json({ participants, summary: {
      active: participants.length,
      online: participants.filter((row) => row.presence.status === "active").length,
      away: participants.filter((row) => row.presence.status === "away").length,
      offline: participants.filter((row) => row.presence.status === "offline").length,
    } });
  });
  app.get("/api/admin/live", (req, res) => {
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("event: ready\ndata: {\"connected\":true}\n\n");
    const client = { res, sessionHash: req.sessionHash };
    liveClients.add(client);
    res.on("close", () => liveClients.delete(client));
  });
  app.get("/api/admin/quizzes", (req, res) => {
    const quizzes = db
      .prepare(
        "SELECT q.doc, COUNT(a.id) AS attempt_count FROM quizzes q LEFT JOIN attempts a ON a.quiz_id=q.id GROUP BY q.id",
      )
      .all()
      .map((row) => {
        const q = JSON.parse(row.doc);
        const active = db.prepare("SELECT * FROM attempts WHERE quiz_id = ? AND status = 'active'").all(q.id).map(expire).filter((a) => a.status === "active");
        return {
          id: q.id,
          slug: q.slug,
          title: q.title,
          description: q.description,
          status: q.status,
          contentRevision: contentRevision(q),
          settings: normalizeSettings(q.settings),
          publicBoardToken: q.settings?.publicBoardEnabled === true && isPublicBoardToken(q.publicBoardToken) ? q.publicBoardToken : null,
          questionCount: q.questions.filter((q) => q.type !== "content").length,
          attemptCount: row.attempt_count,
          activeCount: active.length,
          onlineCount: active.filter((a) => presence(a).status === "active").length,
          createdAt: q.createdAt,
          updatedAt: q.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ quizzes });
  });
  app.post("/api/admin/quizzes", (req, res) => {
    const quiz = newQuiz(req.body?.title);
    insertQuiz(quiz);
    notifyQuiz(quiz.id);
    res.status(201).json({ ...quiz, attemptCount: 0 });
  });
  app.get("/api/admin/quizzes/:id", (req, res) => {
    const q = getQuiz(req.params.id);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE quiz_id = ?")
      .get(q.id).n;
    res.json({ ...q, attemptCount: count });
  });
  app.put("/api/admin/quizzes/:id", (req, res) => {
    const result = transaction(db, () => {
      const old = getQuiz(req.params.id);
      const quiz = validateQuiz(req.body, old);
      while (quiz.publicBoardToken && db.prepare(
        "SELECT 1 FROM quizzes WHERE id != ? AND json_extract(doc, '$.publicBoardToken') = ? LIMIT 1",
      ).get(quiz.id, quiz.publicBoardToken)) quiz.publicBoardToken = newPublicBoardToken();
      for (const q of quiz.questions)
        if (q.image && !existsSync(resolve(dataDir, `.${q.image}`)))
          fail(400, "Загруженное изображение не найдено.");
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM attempts WHERE quiz_id = ?")
        .get(old.id).n;
      if (quizSlugTaken(quiz.slug, quiz.id))
        fail(409, "Такая ссылка уже используется.");
      db.prepare("UPDATE quizzes SET slug = ?, doc = ? WHERE id = ?").run(
        quiz.slug,
        JSON.stringify(quiz),
        quiz.id,
      );
      // Apply current settings to live attempts without reshuffling questions or
      // changing finalized snapshots/results. Expired attempts cannot be revived.
      for (const row of db.prepare("SELECT * FROM attempts WHERE quiz_id = ? AND status = 'active'").all(quiz.id)) {
        const current = expire(row);
        if (current.status !== "active") continue;
        const snapshot = JSON.parse(current.snapshot);
        snapshot.settings = { ...quiz.settings };
        const limits = [
          quiz.settings.deadline,
          quiz.settings.timeLimitMinutes
            ? new Date(Date.parse(current.started_at) + quiz.settings.timeLimitMinutes * 60_000).toISOString()
            : null,
        ].filter(Boolean);
        const expiresAt = limits.length ? limits.sort()[0] : null;
        db.prepare("UPDATE attempts SET snapshot = ?, expires_at = ? WHERE id = ? AND status = 'active'")
          .run(JSON.stringify(snapshot), expiresAt, current.id);
        expire(getAttempt(current.id));
      }
      return { ...quiz, attemptCount: count };
    });
    notifyQuiz(result.id);
    res.json(result);
  });
  app.post("/api/admin/quizzes/:id/clone", (req, res) => {
    const old = getQuiz(req.params.id);
    const quiz = {
      ...structuredClone(old),
      ...newQuiz(`${old.title} — копия`),
      description: old.description,
      intro: old.intro,
      outro: old.outro,
      settings: { ...old.settings, deadline: null, publicBoardEnabled: false },
      questions: structuredClone(old.questions),
      groups: structuredClone(old.groups),
    };
    // IDs are local to a quiz, but fresh IDs make exports and future editing unambiguous.
    quiz.questions = quiz.questions.map((q) => {
      const optionIds = new Map(q.options.map((o) => [o.id, q.type === "truefalse" ? o.id : randomUUID()]));
      return {
        ...q,
        id: randomUUID(),
        options: q.options.map((o) => ({ ...o, id: optionIds.get(o.id) })),
        correct: Array.isArray(q.correct)
          ? q.correct.map((key) => optionIds.get(key) || key)
          : q.correct,
        pairs: q.pairs.map((p) => ({ ...p, id: randomUUID() })),
      };
    });
    quiz.groups = quiz.groups.map((g) => ({
      ...g,
      id: randomUUID(),
      students: g.students.map((s) => ({ ...s, id: randomUUID() })),
    }));
    insertQuiz(quiz);
    notifyQuiz(quiz.id);
    res.status(201).json({ ...quiz, attemptCount: 0 });
  });
  app.delete("/api/admin/quizzes/:id", (req, res) => {
    const quiz = getQuiz(req.params.id);
    if (quiz.status === "published")
      fail(409, "Закройте квиз перед удалением.");
    db.prepare("DELETE FROM quizzes WHERE id = ?").run(quiz.id);
    notifyQuiz(quiz.id);
    res.json({ ok: true });
  });
  app.post("/api/admin/uploads", (req, res) => {
    const data = req.body?.data;
    if (typeof data !== "string")
      fail(400, "Ожидается изображение в формате data URL.");
    const match =
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        data,
      );
    if (!match || match[2].length % 4 !== 0)
      fail(400, "Допустимы только PNG, JPEG, WebP и GIF.");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 3 * 1024 * 1024)
      fail(413, "Изображение должно быть не больше 3 МБ.");
    const kind = match[1];
    const dimensions = imageDimensions(bytes, kind);
    if (!dimensions)
      fail(400, "Содержимое файла не соответствует формату изображения.");
    const [width, height] = dimensions;
    if (
      !width ||
      !height ||
      width > 12000 ||
      height > 12000 ||
      width * height > 40_000_000
    )
      fail(
        400,
        "Изображение слишком большое по разрешению (до 12 000 px по стороне и 40 Мп).",
      );
    const filename = `${randomUUID()}.${kind === "jpeg" ? "jpg" : kind}`;
    writeFileSync(resolve(uploadsDir, filename), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    res.status(201).json({ url: `/uploads/${filename}` });
  });

  function adminAttempt(row, { includeHistory = false } = {}) {
    const result = row.result ? JSON.parse(row.result) : {};
    const snapshot = JSON.parse(row.snapshot);
    return {
      id: row.id,
      contentRevision: contentRevision(snapshot),
      title: snapshot.title,
      questions: snapshot.questions,
      name: row.name,
      group: row.group_name,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
      warnings: row.warnings,
      retakeGranted: !!row.retake_granted,
      score: result.score ?? null,
      maxScore: result.maxScore ?? null,
      percent: result.percent ?? null,
      durationSeconds: Math.max(
        0,
        Math.round(
          (Date.parse(row.finished_at || date()) -
            Date.parse(row.started_at)) /
            1000,
        ),
      ),
      answers: JSON.parse(row.answers),
      presence: presence(row),
      ...(includeHistory ? { history: db.prepare("SELECT id,archived_at,doc FROM attempt_history WHERE attempt_id = ? ORDER BY archived_at").all(row.id)
        .map((revision) => {
          const archived = JSON.parse(revision.doc);
          return { ...archived, contentRevision: contentRevision(archived.snapshot), historyId: revision.id, archivedAt: revision.archived_at };
        }) } : {}),
      events: db
        .prepare(
          "SELECT type,created_at AS createdAt,counted,metadata FROM events WHERE attempt_id = ? ORDER BY id",
        )
        .all(row.id)
        .map((event) => ({
          ...event,
          metadata: JSON.parse(event.metadata || "{}"),
        })),
    };
  }

  function report(id, { includeHistory = false } = {}) {
    const quiz = getQuiz(id);
    const rows = db
      .prepare(
        "SELECT * FROM attempts WHERE quiz_id = ? ORDER BY started_at DESC",
      )
      .all(id)
      .map(expire);
    const attempts = rows.map((row) => adminAttempt(row, { includeHistory }));
    const results = new Map(rows.filter((row) => row.result).map((row) => [row.id, JSON.parse(row.result).questionResults]));
    const summarize = (items) => {
      const finalized = items.filter((a) => a.status !== "active");
      return {
        total: items.length,
        submitted: items.filter((a) => a.status === "submitted").length,
        expired: items.filter((a) => a.status === "expired").length,
        invalidated: items.filter((a) => a.status === "invalidated").length,
        active: items.filter((a) => a.status === "active").length,
        online: items.filter((a) => a.presence.status === "active").length,
        away: items.filter((a) => a.presence.status === "away").length,
        offline: items.filter((a) => a.presence.status === "offline").length,
        averagePercent: finalized.length
          ? Math.round(finalized.reduce((sum, a) => sum + (a.percent || 0), 0) / finalized.length * 100) / 100
          : 0,
      };
    };
    const currentRevision = contentRevision(quiz);
    const definitions = new Map([[currentRevision, { title: quiz.title, questions: quiz.questions }]]);
    const rowGroups = new Map([[currentRevision, []]]);
    const archivedCounts = new Map();
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot);
      const revision = contentRevision(snapshot);
      if (!definitions.has(revision)) definitions.set(revision, { title: snapshot.title, questions: snapshot.questions });
      if (!rowGroups.has(revision)) rowGroups.set(revision, []);
      rowGroups.get(revision).push(row);
    }
    if (includeHistory) for (const attempt of attempts) for (const archived of attempt.history || []) {
      if (!archived.snapshot) continue;
      const revision = contentRevision(archived.snapshot);
      if (!definitions.has(revision)) definitions.set(revision, {
        title: archived.snapshot.title, questions: archived.snapshot.questions,
      });
      if (!rowGroups.has(revision)) rowGroups.set(revision, []);
      archivedCounts.set(revision, (archivedCounts.get(revision) || 0) + 1);
    }
    const questionStatistics = (definition, scopedRows, revision) => definition
      .filter((q) => q.type !== "content")
      .map((q) => {
        let correct = 0,
          total = 0;
        for (const row of scopedRows) {
          const questionResults = results.get(row.id);
          if (!questionResults) continue;
          if (Object.hasOwn(questionResults, q.id)) {
            total++;
            if (questionResults[q.id]) correct++;
          }
        }
        return {
          id: q.id,
          contentRevision: revision,
          text: q.text,
          type: q.type,
          points: q.points,
          options: q.options,
          pairs: q.pairs,
          answerKey: q.correct,
          tolerance: q.tolerance,
          correct,
          total,
          percent: total ? Math.round((correct / total) * 10000) / 100 : 0,
        };
      });
    const currentAttempts = attempts.filter((attempt) => attempt.contentRevision === currentRevision);
    const currentSummary = summarize(currentAttempts);
    return {
      kind: "quiz",
      quiz: { id: quiz.id, title: quiz.title, contentRevision: currentRevision },
      summary: {
        ...summarize(attempts),
        averagePercent: currentSummary.averagePercent,
        questionsScope: "current_revision",
        questionsContentRevision: currentRevision,
        questionsAttemptCount: currentAttempts.length,
        questionsFinalizedCount: currentAttempts.filter((attempt) => attempt.status !== "active").length,
      },
      attempts,
      questions: questionStatistics(quiz.questions, rowGroups.get(currentRevision), currentRevision),
      revisions: [...definitions].sort(([a], [b]) => b - a).map(([revision, definition]) => ({
        contentRevision: revision,
        title: definition.title,
        questionDefinitions: definition.questions,
        questions: questionStatistics(definition.questions, rowGroups.get(revision), revision),
        summary: summarize(attempts.filter((attempt) => attempt.contentRevision === revision)),
        ...(includeHistory ? { archivedAttemptCount: archivedCounts.get(revision) || 0 } : {}),
      })),
    };
  }
  app.get("/api/admin/quizzes/:id/report", (req, res) =>
    res.json(report(req.params.id)),
  );
  app.get("/api/admin/quizzes/:id/attempts/:attemptId", (req, res) => {
    const quiz = getQuiz(req.params.id);
    const current = getAttempt(req.params.attemptId);
    if (!current || current.quiz_id !== quiz.id) fail(404, "Попытка не найдена.");
    const row = expire(current);
    const snapshot = JSON.parse(row.snapshot);
    const answers = JSON.parse(row.answers);
    const invalidated = row.status === "invalidated";
    res.json({
      quiz: { id: quiz.id, title: quiz.title, contentRevision: contentRevision(quiz) },
      attempt: {
        ...adminAttempt(row),
        questions: snapshot.questions,
        review: row.status === "active" ? [] : snapshot.questions
          .filter((question) => question.type !== "content")
          .map((question) => ({
            ...questionReview(question, Object.hasOwn(answers, question.id) ? answers[question.id] : undefined),
            ...(invalidated ? { correct: false, points: 0 } : {}),
          })),
      },
    });
  });
  app.post("/api/admin/quizzes/:id/attempts/:attemptId/retake", (req, res) => {
    const row = transaction(db, () => {
      getQuiz(req.params.id);
      const current = getAttempt(req.params.attemptId);
      if (!current || current.quiz_id !== req.params.id) fail(404, "Попытка не найдена.");
      if (current.status !== "invalidated") fail(409, "Повтор можно разрешить только для аннулированной попытки.");
      if (!current.retake_granted) {
        db.prepare("UPDATE attempts SET retake_granted = 1 WHERE id = ?").run(current.id);
        recordAction(current, "retake_granted");
      }
      return getAttempt(current.id);
    });
    notifyQuiz(row.quiz_id);
    res.json({ ok: true, attemptId: row.id, retakeGranted: true });
  });
  app.delete("/api/admin/quizzes/:id/attempts/:attemptId", (req, res) => {
    transaction(db, () => {
      getQuiz(req.params.id);
      const row = getAttempt(req.params.attemptId);
      if (!row || row.quiz_id !== req.params.id) fail(404, "Попытка не найдена.");
      db.prepare("DELETE FROM attempts WHERE id = ?").run(row.id);
      presenceStates.delete(row.id);
    });
    notifyQuiz(req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/admin/quizzes/:id/export.xlsx", async (req, res) => {
    const variant = req.query.variant ?? "public";
    if (!["public", "private"].includes(variant)) fail(400, "Неизвестный вариант экспорта.");
    const buffer = await exportReport(report(req.params.id, { includeHistory: variant === "private" }), { variant });
    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.set(
      "Content-Disposition",
      `attachment; filename="quiz-report-${req.params.id}-${variant}.xlsx"`,
    );
    res.send(buffer);
  });
  app.post("/api/admin/quizzes/:id/anonymize", (req, res) => {
    getQuiz(req.params.id);
    db.prepare(
      "UPDATE attempts SET ip = NULL, user_agent = NULL WHERE quiz_id = ?",
    ).run(req.params.id);
    notifyQuiz(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/public/quizzes/:slug", (req, res) => {
    const quiz = getQuizSlug(req.params.slug);
    if (quiz.status === "draft") fail(404, "Квиз ещё не опубликован.");
    const browser = browserHash(req, res);
    const own = db
      .prepare("SELECT * FROM attempts WHERE quiz_id = ? AND browser_hash = ?")
      .get(quiz.id, browser);
    const occupied = new Map(
      db
        .prepare(
          "SELECT student_id,status,retake_granted FROM attempts WHERE quiz_id = ? AND student_id IS NOT NULL",
        )
        .all(quiz.id)
        .map((a) => [a.student_id, a]),
    );
    res.json({
      id: quiz.id,
      slug: quiz.slug,
      title: quiz.title,
      description: quiz.description,
      intro: quiz.intro,
      outro: quiz.outro,
      status: quiz.status,
      contentRevision: contentRevision(quiz),
      settings: quiz.settings,
      questionCount: quiz.questions.filter((q) => q.type !== "content").length,
      groups: quiz.settings.rosterEnabled
        ? quiz.groups.map((g) => ({
            id: g.id,
            name: g.name,
            students: g.students.map((s) => {
              const attempt = occupied.get(s.id);
              const requiresRetakeCode = !!attempt && attempt.status === "invalidated" &&
                !!attempt.retake_granted && typeof s.code === "string" && s.code.length >= 6;
              return {
                id: s.id,
                name: s.name,
                available: !attempt || requiresRetakeCode,
                requiresRetakeCode,
              };
            }),
          }))
        : [],
      attempt: own ? participant(expire(own)) : null,
    });
  });
  const startLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 60,
    keyGenerator: rateKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много попыток начать квиз. Повторите позже." },
  });
  app.post("/api/public/quizzes/:slug/start", startLimit, (req, res) => {
    const browser = browserHash(req, res);
    let created = false;
    const attempt = transaction(db, () => {
      const quiz = getQuizSlug(req.params.slug);
      let existing = db
        .prepare(
          "SELECT * FROM attempts WHERE quiz_id = ? AND browser_hash = ?",
        )
        .get(quiz.id, browser);
      const {
        studentId,
        code,
        name: suppliedName,
        rulesAccepted,
        language = "ru",
      } = req.body || {};
      if (
        suppliedName !== undefined &&
        (typeof suppliedName !== "string" || suppliedName.length > 150)
      )
        fail(400, "Имя должно быть не длиннее 150 символов.");
      if (!existing && typeof studentId === "string") {
        const granted = db.prepare("SELECT * FROM attempts WHERE quiz_id = ? AND student_id = ? AND status = 'invalidated' AND retake_granted = 1").get(quiz.id, studentId);
        if (granted) {
          const student = quiz.groups.flatMap((group) => group.students).find((s) => s.id === studentId);
          // Moving a permission to another browser requires proof of identity,
          // even if normal starts do not currently require student codes.
          if (!student || typeof student.code !== "string" || student.code.length < 6 || typeof code !== "string" || !safeEqual(code.trim(), student.code))
            fail(403, "Для повтора в другом браузере нужен личный код студента.");
          existing = granted;
        }
      }
      const retake = existing?.status === "invalidated" && !!existing.retake_granted;
      if (existing) {
        // A bound browser may resume only its existing identity, never claim another student.
        if (
          (studentId && studentId !== existing.student_id) ||
          (!existing.student_id &&
            suppliedName &&
            normalizedName(suppliedName) !== normalizedName(existing.name))
        )
          fail(409, "Этот браузер уже привязан к другой попытке этого квиза.");
        if (!retake) return expire(existing);
      }
      if (quiz.status !== "published")
        fail(403, "Квиз закрыт для новых попыток.");
      if (quiz.settings.deadline && quiz.settings.deadline <= date())
        fail(403, "Срок прохождения квиза истёк.");
      // In tunnel mode, never mistake the shared proxy socket for a participant
      // when its trusted address header is missing or malformed.
      const ip = participantIp(req);
      const ipKey = addressKey(db, quiz.id, ip);
      if (quiz.settings.oneAttemptPerIp) {
        if (!ipKey) fail(400, "Не удалось определить IP-адрес для проверки ограничения.");
        if (!retake && db.prepare("SELECT 1 FROM attempts WHERE quiz_id = ? AND ip_key = ? UNION ALL SELECT 1 FROM attempt_history WHERE quiz_id = ? AND ip_key = ? LIMIT 1").get(quiz.id, ipKey, quiz.id, ipKey))
          fail(409, "С этого IP-адреса уже начали или завершили квиз. Разрешена только одна попытка.");
      }
      if (!["ru", "kk"].includes(language))
        fail(400, "Выберите поддерживаемый язык интерфейса.");
      if (quiz.settings.antiCheat && rulesAccepted !== true)
        fail(
          400,
          "Перед началом необходимо принять правила прохождения квиза.",
        );
      let name,
        groupName = "",
        student = null,
        identityKey = null;
      if (retake) {
        name = existing.name;
        groupName = existing.group_name;
        student = existing.student_id ? { id: existing.student_id } : null;
        identityKey = existing.identity_key;
      } else if (quiz.settings.rosterEnabled) {
        if (typeof studentId !== "string") fail(400, "Выберите студента.");
        for (const g of quiz.groups) {
          const found = g.students.find((s) => s.id === studentId);
          if (found) {
            student = found;
            groupName = g.name;
            break;
          }
        }
        if (!student) fail(400, "Студент не найден.");
        if (
          quiz.settings.requireStudentCode &&
          (typeof code !== "string" || !safeEqual(code.trim(), student.code))
        )
          fail(403, "Неверный личный код студента.");
        if (
          db
            .prepare(
              "SELECT 1 FROM attempts WHERE quiz_id = ? AND student_id = ?",
            )
            .get(quiz.id, student.id)
        )
          fail(409, "Студент уже начал или завершил квиз в другом браузере.");
        name = student.name;
      } else {
        name = (suppliedName || "")
          .normalize("NFKC")
          .trim()
          .replace(/\s+/gu, " ");
        if (quiz.settings.requireName && !name) fail(400, "Введите своё имя.");
        if (name) {
          identityKey = normalizedName(name);
          if (
            db
              .prepare(
                "SELECT 1 FROM attempts WHERE quiz_id = ? AND identity_key = ?",
              )
              .get(quiz.id, identityKey)
          )
            fail(
              409,
              "Это имя уже используется. Повторная попытка недоступна.",
            );
        } else name = "Участник";
      }
      const startedAt = date();
      const limits = [
        quiz.settings.deadline,
        quiz.settings.timeLimitMinutes
          ? new Date(
              Date.parse(startedAt) + quiz.settings.timeLimitMinutes * 60_000,
            ).toISOString()
          : null,
      ].filter(Boolean);
      const expiresAt = limits.length ? limits.sort()[0] : null;
      const attemptId = randomUUID();
      let history = [];
      if (retake) {
        history = db.prepare("SELECT * FROM attempt_history WHERE attempt_id = ?").all(existing.id);
        const events = db.prepare("SELECT type,created_at AS createdAt,counted,metadata FROM events WHERE attempt_id = ? ORDER BY id").all(existing.id)
          .map((event) => ({ ...event, metadata: JSON.parse(event.metadata || "{}") }));
        history.push({
          id: randomUUID(), quiz_id: quiz.id, ip_key: existing.ip_key, archived_at: startedAt,
          doc: JSON.stringify({
            id: existing.id, status: existing.status, startedAt: existing.started_at,
            expiresAt: existing.expires_at, finishedAt: existing.finished_at,
            warnings: existing.warnings, snapshot: JSON.parse(existing.snapshot),
            answers: JSON.parse(existing.answers), checked: JSON.parse(existing.checked || "{}"),
            result: existing.result ? JSON.parse(existing.result) : null, events,
          }),
        });
        // New identity for every run makes delayed writes from the old tab fail.
        db.prepare("DELETE FROM attempts WHERE id = ?").run(existing.id);
        presenceStates.delete(existing.id);
      }
      db.prepare(
        `INSERT INTO attempts(id,quiz_id,browser_hash,student_id,identity_key,name,group_name,started_at,expires_at,snapshot,ip,user_agent,ip_key,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        attemptId,
        quiz.id,
        browser,
        student?.id || null,
        identityKey,
        name,
        groupName,
        startedAt,
        expiresAt,
        JSON.stringify(snapshotQuiz(quiz)),
        ip,
        (req.get("User-Agent") || "").slice(0, 500),
        ipKey,
        startedAt,
      );
      for (const revision of history)
        db.prepare("INSERT INTO attempt_history(id,attempt_id,quiz_id,archived_at,ip_key,doc) VALUES(?,?,?,?,?,?)")
          .run(revision.id, attemptId, revision.quiz_id, revision.archived_at, revision.ip_key, revision.doc);
      recordAction({ id: attemptId }, "start");
      if (retake) recordAction({ id: attemptId }, "retake_started", { previousAttemptId: existing.id, previousWarnings: existing.warnings });
      if (quiz.settings.antiCheat)
        db.prepare(
          "INSERT INTO events(attempt_id,event_id,type,created_at,counted,metadata) VALUES(?,?,?,?,0,?)",
        ).run(
          attemptId,
          randomUUID(),
          "rules_accepted",
          startedAt,
          JSON.stringify({ language }),
        );
      created = true;
      return getAttempt(attemptId);
    });
    notifyQuiz(attempt.quiz_id);
    res.status(created ? 201 : 200).json(participant(attempt));
  });
  app.get("/api/public/attempts/:id", (req, res) =>
    res.json(participant(getBoundAttempt(req, res))),
  );
  app.put("/api/public/attempts/:id/answers", (req, res) => {
    const attempt = transaction(db, () => {
      const row = getBoundAttempt(req, res);
      if (row.status !== "active") return { finalized: true };
      const answers = mergeLockedAnswers(
        row,
        req.body?.answers,
        JSON.parse(row.snapshot),
      );
      db.prepare(
        "UPDATE attempts SET answers = ? WHERE id = ? AND status = ?",
      ).run(JSON.stringify(answers), row.id, "active");
      seen(row.id);
      if (JSON.stringify(answers) !== row.answers) recordAction(row, "answers");
      return getAttempt(row.id);
    });
    if (attempt.finalized)
      fail(409, "Попытка завершена. Ответы больше не изменяются.");
    notifyQuiz(attempt.quiz_id);
    res.json(participant(attempt));
  });
  app.post("/api/public/attempts/:id/check", (req, res) => {
    const attempt = transaction(db, () => {
      const row = getBoundAttempt(req, res);
      if (row.status !== "active") return { finalized: true };
      const snapshot = JSON.parse(row.snapshot);
      const settings = normalizeSettings(snapshot.settings);
      if (settings.feedbackMode !== "immediate" || settings.showScore === false)
        fail(
          409,
          "Проверка ответа доступна только в режиме немедленного показа результатов.",
        );
      const { questionId, answer } = req.body || {};
      const question = snapshot.questions.find(
        (question) => question.id === questionId,
      );
      if (!question || question.type === "content")
        fail(400, "Выберите вопрос для проверки ответа.");
      const clean = validateAnswers({ [questionId]: answer }, snapshot);
      const checked = JSON.parse(row.checked || "{}");
      const saved = JSON.parse(row.answers);
      if (Object.hasOwn(checked, questionId)) {
        if (
          canonicalAnswer(question, saved[questionId]) !==
          canonicalAnswer(question, clean[questionId])
        )
          fail(409, "Ответ уже проверен и не может быть изменён.");
        seen(row.id);
        return getAttempt(row.id);
      }
      const answers = mergeLockedAnswers(row, clean, snapshot);
      Object.defineProperty(checked, questionId, {
        value: questionReview(question, answers[questionId]),
        enumerable: true,
      });
      db.prepare(
        "UPDATE attempts SET answers = ?, checked = ? WHERE id = ? AND status = ?",
      ).run(JSON.stringify(answers), JSON.stringify(checked), row.id, "active");
      seen(row.id);
      recordAction(row, "check", { questionId });
      return getAttempt(row.id);
    });
    if (attempt.finalized)
      fail(409, "Попытка завершена. Ответы больше не изменяются.");
    notifyQuiz(attempt.quiz_id);
    res.json(participant(attempt));
  });
  app.post("/api/public/attempts/:id/presence", (req, res) => {
    const { visibility, focused, questionId } = req.body || {};
    if (!["visible", "hidden"].includes(visibility) || typeof focused !== "boolean" ||
        (questionId !== undefined && questionId !== null && (typeof questionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(questionId))))
      fail(400, "Некорректный статус вкладки.");
    const attempt = transaction(db, () => {
      const row = getBoundAttempt(req, res);
      if (row.status !== "active") return row;
      const snapshot = JSON.parse(row.snapshot);
      if (questionId && !snapshot.questions.some((q) => q.id === questionId)) fail(400, "Вопрос не найден в этой попытке.");
      const currentQuestion = questionId === undefined ? row.current_question_id : questionId;
      const isFocused = focused && visibility === "visible";
      db.prepare("UPDATE attempts SET last_seen_at = ?, presence_visibility = ?, presence_focused = ?, current_question_id = ? WHERE id = ? AND status = 'active'")
        .run(date(), visibility, isFocused ? 1 : 0, currentQuestion || null, row.id);
      if (row.presence_visibility !== visibility || row.presence_focused !== Number(isFocused))
        recordAction(row, "presence", { visibility, focused: isFocused });
      if (currentQuestion && currentQuestion !== row.current_question_id)
        recordAction(row, "question", { questionId: currentQuestion });
      return getAttempt(row.id);
    });
    notifyQuiz(attempt.quiz_id);
    res.json(participant(attempt));
  });
  app.post("/api/public/attempts/:id/events", (req, res) => {
    const { type, eventId } = req.body || {};
    if (
      !["visibility", "blur", "paste", "fullscreen"].includes(type) ||
      typeof eventId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        eventId,
      )
    )
      fail(400, "Некорректное событие.");
    const attempt = transaction(db, () => {
      const row = getBoundAttempt(req, res);
      if (row.status !== "active") return row;
      const settings = JSON.parse(row.snapshot).settings;
      if (!settings.antiCheat || (type === "paste" && !settings.blockPaste))
        return row;
      if (
        db
          .prepare("SELECT 1 FROM events WHERE attempt_id = ? AND event_id = ?")
          .get(row.id, eventId)
      )
        return row;
      const now = date();
      // A browser coalesces a single transition into one incident UUID. Deduplication
      // by UUID preserves distinct violations when an offline queue is replayed quickly.
      db.prepare(
        "INSERT INTO events(attempt_id,event_id,type,created_at,counted) VALUES(?,?,?,?,1)",
      ).run(row.id, eventId, type, now);
      db.prepare(
        "UPDATE attempts SET warnings = warnings + 1, last_warning_at = ?, last_seen_at = ?, last_action = ?, last_action_at = ? WHERE id = ? AND status = ?",
      ).run(now, now, type, now, row.id, "active");
      const updated = getAttempt(row.id);
      if (updated.warnings >= settings.maxWarnings)
        return finalize(updated, "invalidated");
      return updated;
    });
    notifyQuiz(attempt.quiz_id);
    res.json(participant(attempt));
  });
  app.post("/api/public/attempts/:id/submit", (req, res) => {
    const attempt = transaction(db, () => {
      const row = getBoundAttempt(req, res);
      if (row.status !== "active") return row;
      if (req.body?.answers !== undefined) {
        const answers = mergeLockedAnswers(
          row,
          req.body.answers,
          JSON.parse(row.snapshot),
        );
        db.prepare(
          "UPDATE attempts SET answers = ? WHERE id = ? AND status = ?",
        ).run(JSON.stringify(answers), row.id, "active");
      }
      seen(row.id);
      return finalize(getAttempt(row.id), "submitted");
    });
    res.json(participant(attempt));
  });

  surveys = mountSurveyRoutes(app, {
    db, dataDir, auth, browserHash, cookieOptions, participantIp,
    notify: (surveyId) => notifyChange({ surveyId }), exportReport,
    startLimit,
  });
  boards = mountPublicBoard(app, { db, auth, getQuiz, expire, notifyQuiz, cookieOptions, ipAddress });

  app.use(
    "/uploads",
    (req, res, next) => {
      if (!/^\/[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(req.path))
        return res.status(404).end();
      res.set("Content-Disposition", "inline");
      next();
    },
    express.static(uploadsDir, {
      dotfiles: "deny",
      immutable: true,
      maxAge: "365d",
      fallthrough: false,
    }),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API маршрут не найден." }),
  );
  const distDir = options.distDir || resolve(rootDir, "dist");
  if (existsSync(resolve(distDir, "index.html"))) {
    app.use(express.static(distDir, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(resolve(distDir, "index.html"));
    });
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large")
      return res
        .status(413)
        .json({ error: "Слишком большой запрос (максимум 5 МБ)." });
    if (error instanceof SyntaxError && "body" in error)
      return res.status(400).json({ error: "Некорректный JSON." });
    if (error instanceof ApiError)
      return res.status(error.status).json({ error: error.message });
    if (error.status === 404)
      return res.status(404).json({ error: "Файл не найден." });
    console.error("Request failed:", error.message);
    res.status(500).json({ error: "Внутренняя ошибка сервера." });
  });
  if (
    (options.seedDemo ?? process.env.SEED_DEMO === "true") &&
    !db.prepare("SELECT 1 FROM quizzes LIMIT 1").get()
  ) {
    const quiz = newQuiz("Первый квиз: проверка знаний");
    quiz.slug = "welcome";
    quiz.description =
      "Короткий пример квиза. Создайте свою копию в панели администратора.";
    quiz.status = "published";
    quiz.questions = [
      {
        id: randomUUID(),
        type: "single",
        text: "Что означает HTTP?",
        image: null,
        points: 1,
        options: [
          { id: "a", text: "Hypertext Transfer Protocol" },
          { id: "b", text: "High Throughput Text Process" },
          { id: "c", text: "Host Transfer Terminal Protocol" },
        ],
        correct: ["a"],
        pairs: [],
      },
    ];
    db.prepare("INSERT INTO quizzes(id,slug,doc) VALUES(?,?,?)").run(
      quiz.id,
      quiz.slug,
      JSON.stringify(quiz),
    );
  }
  sweep();
  return app;
}
