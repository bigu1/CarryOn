import { serve } from "@hono/node-server";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { DEFAULT_PORT } from "../shared/limits.js";
import { createApp } from "./app.js";
import type { Runtime } from "./runtime.js";

function parsePort(): number {
  const n = Number(process.env.XUSHANG_PORT ?? DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

export function createRuntime(): Runtime {
  const dataRoot = resolve(process.env.XUSHANG_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataRoot, { recursive: true });
  return {
    dataRoot,
    port: parsePort(),
    stores: new Map(),
    previews: new Map(),
    abort: new Map(),
  };
}

async function main() {
  const runtime = createRuntime();
  const app = createApp(runtime);
  const isProd = process.env.NODE_ENV === "production";
  const dist = join(process.cwd(), "dist");
  const hostname = process.env.XUSHANG_HOST ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    console.error("续上默认只监听本机回环地址。拒绝绑定", hostname);
    process.exit(1);
  }

  if (isProd && existsSync(join(dist, "index.html"))) {
    app.use("/*", serveStatic({ root: "./dist" }));
    app.get("*", (c) => c.html(readFileSync(join(dist, "index.html"), "utf8")));
    const server = serve({ fetch: app.fetch, hostname, port: runtime.port }, (info) => {
      onListen(runtime, info.port);
    });
    hookShutdown(server, runtime);
    return;
  }

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  const api = getRequestListener(app.fetch);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/api")) {
      void api(req, res);
      return;
    }
    vite.middlewares(req, res, () => {
      void api(req, res);
    });
  });
  server.listen(runtime.port, hostname, () => onListen(runtime, runtime.port));
  hookShutdown(server, runtime);
}

function onListen(runtime: Runtime, port: number) {
  const url = `http://127.0.0.1:${port}`;
  console.log(`续上已打开：${url}`);
  console.log(`资料目录：${runtime.dataRoot}`);
  const pidFile = process.env.XUSHANG_PID_FILE ?? join(runtime.dataRoot, "xushang.pid");
  const portFile = process.env.XUSHANG_PORT_FILE ?? join(runtime.dataRoot, "xushang.port");
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid), "utf8");
  writeFileSync(portFile, String(port), "utf8");
}

function hookShutdown(server: { close: (cb?: () => void) => void }, runtime: Runtime) {
  const shutdown = () => {
    server.close();
    for (const s of runtime.stores.values()) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
