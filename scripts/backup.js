import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  cpSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";

const dataDir = resolve(process.env.DATA_DIR || "data");
const databasePath = join(dataDir, "quiz.sqlite");
if (!existsSync(databasePath))
  throw new Error("База не найдена. Сначала запустите приложение.");
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const destination = join(dataDir, "backups", stamp);
mkdirSync(destination, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  await backup(db, join(destination, "quiz.sqlite"));
  const check = new DatabaseSync(join(destination, "quiz.sqlite"), {
    readOnly: true,
  });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Проверка резервной копии не пройдена.");
  } finally {
    check.close();
  }
  // Uploads are append-only. Copy after the DB snapshot so every referenced file exists.
  if (existsSync(join(dataDir, "uploads")))
    cpSync(join(dataDir, "uploads"), join(destination, "uploads"), {
      recursive: true,
    });
  chmodSync(join(destination, "quiz.sqlite"), 0o600);
  writeFileSync(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        product: "forma-quiz",
        version: 1,
        createdAt: new Date().toISOString(),
        database: "quiz.sqlite",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Резервная копия проверена: ${destination}`);
} finally {
  db.close();
}
