import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { boot, currentLibrary, get, type LibraryId } from "./api";
import { HomePage } from "./pages/HomePage";
import { ImportPage } from "./pages/ImportPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SourceDetailPage } from "./pages/SourceDetailPage";
import { TopicsPage } from "./pages/TopicsPage";
import { TopicDetailPage } from "./pages/TopicDetailPage";
import { ReviewPage } from "./pages/ReviewPage";
import { AnswerPage } from "./pages/AnswerPage";
import { HandoffPage } from "./pages/HandoffPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Loading, Notice } from "./ui/kit";
import { ShellContext } from "./ui/shell";
import { APP_NAME, APP_NAME_ZH, APP_DISPLAY_NAME } from "../shared/brand";


const NAV: Array<{ title?: string; links: Array<{ to: string; label: string; end?: boolean; count?: boolean }> }> = [
  { links: [{ to: "/", label: "开始", end: true }] },
  { title: "找回", links: [{ to: "/answers", label: "查找与回答" }] },
  { title: "整理", links: [{ to: "/topics", label: "主题" }, { to: "/review", label: "待核对", count: true }] },
  { title: "交接", links: [{ to: "/handoff", label: "交接说明" }] },
  { title: "资料", links: [{ to: "/sources", label: "全部资料" }, { to: "/import", label: "添加聊天" }] },
  { links: [{ to: "/settings", label: "设置与数据" }] },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [library, setLibrary] = useState<LibraryId>(currentLibrary());
  const [pending, setPending] = useState(0);
  const [modelConfigured, setModelConfigured] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    boot()
      .then((s) => {
        setLibrary(s.library);
        setModelConfigured(!!s.model?.configured);
        setReady(true);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  const refresh = useCallback(() => {
    void get("/api/home")
      .then((d) => {
        setPending(Number(d.pending ?? 0));
        setModelConfigured(!!d.modelConfigured);
        setLibrary(d.library);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, loc.pathname, library, refresh]);

  if (err) {
    return (
      <main className="main">
        <div className="page narrow">
          <Notice tone="bad" title={`${APP_DISPLAY_NAME} 打不开`}>
            {err}。请确认 CarryOn 启动窗口还开着，然后刷新页面。
          </Notice>
        </div>
      </main>
    );
  }
  if (!ready) {
    return (
      <main className="main">
        <Loading>正在打开本地资料库…</Loading>
      </main>
    );
  }

  return (
    <ShellContext.Provider value={{ library, setLibrary, pending, modelConfigured, refresh }}>
      <div className="shell">
        <a className="skip-link" href="#main">跳到主要内容</a>
        <nav className="side" aria-label="主导航">
          <div className="brand">
            <NavLink to="/" className="brand-name">
              <span className="brand-mark" aria-hidden="true">↳</span>{APP_NAME}
            </NavLink>
            <p className="brand-sub">{APP_NAME_ZH} · 让讨论接着进行</p>
          </div>
          {NAV.map((g, i) => (
            <div className="nav-group" key={i}>
              {g.title ? <div className="nav-group-title">{g.title}</div> : null}
              {g.links.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.end} className="nav-link">
                  <span>{l.label}</span>
                  {l.count && pending > 0 ? <span className="nav-count" aria-label={`${pending} 条待核对`}>{pending}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="side-foot">
            <div className={`lib-pill${library === "demo" ? " demo" : ""}`}>当前：{library === "demo" ? "演示库" : "个人库"}</div>
            <div>{modelConfigured ? "模型已连接（本次运行）" : "未连接模型，本地功能都可用"}</div>
          </div>
        </nav>
        <main className="main" id="main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/sources/:id" element={<SourceDetailPage />} />
            <Route path="/topics" element={<TopicsPage />} />
            <Route path="/topics/:id" element={<TopicDetailPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/answers" element={<AnswerPage />} />
            <Route path="/handoff" element={<HandoffPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<div className="page"><Notice tone="warn" title="没有这个页面" /></div>} />
          </Routes>
        </main>
      </div>
    </ShellContext.Provider>
  );
}
