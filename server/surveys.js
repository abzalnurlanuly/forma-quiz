import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fail, contentRevision, nextContentRevision, normalizeSlugAliases, nextSlugAliases } from "./model.js";
import { transaction, hash, token, addressKey } from "./db.js";

const now = () => new Date().toISOString();
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const validToken = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value);
export const surveyDefaults = {
  anonymous: true, collectName: false, collectIp: false, collectUserAgent: false,
  oneResponsePerIp: false, oneResponsePerBrowser: false, deadline: null,
};
export const surveyTheme = {
  backgroundColor: "#f5f5f5", surfaceColor: "#ffffff", accentColor: "#111111",
  textColor: "#111111", logo: null, cover: null, font: "sans", layout: "card",
};
const types = ["short", "long", "single", "multiple", "dropdown", "rating", "scale", "number", "date", "content"];
const choices = ["single", "multiple", "dropdown"];
const surveyQuestionContent = (questions = []) => JSON.stringify(questions.map((q) => ({
  id: q.id, type: q.type, text: q.text || "", description: q.description || "",
  required: q.type === "content" ? false : q.required ?? false,
  image: q.image || null,
  options: (q.options || []).map(({ id, text }) => ({ id, text })),
  ...(["rating", "scale", "number"].includes(q.type) ? {
    min: q.min ?? (q.type === "rating" ? 1 : q.type === "scale" ? 0 : null),
    max: q.max ?? (q.type === "rating" ? 5 : q.type === "scale" ? 10 : null),
    step: q.step ?? 1, minLabel: q.minLabel || "", maxLabel: q.maxLabel || "",
  } : {}),
})));
function text(value, max, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value))
    fail(400, "Некорректный текст опроса или превышена допустимая длина.");
  return value.trim();
}
function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail(400, "Некорректный идентификатор опроса.");
  return value;
}
function image(value, dataDir) {
  if (!value) return null;
  if (typeof value !== "string" || !/^\/uploads\/[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(value) || !existsSync(resolve(dataDir, `.${value}`)))
    fail(400, "Используйте изображение, загруженное через редактор.");
  return value;
}
function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(400, "Настройка должна быть логическим значением.");
  return value;
}
function numeric(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e12) fail(400, "Некорректная числовая граница.");
  return value;
}
export function newSurvey(title = "Новый опрос") {
  const stamp = now();
  return {
    id: randomUUID(), slug: `survey-${randomUUID().slice(0, 8)}`, slugAliases: [],
    title: text(title, 200) || "Новый опрос", description: "", intro: "", outro: "",
    status: "draft", contentRevision: 1, theme: { ...surveyTheme }, settings: { ...surveyDefaults },
    questions: [], createdAt: stamp, updatedAt: stamp,
  };
}
export function validateSurvey(input, original, dataDir) {
  if (!object(input)) fail(400, "Некорректный опрос.");
  const data = { ...original, ...input };
  if (data.settings !== undefined && !object(data.settings)) fail(400, "Некорректные настройки опроса.");
  const source = { ...surveyDefaults, ...original.settings, ...data.settings };
  const settings = {};
  for (const key of Object.keys(surveyDefaults).filter((key) => key !== "deadline"))
    settings[key] = boolean(source[key], surveyDefaults[key]);
  if (settings.anonymous) settings.collectName = settings.collectIp = settings.collectUserAgent = false;
  if (source.deadline !== null && source.deadline !== undefined && source.deadline !== "") {
    if (typeof source.deadline !== "string" || !Number.isFinite(Date.parse(source.deadline))) fail(400, "Некорректный дедлайн опроса.");
    settings.deadline = new Date(source.deadline).toISOString();
  } else settings.deadline = null;
  if (data.theme !== undefined && !object(data.theme)) fail(400, "Некорректное оформление опроса.");
  const themeSource = { ...surveyTheme, ...original.theme, ...data.theme };
  const theme = {};
  for (const key of ["backgroundColor", "surfaceColor", "accentColor", "textColor"]) {
    if (typeof themeSource[key] !== "string" || !/^#[a-f0-9]{6}$/i.test(themeSource[key])) fail(400, "Цвет должен быть в формате #RRGGBB.");
    theme[key] = themeSource[key].toLowerCase();
  }
  theme.logo = image(themeSource.logo, dataDir);
  theme.cover = image(themeSource.cover, dataDir);
  if (!["sans", "serif"].includes(themeSource.font) || !["card", "wide"].includes(themeSource.layout)) fail(400, "Некорректный стиль оформления.");
  theme.font = themeSource.font;
  theme.layout = themeSource.layout;
  if (!["draft", "published", "closed"].includes(data.status)) fail(400, "Некорректный статус опроса.");
  if (typeof data.slug !== "string" || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(data.slug)) fail(400, "Ссылка должна содержать 3–80 строчных латинских букв, цифр или дефисов.");
  if (!Array.isArray(data.questions) || data.questions.length > 200) fail(400, "В опросе допустимо до 200 вопросов.");
  const questions = data.questions.map((q) => {
    if (!object(q) || !types.includes(q.type)) fail(400, "Неизвестный тип вопроса опроса.");
    const question = {
      id: id(q.id), type: q.type, text: text(q.text, 12000), description: text(q.description, 4000),
      required: q.type === "content" ? false : boolean(q.required, false), image: image(q.image, dataDir), options: [],
    };
    if (!question.text && !question.image) fail(400, "Добавьте текст или изображение вопроса.");
    if (choices.includes(q.type)) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 100) fail(400, "Добавьте от 2 до 100 вариантов ответа.");
      question.options = q.options.map((option) => {
        if (!object(option)) fail(400, "Некорректный вариант ответа.");
        const result = { id: id(option.id), text: text(option.text, 2000) };
        if (!result.text) fail(400, "Введите текст варианта ответа.");
        return result;
      });
      if (new Set(question.options.map((option) => option.id)).size !== question.options.length) fail(400, "Идентификаторы вариантов должны быть уникальными.");
    }
    if (["rating", "scale", "number"].includes(q.type)) {
      question.min = numeric(q.min, q.type === "rating" ? 1 : q.type === "scale" ? 0 : null);
      question.max = numeric(q.max, q.type === "rating" ? 5 : q.type === "scale" ? 10 : null);
      question.step = numeric(q.step, 1);
      if (question.step <= 0 || (question.min !== null && question.max !== null && question.min >= question.max)) fail(400, "Проверьте границы и шаг числового вопроса.");
      if (q.type !== "number" && (!Number.isSafeInteger(question.min) || !Number.isSafeInteger(question.max) || !Number.isSafeInteger(question.step) || question.max - question.min > 100)) fail(400, "Шкала должна иметь целые границы и не более 100 делений.");
      question.minLabel = text(q.minLabel, 200);
      question.maxLabel = text(q.maxLabel, 200);
    }
    return question;
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length) fail(400, "Идентификаторы вопросов должны быть уникальными.");
  if (data.status === "published" && !questions.some((q) => q.type !== "content")) fail(400, "Добавьте вопрос перед публикацией опроса.");
  const title = text(data.title, 200);
  if (!title) fail(400, "Введите название опроса.");
  return {
    id: original.id, slug: data.slug, slugAliases: nextSlugAliases(original, data.slug), title, description: text(data.description, 4000),
    intro: text(data.intro, 12000), outro: text(data.outro, 12000), status: data.status,
    settings, theme, questions,
    contentRevision: nextContentRevision(original, surveyQuestionContent(original.questions) !== surveyQuestionContent(questions)),
    createdAt: original.createdAt, updatedAt: now(),
  };
}
const answered = (value) => value !== undefined && value !== null && (typeof value !== "string" || !!value.trim()) && (!Array.isArray(value) || value.length > 0);
const answerFor = (answers, questionId) => Object.hasOwn(answers, questionId) ? answers[questionId] : undefined;
export function validateSurveyAnswers(input, survey, complete = false) {
  if (!object(input) || Object.keys(input).length > 200) fail(400, "Некорректные ответы опроса.");
  const result = Object.create(null);
  for (const [questionId, value] of Object.entries(input)) {
    const q = survey.questions.find((question) => question.id === questionId);
    if (!q || q.type === "content") fail(400, "Ответ относится к неизвестному вопросу опроса.");
    if (!answered(value)) {
      if (value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)) fail(400, "Некорректный пустой ответ.");
      result[questionId] = null;
      continue;
    }
    if (["short", "long"].includes(q.type)) {
      if (typeof value !== "string" || value.length > (q.type === "short" ? 2000 : 12000) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) fail(400, "Некорректный текст ответа.");
    } else if (["single", "dropdown"].includes(q.type)) {
      if (typeof value !== "string" || !q.options.some((option) => option.id === value)) fail(400, "Выберите допустимый вариант ответа.");
    } else if (q.type === "multiple") {
      if (!Array.isArray(value) || value.length > q.options.length || new Set(value).size !== value.length || value.some((entry) => !q.options.some((option) => option.id === entry))) fail(400, "Некорректные варианты ответа.");
    } else if (["rating", "scale", "number"].includes(q.type)) {
      const offset = q.min ?? 0;
      const units = (value - offset) / q.step;
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e12 || (q.min !== null && value < q.min) || (q.max !== null && value > q.max) || Math.abs(units - Math.round(units)) > 1e-7) fail(400, "Число не соответствует границам или шагу вопроса.");
    } else if (q.type === "date") {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, "Введите корректную дату в формате ГГГГ-ММ-ДД.");
    }
    result[questionId] = value;
  }
  if (complete) for (const q of survey.questions)
    if (q.type !== "content" && q.required && !answered(result[q.id])) fail(400, `Ответьте на обязательный вопрос: ${q.text.slice(0, 100)}`);
  return result;
}

export function mountSurveyRoutes(app, dependencies) {
  const { db, dataDir, auth, browserHash, cookieOptions, participantIp, notify, exportReport, startLimit } = dependencies;
  const cookieName = (surveyId) => `aq_survey_${surveyId}`;
  const getSurvey = (idValue, bySlug = false) => {
    const row = db.prepare(`SELECT doc FROM surveys WHERE ${bySlug ? "slug" : "id"} = ?`).get(idValue) || (bySlug ? db.prepare(
      "SELECT s.doc FROM surveys s WHERE EXISTS (SELECT 1 FROM json_each(s.doc, '$.slugAliases') alias WHERE alias.value = ?) LIMIT 1",
    ).get(idValue) : null);
    if (!row) fail(404, "Опрос не найден.");
    const doc = JSON.parse(row.doc);
    doc.settings = { ...surveyDefaults, ...doc.settings };
    doc.contentRevision = contentRevision(doc);
    doc.slugAliases = normalizeSlugAliases(doc);
    return doc;
  };
  const surveySlugTaken = (slug, surveyId) => !!db.prepare(
    "SELECT 1 FROM surveys s WHERE s.id != ? AND (s.slug = ? OR EXISTS (SELECT 1 FROM json_each(s.doc, '$.slugAliases') alias WHERE alias.value = ?)) LIMIT 1",
  ).get(surveyId, slug, slug);
  const insertSurvey = (survey) => transaction(db, () => {
    while (surveySlugTaken(survey.slug, survey.id)) survey.slug = `survey-${randomUUID().slice(0, 8)}`;
    db.prepare("INSERT INTO surveys(id,slug,doc) VALUES(?,?,?)").run(survey.id, survey.slug, JSON.stringify(survey));
  });
  const getResponse = (responseId) => db.prepare("SELECT * FROM survey_responses WHERE id = ?").get(responseId);
  const recordEvent = (responseId, type, metadata = {}) =>
    db.prepare("INSERT INTO survey_events(response_id,type,created_at,metadata) VALUES(?,?,?,?)")
      .run(responseId, type, now(), JSON.stringify(metadata));
  const expire = (row) => {
    if (row?.status === "active" && row.expires_at && row.expires_at <= now()) {
      db.prepare("UPDATE survey_responses SET status = 'expired', finished_at = expires_at, last_action = 'expired', last_action_at = ? WHERE id = ? AND status = 'active'").run(now(), row.id);
      recordEvent(row.id, "expired");
      notify(row.survey_id);
      return getResponse(row.id);
    }
    return row;
  };
  const bound = (req) => {
    const row = getResponse(req.params.id);
    const secret = row && req.cookies[cookieName(row.survey_id)];
    if (!row || !validToken(secret) || row.access_hash !== hash(secret)) fail(404, "Ответ не найден в этом браузере.");
    return expire(row);
  };
  function presence(row) {
    const survey = JSON.parse(row.snapshot);
    const questions = survey.questions.filter((q) => q.type !== "content");
    const answers = JSON.parse(row.answers);
    const fresh = !!row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 35_000;
    return {
      status: row.status !== "active" ? "finished" : !fresh ? "offline" : row.presence_visibility === "hidden" || row.presence_focused === 0 ? "away" : "active",
      lastSeenAt: row.last_seen_at, visibility: row.presence_visibility,
      focused: row.presence_focused === null ? null : !!row.presence_focused,
      questionId: row.current_question_id,
      questionNumber: row.current_question_id ? survey.questions.findIndex((q) => q.id === row.current_question_id) + 1 || null : null,
      answeredCount: questions.filter((q) => answered(answerFor(answers, q.id))).length, totalQuestions: questions.length,
      lastAction: row.last_action, lastActionAt: row.last_action_at,
    };
  }
  const participant = (row) => {
    const survey = JSON.parse(row.snapshot);
    return {
      id: row.id, surveyId: row.survey_id, status: row.status, name: row.name,
      contentRevision: contentRevision(survey), title: survey.title,
      startedAt: row.started_at, expiresAt: row.expires_at, finishedAt: row.finished_at,
      answers: JSON.parse(row.answers), questions: survey.questions, settings: survey.settings,
      theme: survey.theme, presence: presence(row),
    };
  };
  const summaries = (rows) => {
    const states = rows.map((row) => presence(row).status);
    return {
      total: rows.length, active: rows.filter((r) => r.status === "active").length,
      submitted: rows.filter((r) => r.status === "submitted").length, expired: rows.filter((r) => r.status === "expired").length,
      online: states.filter((status) => status === "active").length,
      away: states.filter((status) => status === "away").length,
      offline: states.filter((status) => status === "offline").length,
    };
  };
  const rowsFor = (surveyId) => db.prepare("SELECT * FROM survey_responses WHERE survey_id = ? ORDER BY started_at DESC").all(surveyId).map(expire);
  function report(surveyId) {
    const survey = getSurvey(surveyId);
    const rows = rowsFor(surveyId);
    const currentRevision = contentRevision(survey);
    const definitions = new Map([[currentRevision, { title: survey.title, questions: survey.questions }]]);
    const rowGroups = new Map([[currentRevision, []]]);
    const snapshots = new Map();
    const answerSets = new Map();
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot);
      snapshots.set(row.id, snapshot);
      answerSets.set(row.id, JSON.parse(row.answers));
      const revision = contentRevision(snapshot);
      if (!definitions.has(revision)) definitions.set(revision, { title: snapshot.title, questions: snapshot.questions });
      if (!rowGroups.has(revision)) rowGroups.set(revision, []);
      rowGroups.get(revision).push(row);
    }
    const questionStatistics = (definition, scopedRows, revision) => {
      const completed = scopedRows.filter((row) => row.status === "submitted");
      return definition.filter((q) => q.type !== "content").map((q) => {
        const values = completed.map((row) => answerFor(answerSets.get(row.id), q.id)).filter(answered);
        const aggregates = { answered: values.length, skipped: completed.length - values.length };
        if (choices.includes(q.type)) aggregates.options = q.options.map((option) => ({ ...option, count: values.filter((value) => q.type === "multiple" ? value.includes(option.id) : value === option.id).length }));
        if (["rating", "scale", "number"].includes(q.type)) {
          aggregates.average = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null;
          aggregates.min = values.length ? values.reduce((min, value) => Math.min(min, value), Infinity) : null;
          aggregates.max = values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : null;
          const distribution = new Map();
          for (const value of values) distribution.set(value, (distribution.get(value) || 0) + 1);
          aggregates.distribution = [...distribution].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
        }
        return { ...q, contentRevision: revision, aggregates };
      });
    };
    const currentRows = rowGroups.get(currentRevision);
    return {
      kind: "survey", survey,
      summary: {
        ...summaries(rows), questionsScope: "current_revision",
        questionsContentRevision: currentRevision,
        questionsResponseCount: currentRows.length,
        questionsSubmittedCount: currentRows.filter((row) => row.status === "submitted").length,
      },
      questions: questionStatistics(survey.questions, currentRows, currentRevision),
      revisions: [...definitions].sort(([a], [b]) => b - a).map(([revision, definition]) => ({
        contentRevision: revision, title: definition.title,
        questionDefinitions: definition.questions,
        questions: questionStatistics(definition.questions, rowGroups.get(revision), revision),
        summary: summaries(rowGroups.get(revision)),
      })),
      responses: rows.map((row) => ({
        id: row.id, name: row.name, status: row.status, startedAt: row.started_at,
        contentRevision: contentRevision(snapshots.get(row.id)),
        title: snapshots.get(row.id).title, questions: snapshots.get(row.id).questions,
        expiresAt: row.expires_at, finishedAt: row.finished_at, ip: row.ip, userAgent: row.user_agent,
        collection: JSON.parse(row.collection), answers: answerSets.get(row.id), presence: presence(row),
        events: db.prepare("SELECT type,created_at AS createdAt,metadata FROM survey_events WHERE response_id = ? ORDER BY id")
          .all(row.id).map((event) => ({ ...event, counted: 0, metadata: JSON.parse(event.metadata) })),
        durationSeconds: Math.max(0, Math.round((Date.parse(row.finished_at || now()) - Date.parse(row.started_at)) / 1000)),
      })),
    };
  }
  app.get("/api/admin/surveys", auth, (req, res) => {
    const surveys = db.prepare("SELECT doc FROM surveys").all().map((row) => {
      const survey = JSON.parse(row.doc);
      survey.contentRevision = contentRevision(survey);
      survey.slugAliases = normalizeSlugAliases(survey);
      const summary = summaries(rowsFor(survey.id));
      return { ...survey, questions: undefined, questionCount: survey.questions.filter((q) => q.type !== "content").length, responseCount: summary.total, submittedCount: summary.submitted, activeCount: summary.active, onlineCount: summary.online };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ surveys });
  });
  app.post("/api/admin/surveys", auth, (req, res) => {
    const survey = newSurvey(req.body?.title);
    insertSurvey(survey);
    notify(survey.id);
    res.status(201).json({ ...survey, responseCount: 0 });
  });
  app.get("/api/admin/surveys/:id", auth, (req, res) => {
    const survey = getSurvey(req.params.id);
    res.json({ ...survey, responseCount: db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?").get(survey.id).n });
  });
  app.put("/api/admin/surveys/:id", auth, (req, res) => {
    const result = transaction(db, () => {
      const old = getSurvey(req.params.id);
      const survey = validateSurvey(req.body, old, dataDir);
      const count = db.prepare("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?").get(old.id).n;
      if (surveySlugTaken(survey.slug, survey.id)) fail(409, "Такая ссылка опроса уже используется.");
      db.prepare("UPDATE surveys SET slug = ?, doc = ? WHERE id = ?").run(survey.slug, JSON.stringify(survey), survey.id);
      for (const row of rowsFor(survey.id)) {
        // Privacy restrictions apply to existing rows as well. Enabling collection
        // never reconstructs metadata from a request or a technical digest.
        const name = survey.settings.anonymous || !survey.settings.collectName ? null : row.name;
        const ip = survey.settings.anonymous || !survey.settings.collectIp ? null : row.ip;
        const userAgent = survey.settings.anonymous || !survey.settings.collectUserAgent ? null : row.user_agent;
        db.prepare("UPDATE survey_responses SET name = ?, ip = ?, user_agent = ? WHERE id = ?").run(name, ip, userAgent, row.id);
        if (row.status !== "active") continue;
        const snapshot = JSON.parse(row.snapshot);
        snapshot.settings = { ...survey.settings };
        snapshot.theme = { ...survey.theme };
        db.prepare("UPDATE survey_responses SET snapshot = ?, expires_at = ? WHERE id = ?").run(JSON.stringify(snapshot), survey.settings.deadline, row.id);
        expire(getResponse(row.id));
      }
      return { ...survey, responseCount: count };
    });
    notify(result.id);
    res.json(result);
  });
  app.post("/api/admin/surveys/:id/clone", auth, (req, res) => {
    const old = getSurvey(req.params.id);
    const survey = { ...structuredClone(old), ...newSurvey(`${old.title} — копия`.slice(0, 200)),
      description: old.description, intro: old.intro, outro: old.outro, theme: { ...old.theme }, settings: { ...old.settings, deadline: null },
      questions: old.questions.map((q) => ({ ...q, id: randomUUID(), options: q.options.map((option) => ({ ...option, id: randomUUID() })) })),
    };
    insertSurvey(survey);
    notify(survey.id);
    res.status(201).json({ ...survey, responseCount: 0 });
  });
  app.delete("/api/admin/surveys/:id", auth, (req, res) => {
    const survey = getSurvey(req.params.id);
    if (survey.status === "published") fail(409, "Закройте опрос перед удалением.");
    db.prepare("DELETE FROM surveys WHERE id = ?").run(survey.id);
    notify(survey.id);
    res.json({ ok: true });
  });
  app.get("/api/admin/surveys/:id/report", auth, (req, res) => res.json(report(req.params.id)));
  app.get("/api/admin/surveys/:id/export.xlsx", auth, async (req, res) => {
    const variant = req.query.variant ?? "public";
    if (!["public", "private"].includes(variant)) fail(400, "Неизвестный вариант экспорта.");
    const buffer = await exportReport(report(req.params.id), { variant });
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", `attachment; filename="survey-report-${req.params.id}-${variant}.xlsx"`);
    res.send(buffer);
  });
  app.delete("/api/admin/surveys/:id/responses/:responseId", auth, (req, res) => {
    transaction(db, () => {
      getSurvey(req.params.id);
      const row = getResponse(req.params.responseId);
      if (!row || row.survey_id !== req.params.id) fail(404, "Ответ не найден.");
      db.prepare("DELETE FROM survey_responses WHERE id = ?").run(row.id);
    });
    notify(req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/public/surveys/:slug", (req, res) => {
    const survey = getSurvey(req.params.slug, true);
    if (survey.status === "draft") fail(404, "Опрос ещё не опубликован.");
    if (survey.settings.oneResponsePerBrowser) browserHash(req, res);
    let secret = req.cookies[cookieName(survey.id)];
    if (!validToken(secret)) {
      secret = token();
      res.cookie(cookieName(survey.id), secret, { ...cookieOptions, maxAge: 400 * 24 * 60 * 60 * 1000 });
    }
    const own = validToken(secret) ? db.prepare("SELECT * FROM survey_responses WHERE survey_id = ? AND access_hash = ? ORDER BY started_at DESC LIMIT 1").get(survey.id, hash(secret)) : null;
    res.json({ ...survey, response: own ? participant(expire(own)) : null });
  });
  app.post("/api/public/surveys/:slug/start", startLimit, (req, res) => {
    let secret;
    let created = false;
    const response = transaction(db, () => {
      const survey = getSurvey(req.params.slug, true);
      const oldSecret = req.cookies[cookieName(survey.id)];
      const own = validToken(oldSecret) ? db.prepare("SELECT * FROM survey_responses WHERE survey_id = ? AND access_hash = ? ORDER BY started_at DESC LIMIT 1").get(survey.id, hash(oldSecret)) : null;
      if (own && expire(own).status === "active") return getResponse(own.id);
      if (survey.status !== "published") fail(403, "Опрос закрыт для новых ответов.");
      if (survey.settings.deadline && survey.settings.deadline <= now()) fail(403, "Срок заполнения опроса истёк.");
      const ip = (survey.settings.collectIp && !survey.settings.anonymous) || survey.settings.oneResponsePerIp ? participantIp(req) : null;
      const ipKey = survey.settings.oneResponsePerIp ? addressKey(db, `survey:${survey.id}`, ip) : null;
      if (survey.settings.oneResponsePerIp && !ipKey) fail(400, "Не удалось определить IP-адрес для проверки ограничения.");
      const browserKey = survey.settings.oneResponsePerBrowser ? hash(`survey:${survey.id}:${browserHash(req, res)}`) : null;
      if (ipKey && db.prepare("SELECT 1 FROM survey_responses WHERE survey_id = ? AND ip_key = ?").get(survey.id, ipKey)) fail(409, "С этого IP-адреса уже начали или отправили ответ на опрос.");
      if (browserKey && db.prepare("SELECT 1 FROM survey_responses WHERE survey_id = ? AND browser_key = ?").get(survey.id, browserKey)) fail(409, "В этом браузере уже начали или отправили ответ на опрос.");
      const name = !survey.settings.anonymous && survey.settings.collectName ? text(req.body?.name, 150) : null;
      if (!survey.settings.anonymous && survey.settings.collectName && !name) fail(400, "Введите своё имя.");
      secret = validToken(oldSecret) && !own ? oldSecret : token();
      const stamp = now();
      const responseId = randomUUID();
      const collection = { anonymous: survey.settings.anonymous, collectName: survey.settings.collectName, collectIp: survey.settings.collectIp, collectUserAgent: survey.settings.collectUserAgent, capturedAt: stamp };
      db.prepare(`INSERT INTO survey_responses(id,survey_id,access_hash,browser_key,ip_key,name,started_at,expires_at,snapshot,ip,user_agent,collection,last_seen_at,last_action,last_action_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(responseId, survey.id, hash(secret), browserKey, ipKey, name, stamp, survey.settings.deadline, JSON.stringify(survey),
          !survey.settings.anonymous && survey.settings.collectIp ? ip : null,
          !survey.settings.anonymous && survey.settings.collectUserAgent ? (req.get("User-Agent") || "").slice(0, 500) : null,
          JSON.stringify(collection), stamp, "start", stamp);
      recordEvent(responseId, "start");
      created = true;
      return getResponse(responseId);
    });
    if (secret) res.cookie(cookieName(response.survey_id), secret, { ...cookieOptions, maxAge: 400 * 24 * 60 * 60 * 1000 });
    notify(response.survey_id);
    res.status(created ? 201 : 200).json(participant(response));
  });
  app.get("/api/public/responses/:id", (req, res) => res.json(participant(bound(req))));
  app.put("/api/public/responses/:id/answers", (req, res) => {
    const response = transaction(db, () => {
      const row = bound(req);
      if (row.status !== "active") fail(409, "Ответ уже завершён и не может быть изменён.");
      const snapshot = JSON.parse(row.snapshot);
      const incoming = validateSurveyAnswers(req.body?.answers, snapshot);
      const answers = { ...JSON.parse(row.answers), ...incoming };
      const changed = JSON.stringify(answers) !== row.answers;
      db.prepare("UPDATE survey_responses SET answers = ?, last_seen_at = ?, last_action = ?, last_action_at = ? WHERE id = ? AND status = 'active'")
        .run(JSON.stringify(answers), now(), changed ? "answers" : row.last_action, changed ? now() : row.last_action_at, row.id);
      if (changed) recordEvent(row.id, "answers");
      return getResponse(row.id);
    });
    notify(response.survey_id);
    res.json(participant(response));
  });
  app.post("/api/public/responses/:id/submit", (req, res) => {
    const response = transaction(db, () => {
      const row = bound(req);
      if (row.status !== "active") return row;
      const snapshot = JSON.parse(row.snapshot);
      const incoming = req.body?.answers === undefined ? {} : validateSurveyAnswers(req.body.answers, snapshot);
      const answers = validateSurveyAnswers({ ...JSON.parse(row.answers), ...incoming }, snapshot, true);
      const stamp = now();
      db.prepare("UPDATE survey_responses SET answers = ?, status = 'submitted', finished_at = ?, last_seen_at = ?, last_action = 'submitted', last_action_at = ? WHERE id = ? AND status = 'active'")
        .run(JSON.stringify(answers), stamp, stamp, stamp, row.id);
      recordEvent(row.id, "submitted");
      return getResponse(row.id);
    });
    notify(response.survey_id);
    res.json(participant(response));
  });
  app.post("/api/public/responses/:id/presence", (req, res) => {
    const { visibility, focused, questionId } = req.body || {};
    if (!["visible", "hidden"].includes(visibility) || typeof focused !== "boolean" ||
      (questionId !== undefined && questionId !== null && (typeof questionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(questionId)))) fail(400, "Некорректный статус вкладки.");
    const response = transaction(db, () => {
      const row = bound(req);
      if (row.status !== "active") return row;
      const snapshot = JSON.parse(row.snapshot);
      if (questionId && !snapshot.questions.some((q) => q.id === questionId)) fail(400, "Вопрос не найден.");
      const current = questionId === undefined ? row.current_question_id : questionId;
      const focus = focused && visibility === "visible" ? 1 : 0;
      const changed = current !== row.current_question_id || row.presence_visibility !== visibility || row.presence_focused !== focus;
      const action = current !== row.current_question_id ? "question" : row.presence_visibility !== visibility || row.presence_focused !== focus ? "presence" : row.last_action;
      db.prepare("UPDATE survey_responses SET last_seen_at = ?, presence_visibility = ?, presence_focused = ?, current_question_id = ?, last_action = ?, last_action_at = ? WHERE id = ? AND status = 'active'")
        .run(now(), visibility, focus, current || null, action, changed ? now() : row.last_action_at, row.id);
      if (current !== row.current_question_id) recordEvent(row.id, "question", { questionId: current || null });
      if (row.presence_visibility !== visibility || row.presence_focused !== focus)
        recordEvent(row.id, "presence", { visibility, focused: !!focus });
      return getResponse(row.id);
    });
    notify(response.survey_id);
    res.json(participant(response));
  });
  const staleStates = new Map();
  return {
    report,
    sweep() {
      const active = db.prepare("SELECT * FROM survey_responses WHERE status = 'active'").all();
      const ids = new Set(active.map((row) => row.id));
      for (const responseId of staleStates.keys()) if (!ids.has(responseId)) staleStates.delete(responseId);
      for (const row of active) {
        const current = expire(row);
        const status = presence(current).status;
        if (staleStates.has(row.id) && staleStates.get(row.id) !== status) notify(row.survey_id);
        staleStates.set(row.id, status);
        if (current.status !== "active") staleStates.delete(row.id);
      }
    },
    monitoring() {
      return db.prepare("SELECT r.*,s.doc AS survey_doc FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE r.status = 'active' ORDER BY r.started_at DESC").all().map((row) => {
        const current = expire(row);
        const survey = JSON.parse(row.survey_doc);
        return { kind: "survey", id: row.id, responseId: row.id, surveyId: row.survey_id, contentRevision: contentRevision(JSON.parse(current.snapshot)), title: survey.title, slug: survey.slug, name: row.name, status: current.status, startedAt: row.started_at, expiresAt: row.expires_at, finishedAt: current.finished_at, presence: presence(current) };
      }).filter((row) => row.status === "active");
    },
  };
}
