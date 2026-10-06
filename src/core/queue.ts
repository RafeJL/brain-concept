import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs `work` for `key` unless another process already is, across processes (git hooks start
 * one each). A trigger that arrives while a run is going leaves a pending marker and returns
 * "queued"; the running process sees it when it finishes and runs `work` again, so the last
 * trigger is always covered by a run that started after it. A lock whose process has died is
 * taken over.
 */
export async function runQueued(dir: string, key: string, work: () => Promise<void>): Promise<"ran" | "queued"> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${key}.lock`);
  const pending = join(dir, `${key}.pending`);

  if (!tryLock(lock)) {
    writeFileSync(pending, "");
    // The holder may have finished between our attempt and the marker; if so, run it ourselves.
    if (!tryLock(lock)) return "queued";
  }
  try {
    for (;;) {
      rmSync(pending, { force: true });
      await work();
      if (!existsSync(pending)) break;
    }
  } finally {
    rmSync(lock, { force: true });
  }
  // A marker left between the last check and releasing the lock: whoever wrote it may have given up.
  if (existsSync(pending)) await runQueued(dir, key, work);
  return "ran";
}

function tryLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (holderAlive(lock)) return false;
      rmSync(lock, { force: true });
    }
  }
  return false;
}

function holderAlive(lock: string): boolean {
  const pid = Number(readFileSync(lock, "utf8").trim());
  // No pid yet: just created and being written, unless it was left like that long ago.
  if (!pid) return Date.now() - statSync(lock).mtimeMs < 10_000;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
