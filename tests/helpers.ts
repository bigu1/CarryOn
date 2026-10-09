import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import type { Runtime } from "../src/server/runtime.js";

export function testRuntime(port = 43173): Runtime {
  return {
    dataRoot: mkdtempSync(join(tmpdir(), "xushang-")),
    port,
    stores: new Map(),
    previews: new Map(),
    abort: new Map(),
  };
}

export function testApp(port = 43173) {
  const rt = testRuntime(port);
  const app = createApp(rt);
  const cookies = new Map<string, string>();

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function absorb(res: Response) {
    const raw = res.headers.get("set-cookie");
    if (!raw) return;
    for (const part of raw.split(/,(?=[^;]+?=)/)) {
      const kv = part.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  async function req(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", `127.0.0.1:${port}`);
    if (init.method && init.method !== "GET") {
      headers.set("origin", `http://127.0.0.1:${port}`);
      if (cookies.has("xushang_csrf")) headers.set("x-xushang-csrf", cookies.get("xushang_csrf")!);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    }
    if (cookies.size) headers.set("cookie", cookieHeader());
    const res = await app.request(path, { ...init, headers });
    absorb(res);
    return res;
  }

  async function session() {
    const res = await req("/api/session");
    const data = await res.json();
    cookies.set("xushang_csrf", data.csrf);
    return data;
  }

  return { rt, app, req, session, cookies };
}
