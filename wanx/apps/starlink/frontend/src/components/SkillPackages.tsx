import { useEffect, useRef, useState } from "react";
import { downloadBlob, skillRequest, skillUrl, states, type Summary, type Page } from "../skills";
import "../skills.css";

type Package = { skill: Summary; version: string | null; files: { path: string; size_bytes: number }[] };
type FileContent = { path: string; version: string | null; text: string };
type Tree = { name: string; path: string; children: Tree[]; file: boolean };
export function fileTree(paths: string[]): Tree[] {
  const roots: Tree[] = [];
  for (const path of [...paths].sort()) {
    let siblings = roots;
    const parts = path.split("/");
    parts.forEach((name, index) => {
      let node = siblings.find(item => item.name === name);
      if (!node) { node = { name, path: parts.slice(0, index + 1).join("/"), children: [], file: index === parts.length - 1 }; siblings.push(node); }
      siblings = node.children;
    });
  }
  return roots;
}
function Files({ nodes, selected, busy, select }: { nodes: Tree[]; selected: string; busy: boolean; select: (path: string) => void }) {
  return <ul className="skill-file-tree">{nodes.map(node => <li key={node.path}>{node.file
    ? <button disabled={busy} aria-current={selected === node.path ? "true" : undefined} onClick={() => select(node.path)}>{node.name}</button>
    : <details open><summary>{node.name}/</summary><Files nodes={node.children} selected={selected} busy={busy} select={select} /></details>}</li>)}</ul>;
}

export default function SkillPackages({ workspace, mode = "standalone" }: { workspace: string; mode?: "standalone" | "managed" }) {
  const [credential, setCredential] = useState("");
  const [token, setToken] = useState("");
  return <section className="skill-workbench"><header className="section-title"><h2>推理方法</h2><span>工作空间 {workspace}</span></header>
    {mode === "managed" && !token ? <form className="skill-login" onSubmit={e => { e.preventDefault(); setToken(credential); setCredential(""); }}>
      <label>管理凭据<input type="password" autoComplete="off" required minLength={32} value={credential} onChange={e => setCredential(e.target.value)} /></label>
      <button>进入管理</button></form>
    : <PackageSession key={`${workspace}:${mode}:${token}`} workspace={workspace} token={mode === "managed" ? token : ""} />}
  </section>;
}

function PackageSession({ workspace, token }: { workspace: string; token: string }) {
  const [page, setPage] = useState<Page<Summary>>({ items: [], offset: 0, limit: 20, total: 0 });
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Package | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<File | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [invalidate, setInvalidate] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "操作失败，请重试。"); }
    finally { if (operation.current === controller && !controller.signal.aborted) setBusy(false); }
  }
  const request = <T,>(signal: AbortSignal, id = "", suffix = "", query: Record<string, string | number | boolean> = {}, options: RequestInit = {}, blob = false) =>
    skillRequest<T>(token, skillUrl(workspace, id, suffix, query), signal, options, blob);
  async function list(signal: AbortSignal, offset = 0) {
    const value = await request<Page<Summary>>(signal, "", "", { keyword, offset, limit: 20 });
    setPage(value);
  }
  async function open(signal: AbortSignal, item: Summary) {
    // Keep deletion available even when the package or an attachment is damaged.
    setSelected({ skill: item, version: item.default_version, files: [] });
    setContent(null); setDeleting(false); setInvalidate(false);
    const value = await request<Package>(signal, item.id, "/package");
    setSelected(value);
    setContent(await request<FileContent>(signal, item.id, "/package/file", { path: "SKILL.md", ...(value.version ? { version: value.version } : {}) }));
  }
  useEffect(() => { void run(signal => list(signal)); return () => operation.current?.abort(); }, []);
  function selectFile(path: string) {
    if (!selected) return;
    setContent(null);
    void run(async signal => setContent(await request<FileContent>(signal, selected.skill.id, "/package/file", {
      path, ...(selected.version ? { version: selected.version } : {}),
    })));
  }
  return <>
    <div className="skill-intro"><p>上传 Skill ZIP 包，在这里查看、下载或删除，保留方法及引用文件供后续分析使用。</p>
      <p className="hint">每包一个 Skill：根目录放 SKILL.md，也可套一层文件夹。保留 references/ 等多层目录和 Markdown 标题层次。仅支持 UTF-8 文本文件；脚本仅存储和查看，不执行。</p>
      <p className="hint">ZIP 最大 4 MiB，解压后合计 8 MiB、最多 50 个文件、每文件 256 KiB。同名 Skill 不覆盖；请先下载保留旧包，再明确删除或在包内使用新名称。</p>
      <form className="skill-import-form" onSubmit={e => { e.preventDefault(); if (!upload) return; void run(async signal => {
        const form = new FormData(); form.set("workspace_id", workspace); form.set("file", upload);
        const result = await request<Package>(signal, "", "/import-zip", {}, { method: "POST", body: form });
        setUpload(null); if (input.current) input.current.value = "";
        setNotice("导入成功，Skill 已保存。内容的适用性仍需在分析时核对。");
        setSelected(result); setContent(null); setDeleting(false);
        try { await list(signal); await open(signal, result.skill); }
        catch (err) { if (!signal.aborted) setError(`导入已成功，列表或文件刷新失败：${err instanceof Error ? err.message : '请刷新重试'}。无需再次导入。`); }
      }); }}>
        <label>Skill ZIP 文件<input ref={input} type="file" accept=".zip,application/zip" disabled={busy} onChange={e => setUpload(e.target.files?.[0] ?? null)} /></label>
        <button disabled={busy || !upload}>导入 ZIP</button>
      </form>
    </div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="skill-layout"><aside className="skill-sidebar">
      <form onSubmit={e => { e.preventDefault(); void run(signal => list(signal)); }}>
        <label>查找 Skill<input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="名称或说明" /></label>
        <button disabled={busy}>查询 / 刷新</button>
      </form>
      <ul className="skill-list">{page.items.map(item => <li key={item.id}><button disabled={busy} aria-current={selected?.skill.id === item.id ? "true" : undefined} onClick={() => void run(signal => open(signal, item))}>
        {item.title}<small>{item.id} · {states[item.state]}{item.default_version ? ` · ${item.default_version}` : ""}</small></button></li>)}</ul>
      {!page.items.length && !busy && <p>暂无匹配的 Skill，请上传 ZIP。</p>}
      <div className="skill-actions"><button disabled={busy || page.offset === 0} onClick={() => void run(signal => list(signal, Math.max(0, page.offset - page.limit)))}>上一页</button>
        <button disabled={busy || page.offset + page.limit >= page.total} onClick={() => void run(signal => list(signal, page.offset + page.limit))}>下一页</button><span>共 {page.total} 个</span></div>
    </aside><div className="skill-editor">
      {selected ? <><h3>{selected.skill.title}</h3><p>{selected.skill.description}</p>
        {!selected.version && <p>这是旧版草稿，可以下载后整理为 ZIP 再导入。</p>}
        <div className="skill-actions"><button disabled={busy} onClick={() => void run(async signal => {
          const data = await request<Blob>(signal, selected.skill.id, "/package/download", selected.version ? { version: selected.version } : {}, {}, true);
          downloadBlob(data, selected.skill.id + ".zip");
        })}>下载 ZIP</button><button disabled={busy} onClick={() => { setDeleting(true); setInvalidate(false); }}>删除 Skill…</button></div>
        {deleting && <div className="skill-check"><p>确认删除“{selected.skill.title}”？其文件及发布版本将删除，相关准备记录失效。</p>
          <label><input type="checkbox" checked={invalidate} onChange={e => setInvalidate(e.target.checked)} />若其他 Skill 依赖此方法，同时允许这些依赖失效</label>
          <button disabled={busy} onClick={() => void run(async signal => {
            const result = await request<{ cleanup_pending: boolean }>(signal, selected.skill.id, "", { expected_revision: selected.skill.skill_revision,
              expected_draft_revision: selected.skill.draft_revision, confirm: true, invalidate_dependents: invalidate }, { method: "DELETE" });
            const deletedId = selected.skill.id;
            setSelected(null); setContent(null); setDeleting(false);
            setPage(current => ({...current, items: current.items.filter(item => item.id !== deletedId), total: Math.max(0, current.total - 1)}));
            setNotice(result.cleanup_pending ? "Skill 已停用并删除记录，附件文件等待后台清理。" : "Skill 及其附件已删除。");
            try { await list(signal); }
            catch (err) { if (!signal.aborted) setError(`删除已成功，列表刷新失败：${err instanceof Error ? err.message : '请刷新重试'}`); }
          })}>确认删除</button><button disabled={busy} onClick={() => setDeleting(false)}>取消</button></div>}
        <div className="skill-package-view"><nav aria-label="Skill 文件目录"><Files nodes={fileTree(selected.files.map(file => file.path))} selected={content?.path ?? ""} busy={busy} select={selectFile} /></nav>
          <div><h4>{content?.path ?? (busy ? "正在读取文件…" : "文件未能读取，请重试或选择其他文件。")}</h4><pre className="skill-file-content">{content?.text ?? ""}</pre></div></div>
      </> : <p className="empty">选择一个 Skill 查看目录和文档内容。</p>}
    </div></div>
  </>;
}
