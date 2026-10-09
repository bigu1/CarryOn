export type LibraryId = "personal" | "demo";

let csrf = "";
let library: LibraryId = "personal";

export function currentLibrary(): LibraryId {
  return library;
}

async function parse(res: Response) {
  const data = await res.json().catch(() => ({ error: `请求失败 ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

export async function boot() {
  const data = await parse(await fetch("/api/session"));
  csrf = data.csrf;
  library = data.library;
  return data;
}

export async function switchLibrary(next: LibraryId) {
  const data = await post("/api/library", { library: next });
  library = data.library;
  return data;
}

/** 浏览器下载一段文本，不经过服务器存盘。 */
export function downloadText(filename: string, text: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("x-xushang-csrf", csrf);
    if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 403 && path !== "/api/session") {
    await boot();
    headers.set("x-xushang-csrf", csrf);
    return parse(await fetch(path, { ...init, headers }));
  }
  return parse(res);
}

export const get = (path: string) => api(path);
export const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api(path, { method: "DELETE" });
