import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store, libraryPath, BACKUP_TABLE_COLUMNS } from "./db.js";
import type { LibraryId } from "../domain/types.js";
import { SCHEMA_VERSION } from "./schema.js";

const BACKUP_PACK_KEYS = new Set(["schemaVersion", "kind", "library", "exportedAt", "data", "manifest"]);
const BACKUP_MANIFEST_KEYS = new Set(["schemaVersion", "tables", "counts", "sha256"]);

export function canonical(payload: unknown): string {
  return JSON.stringify(payload);
}

export function digest(payload: unknown): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

export function buildBackup(store: Store, library: LibraryId) {
  const body = store.exportPayload(library);
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.data)) counts[k] = (v as unknown[]).length;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    tables: Object.keys(body.data),
    counts,
    sha256: digest(body.data),
  };
  return { ...body, manifest };
}

export function writeBackupFile(store: Store, library: LibraryId, file: string) {
  const pack = buildBackup(store, library);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(pack, null, 2), "utf8");
  return pack;
}

export function verifyBackup(raw: string): { ok: true; pack: ReturnType<typeof buildBackup> } | { ok: false; reason: string } {
  let pack: ReturnType<typeof buildBackup>;
  try {
    pack = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "备份不是合法 JSON" };
  }
  if (!pack || pack.kind !== "xushang-backup") {
    return { ok: false, reason: "不是续上备份包" };
  }
  if (pack.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `不兼容的备份版本：${pack.schemaVersion}` };
  }
  if (!pack.data || !pack.manifest?.sha256 || digest(pack.data) !== pack.manifest.sha256) {
    return { ok: false, reason: "备份完整性校验失败，当前库未改动" };
  }
  const shaped = assertBackupShape(pack);
  if (!shaped.ok) return shaped;
  return { ok: true, pack };
}

function assertBackupShape(pack: ReturnType<typeof buildBackup>): { ok: true } | { ok: false; reason: string } {
  const extraPack = Object.keys(pack).filter((k) => !BACKUP_PACK_KEYS.has(k));
  if (extraPack.length) {
    return { ok: false, reason: `备份含未授权字段：${extraPack.join("、")}` };
  }
  if (pack.manifest && typeof pack.manifest === "object") {
    const extraManifest = Object.keys(pack.manifest).filter((k) => !BACKUP_MANIFEST_KEYS.has(k));
    if (extraManifest.length) {
      return { ok: false, reason: `备份清单含未授权字段：${extraManifest.join("、")}` };
    }
  }
  if (!pack.data || typeof pack.data !== "object" || Array.isArray(pack.data)) {
    return { ok: false, reason: "备份缺少合法数据表" };
  }
  const extraTables = Object.keys(pack.data).filter((t) => !(t in BACKUP_TABLE_COLUMNS));
  if (extraTables.length) {
    return { ok: false, reason: `备份含未授权表：${extraTables.join("、")}` };
  }
  for (const [table, cols] of Object.entries(BACKUP_TABLE_COLUMNS)) {
    const rows = pack.data[table] as unknown;
    if (rows === undefined) return { ok: false, reason: `备份缺少数据表 ${table}` };
    if (!Array.isArray(rows)) return { ok: false, reason: `备份表 ${table} 不是数组` };
    const allowed = new Set(cols);
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return { ok: false, reason: `备份表 ${table} 含非法行` };
      }
      const extraCols = Object.keys(row).filter((k) => !allowed.has(k));
      if (extraCols.length) {
        return { ok: false, reason: `备份表 ${table} 含未授权字段：${extraCols.join("、")}` };
      }
    }
  }
  return { ok: true };
}

export function restoreToEmptyOrSwap(opts: {
  dataRoot: string;
  library: LibraryId;
  raw: string;
  current: Store;
}): { ok: true } | { ok: false; reason: string } {
  const v = verifyBackup(opts.raw);
  if (!v.ok) return v;
  const target = libraryPath(opts.dataRoot, opts.library);
  const suffix = randomUUID();
  const snapshot = join(opts.dataRoot, opts.library, `pre-restore-${suffix}.db`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(opts.dataRoot, opts.library, `restore-tmp-${suffix}.db`);
  const next = new Store({ path: tmp });
  try {
    // 完整构建并校验新库后，才碰当前库。
    loadPack(next, v.pack);
    if (next.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("备份含损坏的引用，原库未替换");
    const integrity = next.db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    if (Object.values(integrity)[0] !== "ok") throw new Error("备份数据库校验失败，原库未替换");
    next.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    next.close();
    opts.current.db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    opts.current.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    opts.current.close();
    if (existsSync(target + "-wal")) rmSync(target + "-wal");
    if (existsSync(target + "-shm")) rmSync(target + "-shm");
    // 同目录原子替换，不先删除旧库。失败时旧文件仍在。
    renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    try {
      next.close();
    } catch {
      /* ignore */
    }
    for (const s of ["", "-wal", "-shm"]) if (existsSync(tmp + s)) rmSync(tmp + s);
    return { ok: false, reason: e instanceof Error ? e.message : "恢复失败，原库未替换" };
  }
}

function loadPack(store: Store, pack: ReturnType<typeof buildBackup>) {
  store.tx(() => {
    const order = Object.keys(BACKUP_TABLE_COLUMNS);
    for (const t of [...order].reverse()) {
      store.db.prepare(`DELETE FROM ${t}`).run();
    }
    for (const t of order) {
      const allowed = BACKUP_TABLE_COLUMNS[t];
      const rows = pack.data[t] as Record<string, unknown>[] | undefined;
      if (!rows?.length) continue;
      for (const row of rows) {
        const keys = allowed.filter((k) => k in row);
        if (!keys.length) continue;
        const sql = `INSERT INTO ${t}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
        store.db.prepare(sql).run(...keys.map((k) => row[k] as string | number | null));
      }
    }
  });
}

export function vacuumConsistentCopy(fromDb: string, toFile: string) {
  const s = new Store({ path: fromDb });
  mkdirSync(dirname(toFile), { recursive: true });
  s.db.exec(`VACUUM INTO '${toFile.replaceAll("'", "''")}'`);
  s.close();
}

export function readUtf8(file: string): string {
  return readFileSync(file, "utf8");
}
