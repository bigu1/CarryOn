import { useState } from "react";
import { del, downloadText, get, post, switchLibrary, type LibraryId } from "../api";
import { useShell } from "../ui/shell";
import { useAction, useLoad } from "../ui/hooks";
import { Button, Dialog, ErrorText, Notice, PageHeader, Panel, TextInput } from "../ui/kit";

export function SettingsPage() {
  const shell = useShell();
  const data = useLoad<{ library: LibraryId; dataRoot: string; counts: Record<string, number> }>("/api/data");
  const ai = useLoad<{ configured: boolean; baseUrl: string | null; model: string | null }>("/api/ai/status");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [flash, setFlash] = useState("");
  const [restoreFile, setRestoreFile] = useState<{ name: string; text: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const libAct = useAction();
  const aiAct = useAction();
  const bakAct = useAction();

  async function switchTo(l: LibraryId) {
    const r = await libAct.run(() => switchLibrary(l));
    if (!r) return;
    shell.setLibrary(l);
    shell.refresh();
    await data.reload();
    setFlash(l === "demo" ? "已切换到演示库。" : "已切换到个人库。");
  }

  async function resetDemo() {
    const r = await libAct.run(() => post("/api/demo/reset"));
    setConfirmReset(false);
    if (!r) return;
    shell.refresh();
    await data.reload();
    setFlash("演示库已清空，个人库没有变化。");
  }

  async function saveModel() {
    const r = await aiAct.run(() => post("/api/ai/config", { baseUrl, model, apiKey }));
    if (!r) return;
    setApiKey("");
    shell.refresh();
    await ai.reload();
    setFlash(r.note);
  }

  async function clearModel() {
    await aiAct.run(() => del("/api/ai/config"));
    shell.refresh();
    await ai.reload();
    setFlash("已清除本次运行中的模型凭据。");
  }

  async function backup() {
    const pack = await bakAct.run(() => get("/api/backup"));
    if (!pack) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadText(`续上备份-${shell.library === "demo" ? "演示" : "个人"}-${stamp}.json`, JSON.stringify(pack, null, 2), "application/json");
    setFlash("备份已下载。里面有你的聊天原文，请放在安全的地方。");
  }

  async function restore() {
    if (!restoreFile) return;
    const r = await bakAct.run(() => post("/api/restore", { json: restoreFile.text }));
    setConfirmRestore(false);
    if (!r) return;
    setRestoreFile(null);
    shell.refresh();
    await data.reload();
    setFlash(`已恢复：现在有 ${r.counts.sources} 份资料、${r.counts.cards} 张卡片。原来的库已在资料目录里另存了一份快照。`);
  }

  const counts = data.data?.counts;

  return (
    <div className="page narrow">
      <PageHeader title="设置与数据" lead="资料保存在哪、怎么备份恢复、怎么连接你自己的模型。" />
      {flash ? (
        <Notice tone="ok" role="status">
          {flash}
        </Notice>
      ) : null}

      <Panel title="资料库" hint="个人库和演示库完全分开。演示库只放虚构的合成聊天。">
        <dl className="kv">
          <dt>当前</dt>
          <dd>
            <strong>{shell.library === "demo" ? "演示库" : "个人库"}</strong>
            {counts ? `：${counts.sources} 份资料、${counts.cards} 张有效卡片、${counts.topics} 个主题` : ""}
          </dd>
          <dt>位置</dt>
          <dd>
            <span className="code-path">{data.data?.dataRoot}</span>
          </dd>
          <dt>网络</dt>
          <dd>只在本机 127.0.0.1 上打开，同一网络的其他设备访问不到。</dd>
        </dl>
        <div className="form-actions">
          {shell.library === "demo" ? (
            <>
              <Button tone="primary" busy={libAct.busy} onClick={() => void switchTo("personal")}>
                切回个人库
              </Button>
              <Button tone="danger" onClick={() => setConfirmReset(true)}>
                清空演示库
              </Button>
            </>
          ) : (
            <Button busy={libAct.busy} onClick={() => void switchTo("demo")}>
              切到演示库
            </Button>
          )}
        </div>
        <ErrorText>{libAct.error}</ErrorText>
      </Panel>

      <Panel title="备份与恢复" hint="备份是一个 JSON 文件，包含当前库的聊天原文、卡片和交接，不含模型凭据。">
        <div className="row">
          <Button busy={bakAct.busy} onClick={() => void backup()}>
            下载当前库的备份
          </Button>
        </div>
        <hr className="divider" />
        <p style={{ marginBottom: "0.6rem" }}>
          <strong>从备份恢复</strong>
          <span className="hint">（会用备份替换当前库；替换前自动保存当前库的快照。备份损坏或版本不对时，当前库不会被改动。）</span>
        </p>
        <div className="row">
          <label className="btn">
            选择备份文件
            <input
              type="file"
              accept=".json,application/json"
              className="sr"
              aria-label="选择备份文件"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) setRestoreFile({ name: f.name, text: await f.text() });
              }}
            />
          </label>
          {restoreFile ? (
            <>
              <span className="hint">{restoreFile.name}</span>
              <Button tone="danger" onClick={() => setConfirmRestore(true)}>
                恢复…
              </Button>
            </>
          ) : null}
        </div>
        <ErrorText>{bakAct.error}</ErrorText>
      </Panel>

      <Panel title="模型（可选）" hint="不填也能导入、查找、整理和生成交接。填了才能用提炼、自然语言回答和润色。">
        {ai.data?.configured ? (
          <Notice tone="ok" title="已连接（只在本次运行中有效）">
            {ai.data.model} · {ai.data.baseUrl}
            <div className="notice-actions">
              <Button small onClick={() => void clearModel()}>
                清除凭据
              </Button>
            </div>
          </Notice>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveModel();
          }}
        >
          <div className="fields" style={{ marginTop: "0.8rem" }}>
            <TextInput
              label="服务地址"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…"
              hint="OpenAI 兼容的 /v1/chat/completions。远程必须 HTTPS；本机模型可用 http://127.0.0.1"
            />
            <TextInput label="模型名" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <TextInput
            label="凭据"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            hint="只保存在这次运行的内存里：不写数据库、不进备份、不存浏览器。重启后要重填。每次发送前都会先给你看要发什么。"
          />
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={aiAct.busy} disabled={!baseUrl || !model || !apiKey}>
              连接
            </Button>
          </div>
          <ErrorText>{aiAct.error}</ErrorText>
        </form>
      </Panel>

      <Panel title="停止续上">
        <p>
          在项目目录运行 <span className="code-path">sh scripts/stop.sh</span>。它只结束这个续上实例，认不出来的进程不会动。
        </p>
      </Panel>

      <Dialog
        open={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        title="用备份替换当前库？"
        actions={
          <>
            <Button onClick={() => setConfirmRestore(false)}>取消</Button>
            <Button tone="danger" busy={bakAct.busy} onClick={() => void restore()}>
              确认恢复
            </Button>
          </>
        }
      >
        <p>
          当前是<strong>{shell.library === "demo" ? "演示库" : "个人库"}</strong>
          {counts ? `（${counts.sources} 份资料、${counts.cards} 张卡片）` : ""}。恢复后它会被「{restoreFile?.name}」的内容替换，不会合并。
        </p>
        <p className="hint" style={{ marginTop: "0.5rem" }}>
          替换前会把当前库另存为快照，放在资料目录里。备份校验不通过时什么都不会改。
        </p>
      </Dialog>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="清空演示库？"
        actions={
          <>
            <Button onClick={() => setConfirmReset(false)}>取消</Button>
            <Button tone="danger" busy={libAct.busy} onClick={() => void resetDemo()}>
              清空
            </Button>
          </>
        }
      >
        <p>演示库里的资料和卡片会被删掉。个人库不受影响。</p>
      </Dialog>
    </div>
  );
}
