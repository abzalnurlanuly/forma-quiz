import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";

const dataDir = resolve(process.env.DATA_DIR || "data");
const source = resolve(process.argv[2] || "");
const backupRoot = join(dataDir, "backups");
const rel = relative(backupRoot, source);
if (
  !process.argv[2] ||
  !rel ||
  rel.startsWith("..") ||
  isAbsolute(rel) ||
  process.argv[3] !== "--stopped-service"
) {
  throw new Error(
    "Остановите приложение. Использование: node scripts/restore.js /app/data/backups/ИМЯ_КОПИИ --stopped-service",
  );
}
const manifest = JSON.parse(
  readFileSync(join(source, "manifest.json"), "utf8"),
);
if (manifest.product !== "forma-quiz" || manifest.version !== 1)
  throw new Error("Неизвестный формат копии.");
const check = new DatabaseSync(join(source, "quiz.sqlite"), { readOnly: true });
try {
  if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("Повреждённая копия.");
} finally {
  check.close();
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// Preserve the previous database before replacing it. Run ONLY with the app stopped.
if (existsSync(join(dataDir, "quiz.sqlite"))) {
  const previous = new DatabaseSync(join(dataDir, "quiz.sqlite"));
  try {
    await backup(
      previous,
      join(dataDir, `before-restore-${Date.now()}.sqlite`),
    );
  } finally {
    previous.close();
  }
}
for (const suffix of ["-wal", "-shm"])
  rmSync(join(dataDir, `quiz.sqlite${suffix}`), { force: true });
cpSync(join(source, "quiz.sqlite"), join(dataDir, "quiz.sqlite"));
if (existsSync(join(source, "uploads")))
  cpSync(join(source, "uploads"), join(dataDir, "uploads"), {
    recursive: true,
  });
console.log(
  "Копия восстановлена. Теперь запустите сервис. Сессии и ограничения попыток возвращены к состоянию копии.",
);
