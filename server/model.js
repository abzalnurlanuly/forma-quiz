import { randomUUID, randomInt, randomBytes } from "node:crypto";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new ApiError(status, message);
};
export const defaults = {
  requireName: true,
  rosterEnabled: false,
  requireStudentCode: true,
  timeLimitMinutes: 0,
  deadline: null,
  antiCheat: false,
  oneAttemptPerIp: false,
  publicBoardEnabled: false,
  publicBoardShowNames: false,
  publicBoardShowScores: true,
  maxWarnings: 3,
  shuffleQuestions: true,
  shuffleOptions: true,
  showScore: true,
  showCorrectAnswersAfterTest: false,
  blockPaste: false,
  feedbackMode: "end",
};
export const normalizeSettings = (settings = {}) => ({
  ...Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
    [key, settings != null && Object.hasOwn(settings, key) ? settings[key] : fallback])),
  publicBoardEnabled: settings?.publicBoardEnabled === true,
  publicBoardShowNames: settings?.publicBoardShowNames === true,
  publicBoardShowScores: settings?.publicBoardShowScores === undefined || settings.publicBoardShowScores === true,
});
export const isPublicBoardToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16}$/.test(value);
export const newPublicBoardToken = () => randomBytes(12).toString("base64url");
export const contentRevision = (document) =>
  Number.isSafeInteger(document?.contentRevision) && document.contentRevision > 0
    ? document.contentRevision
    : 1;
export const normalizeSlugAliases = (document) => [...new Set(
  (Array.isArray(document?.slugAliases) ? document.slugAliases : [])
    .filter((slug) => typeof slug === "string" && /^[a-z0-9][a-z0-9-]{2,79}$/.test(slug) && slug !== document.slug),
)];

export function nextSlugAliases(original, slug) {
  const aliases = normalizeSlugAliases(original).filter((alias) => alias !== slug);
  if (slug !== original.slug) aliases.push(original.slug);
  if (aliases.length > 200)
    fail(409, "Сохранено 200 прежних ссылок. Можно менять вопросы и настройки или вернуть одну из прежних ссылок.");
  return aliases;
}

// Compare validated question definitions, excluding publishing and presentation
// settings. Defaults make an unchanged legacy document remain revision 1.
const quizQuestionContent = (questions = []) => JSON.stringify(questions.map((q) => ({
  id: q.id, type: q.type, text: q.text || "", image: q.image || null,
  points: q.type === "content" ? 0 : q.points ?? 1,
  options: (q.options || []).map(({ id, text }) => ({ id, text })),
  correct: q.type === "multiple" ? [...(q.correct || [])].sort() : q.correct ?? [],
  pairs: (q.pairs || []).map(({ id, left, right }) => ({ id, left, right })),
  ...(q.type === "number" ? { tolerance: q.tolerance ?? 0 } : {}),
})));

export function nextContentRevision(original, changed) {
  const revision = contentRevision(original);
  if (changed && revision === Number.MAX_SAFE_INTEGER)
    fail(409, "Достигнут предел версий вопросов.");
  return revision + (changed ? 1 : 0);
}
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
export const normalizedName = (value) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru");
const text = (value, max, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)
  )
    fail(400, "Некорректный текст или превышена допустимая длина.");
  return value.trim();
};
const id = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    fail(400, "Некорректный идентификатор.");
  return value;
};
const unique = (values) => new Set(values).size === values.length;
const integer = (value, min, max, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(400, "Число выходит за допустимые пределы.");
  return value;
};
const bool = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(400, "Ожидалось логическое значение.");
  return value;
};

export function validateQuiz(input, original) {
  if (!object(input)) fail(400, "Некорректный квиз.");
  const data = { ...original, ...input };
  const source = { ...defaults, ...data.settings };
  if (!object(source)) fail(400, "Некорректные настройки.");
  const settings = {};
  for (const key of [
    "requireName",
    "rosterEnabled",
    "requireStudentCode",
    "antiCheat",
    "oneAttemptPerIp",
    "publicBoardEnabled",
    "publicBoardShowNames",
    "publicBoardShowScores",
    "shuffleQuestions",
    "shuffleOptions",
    "showScore",
    "showCorrectAnswersAfterTest",
    "blockPaste",
  ])
    settings[key] = bool(source[key], defaults[key]);
  settings.timeLimitMinutes = integer(source.timeLimitMinutes, 0, 10080, 0);
  settings.maxWarnings = integer(source.maxWarnings, 1, 10, 3);
  if (!["end", "immediate"].includes(source.feedbackMode))
    fail(400, "Некорректный режим показа ответов.");
  settings.feedbackMode = source.feedbackMode;
  if (
    source.deadline !== null &&
    source.deadline !== undefined &&
    source.deadline !== ""
  ) {
    if (
      typeof source.deadline !== "string" ||
      !Number.isFinite(Date.parse(source.deadline))
    )
      fail(400, "Некорректный дедлайн.");
    settings.deadline = new Date(source.deadline).toISOString();
  } else settings.deadline = null;
  const status = data.status || "draft";
  if (!["draft", "published", "closed"].includes(status))
    fail(400, "Некорректный статус.");
  if (
    typeof data.slug !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,79}$/.test(data.slug)
  )
    fail(
      400,
      "Ссылка должна содержать 3–80 строчных латинских букв, цифр или дефисов.",
    );
  if (!Array.isArray(data.questions) || data.questions.length > 200)
    fail(400, "Максимум 200 вопросов.");
  const questions = data.questions.map((q) => {
    if (
      !object(q) ||
      !["single", "multiple", "short", "matching", "content", "truefalse", "number", "ordering"].includes(q.type)
    )
      fail(400, "Неизвестный тип вопроса.");
    const question = {
      id: id(q.id),
      type: q.type,
      text: text(q.text, 12000),
      image: null,
      points: q.type === "content" ? 0 : integer(q.points, 1, 100, 1),
      options: [],
      correct: [],
      pairs: [],
    };
    if (!question.text && !q.image)
      fail(400, "Добавьте текст или изображение вопроса.");
    if (q.image) {
      if (
        typeof q.image !== "string" ||
        !/^\/uploads\/[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(q.image)
      )
        fail(400, "Изображение должно быть загружено через редактор.");
      question.image = q.image;
    }
    if (["single", "multiple", "truefalse", "ordering"].includes(q.type)) {
      if (
        !Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.length > 20
      )
        fail(400, "Вопрос должен содержать 2–20 вариантов.");
      question.options = q.options.map((option) => {
        if (!object(option)) fail(400, "Некорректный вариант.");
        return { id: id(option.id), text: text(option.text, 2000) };
      });
      if (
        !unique(question.options.map((option) => option.id)) ||
        question.options.some((option) => !option.text)
      )
        fail(400, "Варианты должны иметь уникальные идентификаторы и текст.");
      if (
        !Array.isArray(q.correct) ||
        !q.correct.length ||
        (["single", "truefalse"].includes(q.type) && q.correct.length !== 1) ||
        (q.type === "ordering" && q.correct.length !== question.options.length) ||
        !unique(q.correct) ||
        q.correct.some(
          (key) => !question.options.some((option) => option.id === key),
        )
      )
        fail(400, "Выберите правильные варианты.");
      question.correct = [...q.correct];
      if (q.type === "truefalse" && (
        question.options.length !== 2 ||
        !question.options.some((option) => option.id === "true") ||
        !question.options.some((option) => option.id === "false")
      )) fail(400, "Для «Верно / неверно» нужны варианты true и false.");
    } else if (q.type === "number") {
      if (typeof q.correct !== "number" || !Number.isFinite(q.correct) || Math.abs(q.correct) > 1e15)
        fail(400, "Укажите конечное число для правильного ответа.");
      const tolerance = q.tolerance ?? 0;
      if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e15)
        fail(400, "Погрешность должна быть неотрицательным конечным числом.");
      question.correct = q.correct;
      question.tolerance = tolerance;
    } else if (q.type === "short") {
      question.correct = text(q.correct, 2000);
      if (!question.correct) fail(400, "Укажите правильный ответ.");
    } else if (q.type === "matching") {
      if (!Array.isArray(q.pairs) || q.pairs.length < 2 || q.pairs.length > 20)
        fail(400, "Добавьте 2–20 пар.");
      question.pairs = q.pairs.map((pair) => {
        if (!object(pair)) fail(400, "Некорректная пара.");
        return {
          id: id(pair.id),
          left: text(pair.left, 2000),
          right: text(pair.right, 2000),
        };
      });
      if (
        !unique(question.pairs.map((pair) => pair.id)) ||
        question.pairs.some((pair) => !pair.left || !pair.right)
      )
        fail(
          400,
          "Пары должны иметь уникальные идентификаторы и заполненные стороны.",
        );
    }
    return question;
  });
  if (!unique(questions.map((q) => q.id)))
    fail(400, "Идентификаторы вопросов должны быть уникальными.");
  if (!Array.isArray(data.groups) || data.groups.length > 100)
    fail(400, "Максимум 100 групп.");
  let studentCount = 0;
  const groups = data.groups.map((group) => {
    if (
      !object(group) ||
      !Array.isArray(group.students) ||
      group.students.length > 1000
    )
      fail(400, "Некорректная группа.");
    return {
      id: id(group.id),
      name: text(group.name, 100),
      students: group.students.map((student) => {
        if (!object(student)) fail(400, "Некорректный студент.");
        studentCount++;
        const result = {
          id: id(student.id),
          name: text(student.name, 150),
          code: text(student.code, 128),
        };
        if (
          !result.name ||
          (settings.rosterEnabled &&
            settings.requireStudentCode &&
            result.code.length < 6)
        )
          fail(
            400,
            "Каждому студенту нужны имя и личный код минимум из 6 символов.",
          );
        return result;
      }),
    };
  });
  if (
    studentCount > 5000 ||
    !unique(groups.map((g) => g.id)) ||
    groups.some((g) => !g.name) ||
    !unique(groups.flatMap((g) => g.students.map((s) => s.id)))
  )
    fail(
      400,
      "Проверьте группы и уникальность идентификаторов студентов (максимум 5000).",
    );
  if (settings.rosterEnabled && !studentCount && status === "published")
    fail(400, "Добавьте студентов перед публикацией.");
  if (status === "published" && !questions.some((q) => q.type !== "content"))
    fail(400, "Добавьте хотя бы один оцениваемый вопрос перед публикацией.");
  const title = text(data.title, 200);
  if (!title) fail(400, "Введите название квиза.");
  return {
    id: original.id,
    slug: data.slug,
    slugAliases: nextSlugAliases(original, data.slug),
    title,
    description: text(data.description, 4000),
    intro: text(data.intro, 12000),
    outro: text(data.outro, 12000),
    status,
    settings,
    publicBoardToken: settings.publicBoardEnabled
      ? original.settings?.publicBoardEnabled === true && isPublicBoardToken(original.publicBoardToken)
        ? original.publicBoardToken : newPublicBoardToken()
      : null,
    questions,
    groups,
    contentRevision: nextContentRevision(original,
      quizQuestionContent(original.questions) !== quizQuestionContent(questions)),
    createdAt: original.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function newQuiz(title = "Новый квиз") {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    slug: `quiz-${randomUUID().slice(0, 8)}`,
    slugAliases: [],
    title:
      typeof title === "string" && title.trim()
        ? title.trim().slice(0, 200)
        : "Новый квиз",
    description: "",
    intro: "",
    outro: "",
    status: "draft",
    contentRevision: 1,
    settings: { ...defaults },
    publicBoardToken: null,
    questions: [],
    groups: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function shuffle(array) {
  const values = [...array];
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function snapshotQuiz(quiz) {
  const snapshot = structuredClone(quiz);
  snapshot.contentRevision = contentRevision(quiz);
  snapshot.settings = normalizeSettings(snapshot.settings);
  if (snapshot.settings.shuffleQuestions)
    snapshot.questions = shuffle(snapshot.questions);
  for (const q of snapshot.questions) {
    if (snapshot.settings.shuffleOptions || q.type === "ordering") q.options = shuffle(q.options);
    if (q.type === "matching")
      q.choices = shuffle([...new Set(q.pairs.map((pair) => pair.right))]);
  }
  delete snapshot.groups;
  // A revocable public capability belongs to the live author document, never to
  // grading snapshots or archived attempts.
  delete snapshot.publicBoardToken;
  return snapshot;
}

export function safeQuestion(q) {
  const result = {
    id: q.id,
    type: q.type,
    text: q.text,
    image: q.image,
    points: q.points,
  };
  if (["single", "multiple", "truefalse", "ordering"].includes(q.type))
    result.options = q.options.map(({ id, text }) => ({ id, text }));
  if (q.type === "matching") {
    result.pairs = q.pairs.map(({ id, left }) => ({ id, left }));
    result.choices = q.choices;
  }
  return result;
}

export function validateAnswers(answers, snapshot) {
  if (!object(answers) || Object.keys(answers).length > 200)
    fail(400, "Некорректные ответы.");
  const clean = Object.create(null);
  for (const [qid, answer] of Object.entries(answers)) {
    const q = snapshot.questions.find((q) => q.id === qid);
    if (!q || q.type === "content")
      fail(400, "Ответ относится к неизвестному вопросу.");
    if (q.type === "short") {
      if (typeof answer !== "string" || answer.length > 2000)
        fail(400, "Некорректный короткий ответ.");
      clean[qid] = answer;
    } else if (q.type === "number") {
      // Empty string clears a draft; actual values have one numeric representation.
      if (answer === "") clean[qid] = "";
      else {
        const validString = typeof answer === "string" && answer.length <= 100 &&
          /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(answer.trim());
        const number = typeof answer === "number" ? answer : validString ? Number(answer.trim().replace(",", ".")) : NaN;
        if (!Number.isFinite(number) || Math.abs(number) > 1e15)
          fail(400, "Введите корректный числовой ответ.");
        clean[qid] = number;
      }
    } else if (["single", "truefalse"].includes(q.type)) {
      if (
        typeof answer !== "string" ||
        (answer && !q.options.some((o) => o.id === answer))
      )
        fail(400, "Некорректный вариант ответа.");
      clean[qid] = answer;
    } else if (["multiple", "ordering"].includes(q.type)) {
      if (
        !Array.isArray(answer) ||
        answer.length > q.options.length ||
        !unique(answer) ||
        answer.some((value) => !q.options.some((o) => o.id === value))
      )
        fail(400, "Некорректные варианты ответа.");
      clean[qid] = [...answer];
    } else {
      if (!object(answer) || Object.keys(answer).length > q.pairs.length)
        fail(400, "Некорректное сопоставление.");
      const pairs = Object.create(null);
      for (const [pid, right] of Object.entries(answer)) {
        if (
          !q.pairs.some((p) => p.id === pid) ||
          typeof right !== "string" ||
          (right && !q.pairs.some((p) => p.right === right))
        )
          fail(400, "Некорректная пара.");
        pairs[pid] = right;
      }
      clean[qid] = pairs;
    }
  }
  return clean;
}

export function calculateResult(snapshot, answers, invalidated = false) {
  let score = 0,
    maxScore = 0;
  const questionResults = Object.create(null);
  for (const q of snapshot.questions) {
    if (q.type === "content") continue;
    maxScore += q.points;
    const correct = questionIsCorrect(q, answers[q.id]);
    questionResults[q.id] = !invalidated && correct;
    if (!invalidated && correct) score += q.points;
  }
  return {
    score,
    maxScore,
    percent: maxScore ? Math.round((score / maxScore) * 10000) / 100 : 0,
    questionResults,
  };
}

export function questionIsCorrect(question, answer) {
  if (question.type === "single") return answer === question.correct[0];
  if (question.type === "truefalse") return answer === question.correct[0];
  if (question.type === "number")
    return typeof answer === "number" && Number.isFinite(answer) && (
      !question.tolerance ? answer === question.correct :
        Math.abs(answer - question.correct) <= question.tolerance + Math.min(
          question.tolerance * 1e-10,
          Number.EPSILON * Math.max(1, Math.abs(answer), Math.abs(question.correct)) * 4,
        )
    );
  if (question.type === "ordering")
    return Array.isArray(answer) && answer.length === question.correct.length &&
      question.correct.every((key, index) => answer[index] === key);
  if (question.type === "multiple")
    return (
      Array.isArray(answer) &&
      answer.length === question.correct.length &&
      question.correct.every((key) => answer.includes(key))
    );
  if (question.type === "short")
    return (
      typeof answer === "string" &&
      normalizedName(answer) === normalizedName(question.correct)
    );
  if (question.type === "matching")
    return (
      !!answer &&
      typeof answer === "object" &&
      question.pairs.every((pair) => answer[pair.id] === pair.right)
    );
  return false;
}

export function questionReview(question, answer) {
  const correct = questionIsCorrect(question, answer);
  let expected = [];
  if (["single", "multiple", "truefalse", "ordering"].includes(question.type))
    expected = question.correct.map(
      (id) => question.options.find((option) => option.id === id).text,
    );
  else if (question.type === "short") expected = [question.correct];
  else if (question.type === "number") expected = [
    `${question.correct}${question.tolerance ? ` ± ${question.tolerance}` : ""}`,
  ];
  else if (question.type === "matching")
    expected = question.pairs.map((pair) => `${pair.left} — ${pair.right}`);
  return {
    questionId: question.id,
    correct,
    points: correct ? question.points : 0,
    maxPoints: question.points,
    expected,
  };
}

export function canonicalAnswer(question, answer) {
  if (question.type === "multiple") return JSON.stringify([...answer].sort());
  if (question.type === "matching")
    return JSON.stringify(
      question.pairs
        .map((pair) => [
          pair.id,
          Object.hasOwn(answer, pair.id) ? answer[pair.id] : "",
        ])
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  return JSON.stringify(answer);
}

export function mergeLockedAnswers(row, incoming, snapshot) {
  const saved = JSON.parse(row.answers);
  const checked = JSON.parse(row.checked || "{}");
  const clean = validateAnswers(incoming, snapshot);
  for (const [id, answer] of Object.entries(clean)) {
    if (Object.hasOwn(checked, id)) {
      const question = snapshot.questions.find(
        (question) => question.id === id,
      );
      if (
        canonicalAnswer(question, saved[id]) !==
        canonicalAnswer(question, answer)
      )
        fail(409, "Ответ уже проверен и не может быть изменён.");
    } else
      Object.defineProperty(saved, id, {
        value: answer,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return saved;
}
