import { createHash, randomUUID } from "node:crypto";

const activeStates = new Set(["researching", "synthesizing", "reviewing", "revising"]);
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (message, status = 400) => Object.assign(Error(message), { status });
const sourceNames = { space: "个人空间", starlink: "星图", memory: "历史记忆" };
const previewLifetime = 10 * 60_000;
const runLifetime = 5 * 60_000;

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function validateDraft(input) {
  const { task, selection } = input;
  if (typeof task !== "string" || !task.trim() || task.length > 12000 || !task.isWellFormed() || task.includes("\0"))
    throw error("请输入有效的任务目标。");
  if (!object(selection) || Object.keys(selection).some(key => !["folderId", "warehouseId", "memoryAgent"].includes(key)) ||
      Object.values(selection).some(value => !id(value))) throw error("资料范围无效，请重新选择。");
  return { task, selection };
}

function safeText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4000 || value.includes("\0"))
    throw Error("模型返回了无效的方案文本。");
  return value.trim().toWellFormed();
}

function items(value, map) {
  if (!Array.isArray(value) || value.length > 16) throw Error("模型返回了无效的方案结构。");
  return value.map(map);
}

function analysisResult(value, evidence, combined = false) {
  const known = new Set(evidence.map(item => item.id));
  const invalid = [];
  function claim(item, factual = false) {
    const text = safeText(item?.text);
    const ids = [...new Set(items(item.evidenceIds, safeText))];
    const evidenceIds = ids.filter(evidenceId => known.has(evidenceId));
    if (evidenceIds.length !== ids.length || (factual && !evidenceIds.length))
      invalid.push({ severity: "blocking", text: "该结论缺少获准的证据：" + text.slice(0, 300) });
    return { text, evidenceIds };
  }
  const result = { recommendation: claim(value?.recommendation),
    findings: items(value?.findings, item => claim(item, true)), questions: items(value?.questions, safeText) };
  if (combined) result.disagreements = items(value?.disagreements, item => claim(item));
  return { result, invalid };
}

function reviewResult(value) {
  return items(value?.issues, item => {
    if (!["blocking", "advisory"].includes(item?.severity)) throw Error("模型返回了无效的核证结论。");
    return { severity: item.severity, text: safeText(item.text) };
  });
}

function markdown(job) {
  const text = value => value.replace(/[\\`*_\[\]<>#!|~]/g, "\\$&");
  const claim = item => text(item.text) + (item.evidenceIds.length ? " " + item.evidenceIds.map(ref => "[" + ref + "]").join(" ") : "");
  const list = (title, lines) => lines.length ? ["", "## " + title, "", ...lines.map(line => "- " + line)] : [];
  return ["# 研究方案", "", text(job.task), "", "## 推荐方案", "", claim(job.report.recommendation),
    ...list("证据与发现", job.report.findings.map(claim)), ...list("方案分歧", job.report.disagreements.map(claim)),
    ...list("待确认事项", job.report.questions.map(text)),
    ...list("证据出处", job.evidence.map(item => item.id + " · " + sourceNames[item.kind] + " · " + text(item.title) +
      (item.locator.label ? " · " + text(item.locator.label) : "") + "\n\n  " + text(item.text).replaceAll("\n", "\n  "))), ""].join("\n");
}

export function createMyAiCollaboration({ identity, sources, models, store, saveReport, now = Date.now, timeout = runLifetime }) {
  let jobs;
  let queue = Promise.resolve();
  let closed = false;
  const previews = new Map();
  const running = new Map();

  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function load() {
    if (jobs) return;
    const saved = await store.load();
    const records = saved ?? {};
    let changed = false;
    for (const job of Object.values(records)) {
      if (activeStates.has(job.state)) {
        job.state = "interrupted";
        job.updatedAt = now();
        changed = true;
      }
    }
    if (changed) await store.save(records);
    jobs = records;
  }

  function binding(assertScope) {
    assertScope();
    const current = identity();
    if (closed || !current?.owner || !current?.box || !current?.scope) throw error("请先连接当前账号的记忆盒子。", 403);
    const owner = digest(current.owner);
    const box = digest([current.owner, current.box]);
    const account = digest(current.account ?? current.owner);
    const scope = current.scope;
    const checkIdentity = () => {
      const live = identity();
      if (closed || !live?.owner || live.scope !== scope || digest(live.owner) !== owner || digest([live.owner, live.box]) !== box)
        throw error("记忆盒子或账号已切换，请重新预览资料。", 403);
    };
    return { owner, box, account, scope, checkIdentity, check() { assertScope(); checkIdentity(); } };
  }

  function readJob(runId, bound) {
    const job = id(runId) && Object.hasOwn(jobs, runId) && jobs[runId];
    if (!job || job.owner !== bound.owner || job.box !== bound.box) throw error("无法打开该协作任务。", 403);
    return job;
  }

  function publicJob(job) {
    const { owner, box, ...value } = job;
    return structuredClone(value);
  }

  async function update(job, patch) {
    const next = { ...job, ...patch, updatedAt: now() };
    const records = { ...jobs, [next.id]: next };
    await store.save(records);
    jobs = records;
    return next;
  }

  async function verify(selection, evidence, check) {
    const valid = await Promise.all(evidence.map(async item => {
      try { return await sources.verify(selection, item, check); }
      catch { check(); return false; }
    }));
    check();
    if (valid.some(value => !value)) throw error("已确认的资料有变更或已无法读取，请重新预览并确认。");
  }

  async function execute(initial, run) {
    let job = initial;
    const { signal } = run.controller;
    const check = () => { signal.throwIfAborted(); run.bound.checkIdentity(); };
    const persist = patch => serial(async () => {
      check();
      const current = jobs[job.id];
      job = await update(current, typeof patch === "function" ? patch(current) : patch);
    });
    const input = { task: job.task, evidence: job.evidence.map(({ id, text }) => ({ id, text })) };
    const call = async (provider, stage, extra = {}) => {
      check();
      const { output, usage } = await abortable(models.call(provider, stage, { ...input, ...extra }, signal), signal);
      await persist(current => ({ usage: [...current.usage, { provider, stage, ...usage }] }));
      return output;
    };
    const timer = setTimeout(() => run.controller.abort(new DOMException("本次任务已超过执行时限。", "TimeoutError")), timeout);
    timer.unref?.();
    try {
      const checkedPhase = () => { check(); return abortable(verify(job.selection, job.evidence, check), signal); };
      await checkedPhase();
      const independent = await Promise.all(["claude", "gemini"].map(async provider => {
        try {
          const analysis = analysisResult(await call(provider, "research"), job.evidence);
          await persist(current => ({ analyses: { ...current.analyses, [provider]: analysis.result } }));
          return analysis.result;
        } catch (error) {
          run.controller.abort(error);
          throw error;
        }
      }));
      await persist({ state: "synthesizing" });
      await checkedPhase();
      let report = analysisResult(await call("claude", "synthesize", { analyses: independent }), job.evidence, true);
      for (let round = 1; round <= 2; round++) {
        await persist({ state: "reviewing", report: report.result, reviewRound: round });
        await checkedPhase();
        const issues = [...report.invalid, ...reviewResult(await call("gpt", "review", { report: report.result }))];
        await checkedPhase();
        const blocking = issues.filter(issue => issue.severity === "blocking");
        if (!blocking.length || round === 2) {
          await persist({ state: blocking.length ? "needs-review" : "completed", issues });
          return;
        }
        await persist({ state: "revising", issues });
        await checkedPhase();
        report = analysisResult(await call("claude", "revise", { report: report.result, issues: blocking }), job.evidence, true);
      }
    } catch (cause) {
      const current = signal.aborted ? signal.reason : cause;
      const state = current?.name === "AbortError" ? (run.stopState ?? "interrupted") : "failed";
      const failure = state === "failed" ? current?.message || "协作任务未完成。" : undefined;
      await serial(() => update(jobs[job.id], { state, failure }));
    } finally {
      clearTimeout(timer);
      running.delete(run.bound.account);
    }
  }

  function stop(run, state) {
    if (run.controller.signal.aborted) return;
    run.stopState = state;
    run.controller.abort();
  }

  function sync() {
    const live = identity();
    for (const [key, preview] of previews) {
      if (preview.bound.scope !== live?.scope || preview.expiresAt <= now()) previews.delete(key);
    }
    for (const run of running.values()) {
      if (run.bound.scope !== live?.scope) stop(run, "interrupted");
    }
  }

  return {
    sync,
    async close() {
      closed = true;
      previews.clear();
      await queue;
      for (const run of running.values()) stop(run, "interrupted");
      await Promise.allSettled([...running.values()].map(run => run.done));
    },
    async action(action, input = {}, assertScope = () => {}, signal) {
      const recipients = models.recipients;
      const available = recipients.every(recipient => recipient.configured);
      if (action === "config") {
        assertScope();
        return { recipients, available, boxReady: Boolean(identity()?.scope) };
      }
      sync();
      const bound = binding(assertScope);
      if (action === "catalog") {
        if (input.parent !== undefined && !id(input.parent)) throw error("文件夹标识无效。");
        return sources.catalog(input.kind, input.parent ?? "", bound.check);
      }
      if (action === "preview") {
        const draft = validateDraft(input);
        const check = () => { signal?.throwIfAborted(); bound.check(); };
        const { evidence, notices } = await sources.collect(draft.selection, draft.task, check);
        check();
        const previewId = randomUUID();
        const expiresAt = now() + previewLifetime;
        previews.set(previewId, { ...draft, bound, evidence, expiresAt, recipientKey: digest(recipients) });
        if (previews.size > 16) previews.delete(previews.keys().next().value);
        return { previewId, task: draft.task, evidence, notices, recipients, expiresAt };
      }
      if (action === "start") return serial(async () => {
        await load();
        bound.check();
        const { previewId, evidenceIds } = input;
        if (!id(previewId) || !Array.isArray(evidenceIds) || evidenceIds.length > 9 ||
            evidenceIds.some(value => typeof value !== "string" || !/^E[1-9]$/.test(value)) ||
            new Set(evidenceIds).size !== evidenceIds.length)
          throw error("确认的资料片段无效，请返回预览。");
        if (Object.hasOwn(jobs, previewId)) {
          const prior = readJob(previewId, bound);
          if (digest([...evidenceIds].sort()) !== digest(prior.evidence.map(item => item.id).sort()))
            throw error("此预览已经用于另一组片段，请重新预览。");
          return publicJob(prior);
        }
        if (!available) throw error("协作模型尚未全部配置。");
        const preview = previews.get(previewId);
        if (!preview || preview.expiresAt <= now() || preview.bound.scope !== bound.scope ||
            preview.bound.owner !== bound.owner || preview.bound.box !== bound.box || preview.recipientKey !== digest(recipients))
          throw error("资料预览已失效，请重新预览。");
        if (running.has(bound.account)) throw error("当前账号已有正在运行的协作任务。");
        const evidence = preview.evidence.filter(item => evidenceIds.includes(item.id));
        if (evidence.length !== evidenceIds.length) throw error("确认的片段不在本次预览范围内。");
        const job = await update({ id: previewId, owner: bound.owner, box: bound.box, task: preview.task,
          selection: preview.selection, evidence, recipients, createdAt: now(), analyses: {}, usage: [] }, { state: "researching" });
        previews.delete(previewId);
        const run = { bound, controller: new AbortController() };
        running.set(bound.account, run);
        run.done = execute(job, run);
        void run.done.catch(() => {
          // Storage failed after startup. Surface an interruption in this
          // process, and repair the durable record on the next successful load.
          jobs = { ...jobs, [job.id]: { ...jobs[job.id], state: "interrupted", failure: "本机任务记录暂时无法保存。" } };
        });
        return publicJob(job);
      });
      const job = await serial(async () => {
        await load();
        bound.check();
        if (action === "list") return Object.values(jobs).filter(item => item.owner === bound.owner && item.box === bound.box)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ id, task, state, createdAt }) => ({ id, task: task.slice(0, 160), state, createdAt }));
        return readJob(input.id, bound);
      });
      if (action === "list") return { jobs: job };
      if (action === "cancel") {
        const run = running.get(bound.account);
        if (activeStates.has(job.state) && run && run.bound.scope === bound.scope) {
          stop(run, "cancelled");
          await run.done.catch(() => {});
        }
        bound.check();
        return publicJob(readJob(input.id, bound));
      }
      if (action === "status") return publicJob(job);
      if (action === "export") {
        if (job.state !== "completed") throw error("方案通过核证后才能导出。");
        const revalidate = () => verify(job.selection, job.evidence, bound.check);
        await revalidate();
        return { saved: await saveReport(markdown(job), revalidate) };
      }
      throw error("协作操作无效。");
    },
  };
}
