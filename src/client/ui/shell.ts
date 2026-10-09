import { createContext, useContext } from "react";
import type { LibraryId } from "../api";

export type Shell = { library: LibraryId; setLibrary: (l: LibraryId) => void; pending: number; modelConfigured: boolean; refresh: () => void };
export const ShellContext = createContext<Shell>({ library: "personal", setLibrary: () => {}, pending: 0, modelConfigured: false, refresh: () => {} });
export const useShell = () => useContext(ShellContext);
