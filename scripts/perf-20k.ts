/**
 * 构造约 2 万条消息、1 千会话的合成库，测量本地检索。
 * 固定种子 20260916。不调用真实模型。不加入默认 vitest。
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { cpus, totalmem, freemem, tmpdir, release } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.js";
import { documentToPreviews } from "../src/importers/json.js";
import { createApp } from "../src/server/app.js";
import type { Runtime } from "../src/server/runtime.js";
import type { JsonV1Document } from "../src/domain/types.js";

const SEED = 20260916;
const SESSIONS = 1000;
const MESSAGES_PER = 20;
const PERF_PARENT = process.env.XUSHANG_PERF_DIR ?? tmpdir();
mkdirSync(PERF_PARENT, { recursive: true });
const DATA_ROOT = mkdtempSync(join(PERF_PARENT, "xushang-perf-20k-"));
const REPORT = process.env.XUSHANG_PERF_REPORT ?? "/tmp/xushang-perf-20k-report.json";

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const PAD_ZH = "这段合成正文只用于容量测试，不是真实聊天。".repeat(14);
const PAD_EN = "Synthetic filler for capacity testing, not a real chat. ".repeat(18);

const MARKERS = [
  "买菜",
  "番茄炒蛋",
  "周末采购",
  "本地保存",
  "decision-token",
  "handoff-ready",
  "🍅",
];

function messageText(session: number, seq: number): string {
  const zh = rand() > 0.35;
  const pad = zh ? PAD_ZH : PAD_EN;
  const extra = MARKERS[(session + seq) % MARKERS.length];
  return `会话${session}第${seq}句 ${extra} ${pad}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const QUERIES: string[] = [
  "菜",
  "买菜",
  "番茄炒蛋",
  "周末采购",
  "本地保存",
  "decision-token",
  "handoff-ready",
  "🍅",
  "会话1第0句",
  "会话500第10句",
  "会话999第19句",
  "Synthetic",
  "capacity",
  "testing",
  "chat",
  "filler",
  "不是真实",
  "容量测试",
  "合成正文",
  "第0句",
  "第19句",
  "会话0",
  "会话999",
  "tomato",
  "decision",
  "ready",
  "保存",
  "采购",
  "周末",
  "炒蛋",
  "番茄",
  "本地",
  "token",
  "handoff",
  "会话10第5句",
  "会话42第7句",
  "会话100第1句",
  "会话250第3句",
  "会话750第12句",
  "这段合成",
  "real chat",
  "for capacity",
  "第10句",
  "第5句",
  "买",
  "蛋",
  "not-a-hit-zzzz",
  "abcdefghijk",
  "不存在的词xyz",
  "会话中文短词检索",
];

async function sessionReq(app: ReturnType<typeof createApp>, port: number, cookies: Map<string, string>) {
  const headers = new Headers();
  headers.set("host", `127.0.0.1:${port}`);
  if (cookies.size) headers.set("cookie", [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await app.request("/api/session", { headers });
  const raw = res.headers.get("set-cookie");
  if (raw) {
    for (const part of raw.split(/,(?=[^;]+?=)/)) {
      const kv = part.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  return res;
}

async function searchOnce(
  app: ReturnType<typeof createApp>,
  port: number,
  cookies: Map<string, string>,
  q: string,
): Promise<{ ms: number; total: number }> {
  const headers = new Headers();
  headers.set("host", `127.0.0.1:${port}`);
  if (cookies.size) headers.set("cookie", [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
  const t0 = performance.now();
  const res = await app.request(`/api/search?q=${encodeURIComponent(q)}`, { headers });
  const body = (await res.json()) as { total: number };
  const ms = performance.now() - t0;
  return { ms, total: Number(body.total) };
}

async function main() {
  mkdirSync(join(DATA_ROOT, "personal"), { recursive: true });
  const dbPath = join(DATA_ROOT, "personal", "xushang.db");
  const store = new Store({ path: dbPath });
  const buildStarted = Date.now();
  for (let s = 0; s < SESSIONS; s++) {
    const doc: JsonV1Document = {
      schemaVersion: 1,
      conversations: [
        {
          title: `合成会话 ${s}`,
          occurredAt: `2026-01-${String((s % 28) + 1).padStart(2, "0")}`,
          messages: Array.from({ length: MESSAGES_PER }, (_, seq) => ({
            role: seq % 2 === 0 ? "user" : "assistant",
            text: messageText(s, seq),
          })),
        },
      ],
    };
    const previews = documentToPreviews(doc, "synthetic");
    const result = store.importConfirmed(previews[0]);
    if (result.status !== "created") {
      throw new Error(`会话 ${s} 未创建：${result.status}`);
    }
  }
  const buildMs = Date.now() - buildStarted;
  const msgCount = Number((store.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
  const sourceCount = Number((store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n);
  const charLen = Number(
    (store.db.prepare("SELECT COALESCE(SUM(LENGTH(text)),0) AS n FROM messages").get() as { n: number }).n,
  );
  const bytes = Number(
    (store.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))),0) AS n FROM messages").get() as { n: number }).n,
  );
  const sqliteVersion = String((store.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v);
  const indexes = store.db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  store.close();

  const rt: Runtime = {
    dataRoot: DATA_ROOT,
    port: 43999,
    stores: new Map(),
    previews: new Map(),
    abort: new Map(),
  };
  const app = createApp(rt);
  const cookies = new Map<string, string>();
  await sessionReq(app, rt.port, cookies);

  const cold = await searchOnce(app, rt.port, cookies, "买菜");
  const warm: Array<{ q: string; ms: number; total: number }> = [];
  for (const q of QUERIES) {
    warm.push({ q, ...(await searchOnce(app, rt.port, cookies, q)) });
  }
  const warmMs = warm.map((x) => x.ms);
  const report = {
    date: new Date().toISOString(),
    seed: SEED,
    os: `${process.platform} ${process.arch}`,
    kernel: release(),
    node: process.version,
    sqlite: sqliteVersion,
    cpus: cpus().map((c) => c.model),
    cpuCount: cpus().length,
    totalmemMiB: Math.round(totalmem() / 1024 / 1024),
    freememMiB: Math.round(freemem() / 1024 / 1024),
    dataRoot: DATA_ROOT,
    dbPath,
    dbBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
    journal: "WAL",
    indexes,
    sessions: sourceCount,
    messages: msgCount,
    bodyChars: charLen,
    bodyBytes: bytes,
    bodyMiB: Number((bytes / 1024 / 1024).toFixed(3)),
    buildMs,
    coldQuery: "买菜",
    coldMs: cold.ms,
    coldHits: cold.total,
    warmQueries: QUERIES.length,
    warmMs,
    p50Ms: percentile(warmMs, 50),
    p95Ms: percentile(warmMs, 95),
    p99Ms: percentile(warmMs, 99),
    maxMs: Math.max(...warmMs),
    minMs: Math.min(...warmMs),
    details: warm,
    note: "只代表此运行环境中的合成资料检索，不代表真实资料或其他系统上的体验。",
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
  const lines = [
    `seed=${SEED}`,
    `os=${report.os} node=${report.node} sqlite=${sqliteVersion}`,
    `sessions=${sourceCount} messages=${msgCount} bodyChars=${charLen} bodyBytes=${bytes} bodyMiB=${report.bodyMiB} dbBytes=${report.dbBytes}`,
    `indexes=${indexes.map((i) => i.name).join(",") || "(none extra)"} journal=WAL`,
    `buildMs=${buildMs}`,
    `cold q=买菜 ms=${cold.ms.toFixed(2)} hits=${cold.total}`,
    `warm n=${QUERIES.length} p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms p99=${report.p99Ms.toFixed(2)}ms min=${report.minMs.toFixed(2)} max=${report.maxMs.toFixed(2)}`,
    `report=${REPORT}`,
  ];
  writeFileSync(REPORT.replace(/\.json$/, ".txt"), lines.join("\n") + "\n", "utf8");
  for (const line of lines) console.log(line);
  for (const s of rt.stores.values()) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
