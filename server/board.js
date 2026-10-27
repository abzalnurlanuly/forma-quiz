import { createHmac, timingSafeEqual } from "node:crypto";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { canonicalIp, hash, token, transaction } from "./db.js";
import { contentRevision, fail, isPublicBoardToken, newPublicBoardToken, normalizeSettings } from "./model.js";

const viewerCookie = "aq_board_viewer";
const now = () => new Date().toISOString();

export function maskBoardIp(value) {
  const address = canonicalIp(value);
  if (!address) return null;
  if (address.includes(".")) return `${address.split(".").slice(0, 2).join(".")}.*.*`;
  return `${address.split(":").slice(0, 3).map((part) => parseInt(part, 16).toString(16)).join(":")}::…`;
}

export const boardCodeFor = (secret, quizId, attemptId) => createHmac("sha256", secret)
  .update(`public-board-participant\0${quizId}\0${attemptId}`).digest("hex").slice(0, 12).toUpperCase();

const answered = (question, value) => {
  if (question.type === "content") return false;
  if (question.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (["single", "truefalse", "short"].includes(question.type)) return typeof value === "string" && !!value.trim();
  if (["multiple", "ordering"].includes(question.type)) return Array.isArray(value) && value.length > 0;
  return !!value && typeof value === "object" && Object.values(value).some((entry) => typeof entry === "string" && !!entry.trim());
};

// This projection is deliberately independent of admin/participant serializers.
// Never spread a stored row, question, feedback, or presence object into this DTO.
export function projectBoardParticipant(row, secret, instant = Date.now(), presentation = {}) {
  const snapshot = JSON.parse(row.snapshot);
  const answers = JSON.parse(row.answers);
  const checked = JSON.parse(row.checked || "{}");
  const boardCode = boardCodeFor(secret, row.quiz_id, row.id);
  const questions = snapshot.questions.map((question, index) => ({
    number: index + 1,
    answerable: question.type !== "content",
    answered: answered(question, Object.hasOwn(answers, question.id) ? answers[question.id] : undefined),
    current: row.current_question_id === question.id,
    checked: Object.hasOwn(checked, question.id),
  }));
  const current = questions.find((question) => question.current);
  const fresh = !!row.last_seen_at && instant - Date.parse(row.last_seen_at) < 35_000;
  const presenceStatus = row.status !== "active" ? "finished" : !fresh ? "offline"
    : row.presence_visibility === "hidden" || row.presence_focused === 0 ? "away" : "active";
  const elapsed = (Date.parse(row.finished_at || new Date(instant).toISOString()) - Date.parse(row.started_at)) / 1000;
  const participant = {
    boardCode,
    label: `Участник #${boardCode}`,
    maskedIp: maskBoardIp(row.ip),
    contentRevision: contentRevision(snapshot),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    durationSeconds: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0,
    questionCount: questions.length,
    answerableCount: questions.filter((question) => question.answerable).length,
    answeredCount: questions.filter((question) => question.answered).length,
    currentQuestionNumber: current?.number ?? null,
    presence: { status: presenceStatus, lastSeenAt: row.last_seen_at || null },
    questions,
  };
  if (presentation.showNames === true && typeof row.name === "string" && row.name.trim())
    participant.name = row.name;
  // Publish only aggregate, finalized grades. Stored result objects also contain
  // question outcomes, which must never be included in the public projection.
  if (presentation.showScores === true && ["submitted", "expired"].includes(row.status) && row.result) {
    let result;
    try { result = JSON.parse(row.result); } catch { /* A malformed grade stays private. */ }
    if (result && [result.score, result.maxScore, result.percent].every(Number.isFinite)
      && result.score >= 0 && result.maxScore >= result.score && result.percent >= 0 && result.percent <= 100)
      Object.assign(participant, { score: result.score, maxScore: result.maxScore, percent: result.percent });
  }
  return participant;
}

export function mountPublicBoard(app, { db, auth, getQuiz, expire, notifyQuiz, cookieOptions, ipAddress }) {
  const clients = new Set();
  const pending = new Map();
  const secret = db.prepare("SELECT value FROM private_config WHERE key = 'public_board_secret'").get().value;
  const enabled = (quiz) => quiz?.settings?.publicBoardEnabled === true && isPublicBoardToken(quiz.publicBoardToken);
  const byId = (id) => {
    const row = db.prepare("SELECT doc FROM quizzes WHERE id = ?").get(id);
    return row ? JSON.parse(row.doc) : null;
  };
  const byCode = (code) => {
    if (!isPublicBoardToken(code)) fail(404, "Табло недоступно.");
    const row = db.prepare("SELECT doc FROM quizzes WHERE json_extract(doc, '$.publicBoardToken') = ? LIMIT 1").get(code);
    const quiz = row ? JSON.parse(row.doc) : null;
    if (!enabled(quiz)) fail(404, "Табло недоступно.");
    return quiz;
  };
  const validClient = (client, quiz) => enabled(quiz) && quiz.publicBoardToken === client.code;
  const send = (client, event, data) => {
    if (client.res.destroyed || client.res.writableEnded) {
      clients.delete(client);
      return;
    }
    if (client.res.writableLength > 65536) {
      clients.delete(client);
      client.res.destroy();
      return;
    }
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const revoke = (client) => {
    send(client, "revoked", { reason: "unavailable" });
    client.res.end();
    clients.delete(client);
  };
  const flush = (quizId) => {
    pending.delete(quizId);
    const quiz = byId(quizId);
    for (const client of clients) if (client.quizId === quizId) {
      if (!validClient(client, quiz)) revoke(client);
      else send(client, "update", { serverNow: now() });
    }
  };
  const notify = (quizId) => {
    const scoped = [...clients].filter((client) => client.quizId === quizId);
    if (!scoped.length) return;
    const quiz = byId(quizId);
    for (const client of scoped) if (!validClient(client, quiz)) revoke(client);
    if (scoped.some((client) => clients.has(client)) && !pending.has(quizId)) {
      const timer = setTimeout(() => flush(quizId), 500);
      timer.unref();
      pending.set(quizId, timer);
    }
  };
  const viewerSignature = (value) => createHmac("sha256", secret).update(`public-board-viewer\0${value}`).digest("base64url");
  const identifyViewer = (req, res, next) => {
    const value = req.cookies[viewerCookie];
    const parts = typeof value === "string" ? /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
    if (parts && timingSafeEqual(Buffer.from(parts[2]), Buffer.from(viewerSignature(parts[1]))))
      req.boardViewerKey = hash(parts[1]);
    next();
  };
  // Only cookie bootstrap shares an address budget. Once signed, a classroom's
  // viewers have separate request budgets; forged opaque cookies cannot reset it.
  const bootstrapLimit = rateLimit({
    windowMs: 10 * 60_000, limit: 60, skip: (req) => !!req.boardViewerKey,
    keyGenerator: (req) => ipKeyGenerator(ipAddress(req)),
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Слишком много новых подключений к табло. Подождите несколько минут." },
  });
  const issueViewer = (req, res, next) => {
    if (!req.boardViewerKey) {
      const value = token();
      req.boardViewerKey = hash(value);
      res.cookie(viewerCookie, `${value}.${viewerSignature(value)}`, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 });
    }
    next();
  };
  const boardLimit = rateLimit({
    windowMs: 60_000, limit: 180,
    keyGenerator: (req) => req.boardViewerKey || `bootstrap:${hash(ipKeyGenerator(ipAddress(req)))}`,
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Слишком много запросов к табло. Подождите минуту." },
  });
  const resolveBoard = (req, res, next) => {
    req.publicBoardQuiz = byCode(req.params.code);
    next();
  };
  // Unknown capabilities never mint signed identities. Existing signed viewers
  // still spend their own quota before any capability lookup, including failures.
  const publicGuards = [identifyViewer, bootstrapLimit, boardLimit, resolveBoard, issueViewer];
  app.get("/api/public/boards/:code", ...publicGuards, (req, res) => {
    const quiz = req.publicBoardQuiz;
    const instant = Date.now();
    const settings = normalizeSettings(quiz.settings);
    const presentation = { showNames: settings.publicBoardShowNames, showScores: settings.publicBoardShowScores && settings.showScore !== false };
    const participants = db.prepare("SELECT * FROM attempts WHERE quiz_id = ? ORDER BY started_at DESC, id").all(quiz.id)
      .map(expire).map((row) => projectBoardParticipant(row, secret, instant, presentation));
    const count = (status) => participants.filter((participant) => participant.status === status).length;
    const present = (status) => participants.filter((participant) => participant.presence.status === status).length;
    res.json({
      title: quiz.title, status: quiz.status, serverNow: new Date(instant).toISOString(),
      joinPath: quiz.status === "draft" ? null : `/q/${quiz.slug}`,
      presentation,
      summary: {
        total: participants.length, active: count("active"), submitted: count("submitted"),
        expired: count("expired"), invalidated: count("invalidated"),
        online: present("active"), away: present("away"), offline: present("offline"),
      },
      participants,
    });
  });
  app.get("/api/public/boards/:code/live", ...publicGuards, (req, res) => {
    const quiz = req.publicBoardQuiz;
    if (clients.size >= 512 || [...clients].filter((client) => client.quizId === quiz.id).length >= 64
      || [...clients].filter((client) => client.viewerKey === req.boardViewerKey).length >= 4)
      fail(429, "Слишком много подключений к табло.");
    res.status(200).set({
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const client = { res, quizId: quiz.id, code: req.params.code, viewerKey: req.boardViewerKey };
    clients.add(client);
    res.on("close", () => clients.delete(client));
    res.write("retry: 3000\n\n");
    send(client, "ready", { serverNow: now() });
  });
  app.post("/api/admin/quizzes/:id/board/rotate", auth, (req, res) => {
    const publicBoardToken = transaction(db, () => {
      const quiz = getQuiz(req.params.id);
      if (quiz.settings.publicBoardEnabled !== true) fail(409, "Сначала включите публичное табло.");
      const previous = quiz.publicBoardToken;
      do { quiz.publicBoardToken = newPublicBoardToken(); } while (quiz.publicBoardToken === previous || db.prepare(
        "SELECT 1 FROM quizzes WHERE id != ? AND json_extract(doc, '$.publicBoardToken') = ? LIMIT 1",
      ).get(quiz.id, quiz.publicBoardToken));
      quiz.updatedAt = now();
      db.prepare("UPDATE quizzes SET doc = ? WHERE id = ?").run(JSON.stringify(quiz), quiz.id);
      return quiz.publicBoardToken;
    });
    notifyQuiz(req.params.id);
    res.json({ publicBoardToken });
  });
  return {
    notify,
    ownCode(row, currentQuiz) {
      const quiz = currentQuiz || byId(row.quiz_id);
      return enabled(quiz) ? boardCodeFor(secret, row.quiz_id, row.id) : null;
    },
    keepalive() {
      const quizzes = new Map();
      for (const client of clients) {
        if (!quizzes.has(client.quizId)) quizzes.set(client.quizId, byId(client.quizId));
        if (!validClient(client, quizzes.get(client.quizId))) revoke(client);
        else send(client, "update", { serverNow: now() });
      }
    },
    close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}
