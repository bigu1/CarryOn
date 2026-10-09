import { Hono } from "hono";
import type { LibraryId } from "../domain/types.js";
import { getStore, type Runtime } from "./runtime.js";

export type Env = { Variables: { rt: Runtime; library: LibraryId } };

type Ctx = { get: (k: string) => unknown };

export const lib = (c: Ctx) => c.get("library") as LibraryId;
export const rt = (c: Ctx) => c.get("rt") as Runtime;
export const storeOf = (c: Ctx) => getStore(rt(c), lib(c));

export function router() {
  return new Hono<Env>();
}

export function errMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}
