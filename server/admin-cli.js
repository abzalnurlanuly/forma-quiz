import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  passwordHash,
  validCredentials,
  transaction,
} from "./db.js";

const arguments_ = process.argv.slice(2);
const usernameFlag = arguments_.indexOf("--username");
const passwordStdin = arguments_.includes("--password-stdin");
if (
  arguments_.some(
    (arg, index) =>
      !["--username", "--password-stdin", "--reset-password"].includes(arg) &&
      index !== usernameFlag + 1,
  )
) {
  console.error(
    "Команда: npm run admin:create -- [--username admin] [--password-stdin] [--reset-password]",
  );
  process.exit(1);
}
let username = usernameFlag >= 0 ? arguments_[usernameFlag + 1] : undefined;
let password;
let hidden = false;
let rl;
try {
  if (passwordStdin) {
    if (!username)
      throw new Error("Вместе с --password-stdin укажите --username.");
    let input = "";
    for await (const chunk of stdin) {
      input += chunk;
      if (input.length > 512)
        throw new Error("Введённый пароль слишком длинный.");
    }
    password = input.replace(/\r?\n$/, "");
  } else {
    if (!stdin.isTTY)
      throw new Error(
        "Нужен интерактивный терминал. Для передачи через stdin используйте --username и --password-stdin.",
      );
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!hidden) stdout.write(chunk);
        callback();
      },
    });
    rl = createInterface({ input: stdin, output, terminal: true });
    if (!username) username = await rl.question("Логин администратора: ");
    stdout.write("Пароль (12–128 символов, ввод скрыт): ");
    hidden = true;
    password = await rl.question("");
    hidden = false;
    stdout.write("\nПовторите пароль (ввод скрыт): ");
    hidden = true;
    const confirm = await rl.question("");
    hidden = false;
    stdout.write("\n");
    if (password !== confirm) throw new Error("Пароли не совпадают.");
  }
  if (!validCredentials(username, password))
    throw new Error(
      "Логин: 3–64 латинских символа, цифры или ._-; пароль: 12–128 символов.",
    );
  const db = openDatabase(
    resolve(
      process.env.DATA_DIR ||
        resolve(dirname(fileURLToPath(import.meta.url)), "../data"),
    ),
  );
  try {
    const stored = await passwordHash(password);
    password = undefined;
    transaction(db, () => {
      const old = db
        .prepare("SELECT id FROM admins WHERE username = ? COLLATE NOCASE")
        .get(username);
      if (!old && db.prepare("SELECT 1 FROM admins LIMIT 1").get())
        throw new Error(
          "На сайте разрешена только одна учётная запись администратора. Для смены пароля используйте существующий логин и --reset-password.",
        );
      if (old && !arguments_.includes("--reset-password"))
        throw new Error(
          "Администратор уже существует. Укажите --reset-password, чтобы заменить пароль и завершить все его сессии.",
        );
      if (old) {
        db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(
          stored,
          old.id,
        );
        db.prepare("DELETE FROM sessions WHERE admin_id = ?").run(old.id);
      } else
        db.prepare(
          "INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)",
        ).run(randomUUID(), username, stored, new Date().toISOString());
    });
    stdout.write(
      "Учётная запись администратора сохранена. Пароль не выведен в журнал.\n",
    );
  } finally {
    db.close();
  }
} catch (error) {
  hidden = false;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
