import { Store, libraryPath } from "../storage/db.js";
import type { LibraryId } from "../domain/types.js";
import type { ImportPreview } from "../domain/types.js";
import type { ModelConfig } from "../ai/client.js";

export interface Runtime {
  dataRoot: string;
  port: number;
  stores: Map<LibraryId, Store>;
  previews: Map<string, ImportPreview & { library?: LibraryId }>;
  model?: ModelConfig;
  abort: Map<string, AbortController>;
}

export function getStore(rt: Runtime, library: LibraryId): Store {
  let s = rt.stores.get(library);
  if (!s) {
    s = new Store({ path: libraryPath(rt.dataRoot, library) });
    rt.stores.set(library, s);
  }
  return s;
}

export function reopenStore(rt: Runtime, library: LibraryId): Store {
  const old = rt.stores.get(library);
  try {
    old?.close();
  } catch {
    /* ignore */
  }
  const s = new Store({ path: libraryPath(rt.dataRoot, library) });
  rt.stores.set(library, s);
  return s;
}
