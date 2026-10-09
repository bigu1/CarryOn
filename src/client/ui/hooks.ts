import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "../api";

/** 读取一个接口：加载中 / 失败 / 数据，外加重新加载。 */
export function useLoad<T = Record<string, any>>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = (await get(path)) as T;
      if (n === seq.current) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** 包一层异步操作：忙碌状态和错误信息贴在按钮旁。 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
