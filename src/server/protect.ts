import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { id } from "../shared/ids.js";

export const SESSION_COOKIE = "xushang_session";
export const CSRF_COOKIE = "xushang_csrf";
export const LIBRARY_COOKIE = "xushang_library";

const sessions = new Map<string, { csrf: string; createdAt: number }>();

export function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (!allowedHost(u.host)) return false;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return p === port;
  } catch {
    return false;
  }
}

export function ensureSession(c: Context): { sid: string; csrf: string } {
  // 同一请求里中间件和路由都会调用；第一次新建后复用，避免一次访问发出两套会话
  const already = c.get("session" as never) as { sid: string; csrf: string } | undefined;
  if (already) return already;
  let sid = getCookie(c, SESSION_COOKIE);
  let rec = sid ? sessions.get(sid) : undefined;
  if (!sid || !rec) {
    sid = id();
    rec = { csrf: id(), createdAt: Date.now() };
    sessions.set(sid, rec);
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    setCookie(c, CSRF_COOKIE, rec.csrf, {
      httpOnly: false,
      sameSite: "Strict",
      path: "/",
    });
  }
  const out = { sid, csrf: rec.csrf };
  c.set("session" as never, out as never);
  return out;
}

export async function protect(c: Context, next: Next) {
  const host = c.req.header("host");
  if (!allowedHost(host)) {
    return c.json({ error: "拒绝非本机 Host" }, 403);
  }
  const rt = c.get("rt") as { port?: number } | undefined;
  const port = Number(rt?.port ?? process.env.XUSHANG_PORT ?? 43173);
  const method = c.req.method.toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutating) {
    const origin = c.req.header("origin");
    if (!origin) {
      return c.json({ error: "写操作需要 Origin，已拒绝来源不明的请求" }, 403);
    }
    if (!allowedOrigin(origin, port)) {
      return c.json({ error: "跨源写请求已拒绝" }, 403);
    }
    const { csrf } = ensureSession(c);
    const sent = c.req.header("x-xushang-csrf") ?? "";
    if (sent !== csrf) {
      return c.json({ error: "缺少或错误的本机校验令牌" }, 403);
    }
  } else {
    ensureSession(c);
  }
  await next();
}

export function getLibraryCookie(c: Context): "personal" | "demo" {
  const v = getCookie(c, LIBRARY_COOKIE);
  return v === "demo" ? "demo" : "personal";
}
