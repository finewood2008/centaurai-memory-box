import { setTimeout as delay } from "node:timers/promises";
import { createMyAiCollaboration } from "../shell/my-ai-collaboration.mjs";
import { createCollaborationModels } from "../shell/my-ai-collaboration-models.mjs";

const cases = [
  {
    name: "首发试点",
    task: "根据三条证据拟首发试点方案，写明首批人数、权限验收范围和负责人状态。",
    snippets: ["发布清单要求验收个人空间、星图和历史记忆的权限。", "负责人批准首批邀请 12 人。", "试点负责人仍待确定。"],
    facts: [/个人空间.*星图.*记忆|三类.*权限/u, /12\s*人|十二\s*人/u, /负责人.*(?:待定|待确认|待确定|未定)/u],
  },
  {
    name: "培训安排",
    task: "汇总培训计划和待定事项，写出培训时长、人数和演练方式。如果材料有分歧，说明哪些已拍板。",
    snippets: ["最终确认培训每次 45 分钟。之前草案写 60 分钟。", "首轮培训 8 人。", "本轮用虚构资料演练导出 Markdown。"],
    facts: [/45\s*分钟|四十五\s*分钟/u, /8\s*人|八\s*人/u, /虚构.*演练|虚构.*Markdown/u],
  },
  {
    name: "资料验收",
    task: "根据证据列出资料验收标准和暂停条件，写清门槛。",
    snippets: ["抽检 20 条引用，其中任何一条无法定位原文立即暂停。", "资料权限变化后须重新确认发送。", "通过证据核对后才开放 Markdown 导出。"],
    facts: [/20\s*条|二十\s*条/u, /(?:权限|资料).*重新确认/u, /核对.*(?:导出|Markdown)|Markdown.*核对/u],
  },
];

function score(report, facts) {
  const claims = [report?.recommendation, ...(report?.findings ?? []), ...(report?.disagreements ?? [])].filter(Boolean);
  const covered = facts.filter(pattern => claims.some(claim => pattern.test(claim.text))).length;
  const declared = claims.flatMap(claim => (claim.evidenceIds ?? []).map(id => ({ id, text: claim.text })));
  const expected = declared.filter(({ id, text }) => {
    const index = /^E[1-3]$/.test(id) ? Number(id.slice(1)) - 1 : -1;
    return facts[index]?.test(text);
  }).length;
  return { factsCovered: covered, expectedFacts: facts.length, rubricSupportedCitations: expected, citedPairs: declared.length };
}

function usage(calls) {
  function total(name) {
    return calls.length && calls.every(call => Number.isSafeInteger(call[name]))
      ? calls.reduce((sum, call) => sum + call[name], 0) : null;
  }
  return { calls: calls.length, inputTokens: total("inputTokens"), outputTokens: total("outputTokens") };
}

async function evaluate(models, sample) {
  const evidence = sample.snippets.map((text, index) => ({
    id: "E" + (index + 1), kind: "space", title: "虚构资料 " + (index + 1), text, locator: {},
  }));
  const input = { task: sample.task, evidence: evidence.map(({ id, text }) => ({ id, text })) };
  let start = performance.now();
  const baseline = await models.call("claude", "baseline", input, AbortSignal.timeout(300_000));
  const baselineMs = Math.round(performance.now() - start);
  let records;
  const collaboration = createMyAiCollaboration({
    models,
    identity: () => ({ owner: "evaluation", box: "fixture", scope: "fixture" }),
    sources: { async collect() { return { evidence, notices: [] }; }, async verify() { return true; } },
    store: { async load() { return records; }, async save(value) { records = value; } },
  });
  start = performance.now();
  try {
    const preview = await collaboration.action("preview", { task: sample.task, selection: {} });
    let job = await collaboration.action("start", { previewId: preview.previewId, evidenceIds: evidence.map(item => item.id) });
    while (["researching", "synthesizing", "reviewing", "revising"].includes(job.state)) {
      await delay(250);
      job = await collaboration.action("status", { id: job.id });
    }
    return {
      sample: sample.name,
      baseline: { elapsedMs: baselineMs, ...usage([baseline.usage]), ...score(baseline.output, sample.facts), report: baseline.output },
      collaboration: { elapsedMs: Math.round(performance.now() - start), ...usage(job.usage),
        state: job.state, ...score(job.report, sample.facts), report: job.report, issues: job.issues, failure: job.failure },
    };
  } finally {
    await collaboration.close();
  }
}

async function main() {
  const models = createCollaborationModels();
  const missing = models.recipients.filter(row => !row.configured).map(row => row.name);
  if (missing.length) throw Error("尚未配置试点 API：" + missing.join("、"));
  const results = [];
  for (const sample of cases) {
    try { results.push(await evaluate(models, sample)); }
    catch (cause) { results.push({ sample: sample.name, failure: cause.message }); }
  }
  console.log(JSON.stringify({ recipients: models.recipients, results }, null, 2));
  if (results.some(item => item.failure || item.collaboration.state !== "completed")) process.exitCode = 1;
}

if (process.argv.length === 3 && process.argv[2] === "--live") {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  console.log("使用 --live 对三组虚构资料执行模型对比，输出每题的报告、评分和模型用量。");
}
