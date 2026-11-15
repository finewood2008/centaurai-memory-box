import { useEffect, useRef, useState } from "react";
import {
  RocketLaunch,
  FileText,
  ChatCircleDots,
  CaretDown,
  CaretRight,
  CheckCircle,
  WarningCircle,
  Info,
  X,
  Desktop,
  HardDrives,
  ArrowCounterClockwise,
  ArrowSquareOut,
  CircleNotch,
  SlidersHorizontal,
  Clock,
  Check,
  Flask,
  ShieldCheck,
} from "@phosphor-icons/react";
const versions = [
  "v1.4.0",
  "v1.3.2",
  "v1.3.1",
  "v1.3.0",
  "v1.2.2",
  "v1.2.1",
  "v1.2.0",
];
// Delivery is part of the immutable bundle, not a per-environment choice.
const deliveryOf = (version) => (version === "v1.3.1" ? "load" : "install");
const boxes = ["演示盒子 01", "演示盒子 02"];
const scenarios = {
  normal: "正常部署",
  offline: "客户端离线",
  blocked: "预检阻塞",
  degraded: "部分激活失败",
  receipt: "回执待同步",
  approval: "缺少正式放行",
};
const stepNames = [
  "部署前检查",
  "准备后端服务",
  "准备配套客户端",
  "验证候选版本",
  "切换与入口验证",
];
const keyOf = (box, env) => `${box}/${env}`;
const envName = (env) => (env === "dev" ? "联调" : "正式");
const statusText = {
  running: "部署进行中",
  waiting: "等待客户端连接",
  success: "部署成功",
  degraded: "已提交 · 部分不可用",
  recovered: "恢复成功",
};
const seedHistory = () => [
  ...boxes.flatMap((box, b) =>
    ["dev", "prod"]
      .filter((env) => !(b === 0 && env === "prod"))
      .map((env) => ({
        id: `baseline-${b}-${env}`,
        version: "v1.3.2",
        box,
        env,
        status: "success",
        step: 5,
        receipt: "synced",
        kind: "deploy",
        label: "示例历史",
        previous: "v1.3.1",
        delivery: "install",
      })),
  ),
  ...versions.slice(1).map((version, i) => ({
    id: `history-${i}`,
    version,
    box: boxes[0],
    env: "prod",
    status: "success",
    step: 5,
    receipt: "synced",
    kind: "deploy",
    archived: i === 5,
    label: "示例历史",
    previous: "v1.2.0",
    delivery: deliveryOf(version),
  })),
];
const initialEnvs = () =>
  Object.fromEntries(
    boxes.flatMap((box) =>
      ["dev", "prod"].map((env) => [
        keyOf(box, env),
        { version: "v1.3.2", health: "healthy" },
      ]),
    ),
  );
const seedValidation = () =>
  Object.fromEntries(
    seedHistory()
      .filter((h) => h.env === "dev")
      .map((h) => [`${h.box}/${h.version}`, true]),
  );
function Modal({ title, children, close, drawer = false }) {
  const ref = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const before = document.activeElement,
      el = ref.current,
      old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el.querySelector("button,select,input")?.focus();
    const handler = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab") return;
      const items = [
          ...el.querySelectorAll(
            'button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],summary,[tabindex="0"]',
          ),
        ],
        first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const backgrounds = [...document.querySelectorAll(".sidebar, .main")];
    backgrounds.forEach((node) => (node.inert = true));
    const keepFocus = () => {
      if (!el.contains(document.activeElement))
        el.querySelector("button")?.focus();
    };
    const observer = new MutationObserver(keepFocus);
    observer.observe(el, { childList: true, subtree: true });
    document.addEventListener("focusin", keepFocus);
    el.addEventListener("keydown", handler);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", keepFocus);
      backgrounds.forEach((node) => (node.inert = false));
      el.removeEventListener("keydown", handler);
      document.body.style.overflow = old;
      before?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        ref={ref}
        className={drawer ? "dialog drawer" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={23} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Status({ good = true, children }) {
  return (
    <span className={`status ${good ? "good" : "warn"}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function App() {
  const [page, setPage] = useState("deploy"),
    [env, setEnv] = useState("dev"),
    [version, setVersion] = useState("v1.4.0"),
    [box, setBox] = useState(boxes[0]),
    [scenario, setScenario] = useState("normal");
  const [envs, setEnvs] = useState(initialEnvs),
    [validated, setValidated] = useState(seedValidation),
    [history, setHistory] = useState(seedHistory),
    [active, setActive] = useState(null),
    [selectedId, setSelectedId] = useState(null),
    [modal, setModal] = useState(null),
    [confirm, setConfirm] = useState(null),
    [toast, setToast] = useState(""),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [previewSent, setPreviewSent] = useState(false);
  const counter = useRef(0),
    submitLock = useRef(false);
  const delivery = deliveryOf(version);
  const current = envs[keyOf(box, env)],
    busy = active && ["running", "waiting", "degraded"].includes(active.status),
    devVerified = !!validated[`${box}/${version}`],
    blocked =
      scenario === "blocked" ||
      (env === "prod" && (!devVerified || scenario === "approval")) ||
      current.health === "degraded",
    detail =
      active?.id === selectedId
        ? active
        : history.find((h) => h.id === selectedId);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!active || active.status !== "running") return;
    const timer = setTimeout(() => {
      if (
        active.step === 2 &&
        active.scenario === "offline" &&
        !active.reconnected
      ) {
        setActive((a) => ({ ...a, status: "waiting" }));
        return;
      }
      if (active.step < 4) {
        setActive((a) => ({ ...a, step: a.step + 1 }));
        return;
      }
      const failed = active.scenario === "degraded",
        finished = {
          ...active,
          step: 5,
          status: failed ? "degraded" : "success",
          receipt: active.scenario === "receipt" ? "pending" : "synced",
        };
      setActive(finished);
      setHistory((h) => [finished, ...h]);
      setEnvs((s) => ({
        ...s,
        [keyOf(active.box, active.env)]: {
          version: active.version,
          health: failed ? "degraded" : "healthy",
        },
      }));
      if (!failed && active.env === "dev")
        setValidated((v) => ({
          ...v,
          [`${active.box}/${active.version}`]: true,
        }));
      submitLock.current = false;
    }, 900);
    return () => clearTimeout(timer);
  }, [active]);
  function begin({
    kind = "deploy",
    targetVersion = version,
    targetEnv = env,
    targetBox = box,
  } = {}) {
    if (busy || submitLock.current) {
      if (active) {
        setSelectedId(active.id);
        setModal("progress");
      }
      return;
    }
    if (
      scenario === "blocked" ||
      (targetEnv === "prod" &&
        (scenario === "approval" ||
          (kind === "deploy" && !validated[`${targetBox}/${targetVersion}`])))
    ) {
      setToast("预检未通过，请先处理阻塞条件。");
      return;
    }
    submitLock.current = true;
    const op = {
      id: `demo-${++counter.current}`,
      version: targetVersion,
      box: targetBox,
      env: targetEnv,
      previous: envs[keyOf(targetBox, targetEnv)].version,
      status: "running",
      step: 0,
      receipt: "pending",
      kind,
      scenario,
      delivery: deliveryOf(targetVersion),
      label: "本次演示",
    };
    setActive(op);
    setSelectedId(op.id);
    setConfirm(null);
    setModal("progress");
  }
  function recover() {
    const restored = {
      ...active,
      id: `demo-${++counter.current}`,
      version: active.version,
      kind: "recover",
      status: "recovered",
      receipt: "synced",
      recoveryOf: active.id,
    };
    setHistory((h) => [restored, ...h]);
    setActive(restored);
    setSelectedId(restored.id);
    setEnvs((s) => ({
      ...s,
      [keyOf(active.box, active.env)]: {
        version: active.version,
        health: "healthy",
      },
    }));
    if (active.env === "dev")
      setValidated((v) => ({
        ...v,
        [`${active.box}/${active.version}`]: true,
      }));
    setToast("已补齐当前版本入口，业务数据已保留。");
  }
  function reset() {
    setActive(null);
    setEnvs(initialEnvs());
    setHistory(seedHistory());
    setValidated(seedValidation());
    setScenario("normal");
    setEnv("dev");
    setBox(boxes[0]);
    setVersion("v1.4.0");
    setModal(null);
    setPage("deploy");
    setConfirm(null);
    setFilter("all");
    setSearch("");
    submitLock.current = false;
    setToast("演示已重置");
  }
  function syncReceipt() {
    if (active?.id === detail.id)
      setActive((a) => ({ ...a, receipt: "synced" }));
    setHistory((h) =>
      h.map((x) => (x.id === detail.id ? { ...x, receipt: "synced" } : x)),
    );
    setToast("回执已同步，未重新执行部署。");
  }
  function showDetail(item) {
    setSelectedId(item.id);
    setModal("progress");
  }
  const checkRows = [
    ["版本完整", `后端服务与客户端版本均为 ${version}。`, true],
    [
      "盒子连接",
      scenario === "blocked"
        ? "可用空间不足，需要 2 GB，当前剩余 0.8 GB。"
        : "目标盒子当前在线，可执行部署。",
      scenario !== "blocked",
    ],
    [
      "客户端就绪",
      scenario === "offline"
        ? "验收客户端离线，部署将等待连接后再验证。"
        : `配套客户端已连接，可随服务一并${delivery === "install" ? "部署" : "加载"}。`,
      scenario !== "offline",
    ],
    ...(env === "prod"
      ? [
          [
            "发布条件",
            !devVerified
              ? "请先完成此版本在当前盒子的联调部署。"
              : scenario === "approval"
                ? "上游放行结果缺失，请由负责同事补齐。"
                : "同版本联调、回归与上游放行均已通过（模拟）。",
            devVerified && scenario !== "approval",
          ],
        ]
      : []),
  ];
  const historyRows = history.filter(
    (h) =>
      (filter === "all" || h.env === filter) &&
      `${h.version}${h.box}`.includes(search),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/assets/wanx-mark.png" alt="" />
          <span>万象工坊</span>
        </div>
        <div className="app-identity">
          <ChatCircleDots size={27} weight="fill" />
          <strong>销售知识助手</strong>
        </div>
        <nav aria-label="应用导航">
          <button
            className={page === "deploy" ? "nav active" : "nav"}
            onClick={() => setPage("deploy")}
          >
            <RocketLaunch size={25} />
            部署
          </button>
          <button
            className={page === "history" ? "nav active" : "nav"}
            onClick={() => setPage("history")}
          >
            <FileText size={25} />
            版本记录
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav scenario-button"
            onClick={() => setModal("scenarios")}
          >
            <SlidersHorizontal size={21} />
            演示场景
            <span className={scenario === "normal" ? "" : "scenario-dot"} />
          </button>
          <p>交互原型 · 刷新后重置</p>
        </div>
      </aside>
      <main className="main">
        <div className="breadcrumb">
          <span>应用</span>
          <span>/</span>
          <span>销售知识助手</span>
          <span>/</span>
          <strong>{page === "deploy" ? "部署" : "版本记录"}</strong>
        </div>
        <header className="page-header">
          <div className="title-line">
            <h1>{page === "deploy" ? "部署到盒子" : "版本记录"}</h1>
            <span className="prototype-badge">原型演示 · 模拟数据</span>
          </div>
          <p>
            {page === "deploy"
              ? "后端服务与配套客户端一起部署。"
              : "查看每次部署结果，回滚时保留现有业务数据。"}
          </p>
        </header>
        {page === "deploy" ? (
          <>
            <div className="tabs" role="tablist" aria-label="部署环境">
              {["dev", "prod"].map((e) => (
                <button
                  key={e}
                  role="tab"
                  aria-selected={env === e}
                  className={env === e ? "selected" : ""}
                  onClick={() => setEnv(e)}
                >
                  {envName(e)}环境
                </button>
              ))}
            </div>
            {busy && (
              <div
                className={`notice ${active.status === "degraded" ? "warning" : ""}`}
              >
                <Info size={21} />
                <span>
                  {active.box} · {envName(active.env)}环境 ·{" "}
                  {statusText[active.status]}。
                  {active.status === "degraded"
                    ? "恢复完成前不能发起新部署。"
                    : "关闭详情不影响当前演示进度。"}
                </span>
                <button
                  className="text-button"
                  onClick={() => showDetail(active)}
                >
                  查看进度
                </button>
              </div>
            )}
            {scenario !== "normal" && (
              <div className="scenario-banner">
                <Flask size={18} />
                当前演示：{scenarios[scenario]}
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => setModal("scenarios")}
                >
                  切换场景
                </button>
              </div>
            )}
            <div className="deployment-grid">
              <section className="deployment-form" aria-label="部署配置">
                <div className="fields">
                  <label className="field">
                    <span>发布版本</span>
                    <div className="select-wrap">
                      <select
                        aria-label="发布版本"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        disabled={!!busy}
                      >
                        {versions.map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                      <CaretDown size={21} />
                    </div>
                  </label>
                  <label className="field">
                    <span>目标盒子</span>
                    <div className="select-wrap">
                      <select
                        aria-label="目标盒子"
                        value={box}
                        onChange={(e) => setBox(e.target.value)}
                        disabled={!!busy}
                      >
                        {boxes.map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
                      <span className="select-status">
                        <Status>在线</Status>
                      </span>
                      <CaretDown size={21} />
                    </div>
                  </label>
                  <label className="field">
                    <span>配套客户端</span>
                    <div className="select-wrap client-select">
                      <select
                        aria-label="配套客户端"
                        value={delivery}
                        title="交付方式由发布版本固定；v1.3.1 演示共享运行时加载"
                        disabled={!!busy}
                      >
                        <option value={delivery}>
                          {delivery === "install"
                            ? "万象客户端"
                            : "共享运行时加载"}
                        </option>
                      </select>
                      <span className="select-status">
                        <Status good={scenario !== "offline"}>
                          {scenario === "offline" ? "离线" : "已连接"}
                        </Status>
                      </span>
                      <CaretDown size={21} />
                    </div>
                  </label>
                </div>
                <section className="preflight">
                  <h2>部署前检查</h2>
                  {checkRows.map(([title, description, good]) => (
                    <div className="check-row" key={title}>
                      {good ? (
                        <CheckCircle className="good" weight="fill" size={26} />
                      ) : (
                        <WarningCircle
                          className="warn"
                          weight="fill"
                          size={26}
                        />
                      )}
                      <strong>{title}</strong>
                      <span>{description}</span>
                    </div>
                  ))}
                </section>
              </section>
              <aside className="summary">
                <h2>本次部署</h2>
                <dl>
                  <div>
                    <dt>后端服务</dt>
                    <dd>{version}</dd>
                  </div>
                  <div>
                    <dt>配套客户端</dt>
                    <dd>{version}</dd>
                  </div>
                  <div>
                    <dt>部署环境</dt>
                    <dd>{envName(env)}</dd>
                  </div>
                </dl>
                <p className="summary-note">
                  <Info size={19} />
                  {env === "dev"
                    ? "与正式环境隔离。"
                    : "使用联调验证过的同一发布包。"}
                </p>
                <button
                  className="primary"
                  disabled={blocked || !!busy}
                  onClick={() =>
                    env === "prod"
                      ? setConfirm({
                          kind: "deploy",
                          targetVersion: version,
                          targetEnv: env,
                          targetBox: box,
                        })
                      : begin()
                  }
                >
                  {busy
                    ? "当前操作待完成"
                    : env === "dev"
                      ? "开始联调部署"
                      : "发布到正式环境"}
                </button>
                {blocked && (
                  <p className="blocked-reason">
                    {scenario === "blocked"
                      ? "请先处理盒子空间不足。"
                      : current.health === "degraded"
                        ? "请先恢复当前环境。"
                        : scenario === "approval"
                          ? "请先补齐上游正式放行结果。"
                          : "完成联调部署后才能发布。"}
                  </p>
                )}
              </aside>
            </div>
            <section className="recent">
              <div className="section-heading">
                <h2>最近部署</h2>
                {current.health === "degraded" && (
                  <Status good={false}>当前环境部分不可用</Status>
                )}
              </div>
              <div className="recent-row">
                {current.health === "degraded" ? (
                  <WarningCircle className="warn" weight="fill" size={26} />
                ) : (
                  <CheckCircle className="good" weight="fill" size={26} />
                )}
                <strong>{current.version}</strong>
                <span>
                  {current.health === "degraded" ? "部分不可用" : "部署成功"}
                </span>
                <span>{box}</span>
                <span>{envName(env)}环境</span>
                <button
                  className="text-button"
                  onClick={() => {
                    setPage("history");
                    setFilter(env);
                  }}
                >
                  查看记录
                  <CaretRight size={20} />
                </button>
              </div>
            </section>
          </>
        ) : (
          <section className="history-section">
            <div className="history-toolbar">
              <div className="segmented">
                {[
                  ["all", "全部环境"],
                  ["dev", "联调"],
                  ["prod", "正式"],
                ].map(([value, label]) => (
                  <button
                    className={filter === value ? "selected" : ""}
                    onClick={() => setFilter(value)}
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                aria-label="搜索版本或盒子"
                placeholder="搜索版本或盒子"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>发布版本</th>
                    <th>目标</th>
                    <th>部署结果</th>
                    <th>回执</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <strong>{h.version}</strong>
                        <small>
                          {h.kind === "rollback"
                            ? "版本回滚"
                            : h.kind === "recover"
                              ? "关联恢复操作"
                              : h.archived
                                ? "归档版本 · 可取回"
                                : h.label}
                        </small>
                      </td>
                      <td>
                        {h.box}
                        <small>{envName(h.env)}环境</small>
                      </td>
                      <td>
                        <span
                          className={
                            ["success", "recovered"].includes(h.status)
                              ? "good"
                              : "warn"
                          }
                        >
                          {statusText[h.status]}
                        </span>
                      </td>
                      <td>{h.receipt === "synced" ? "已同步" : "待同步"}</td>
                      <td>
                        <div className="table-actions">
                          <button
                            className="text-button"
                            onClick={() => showDetail(h)}
                          >
                            详情
                          </button>
                          {h.status === "success" && (
                            <button
                              className="text-button"
                              disabled={
                                !!busy ||
                                envs[keyOf(h.box, h.env)].version === h.version
                              }
                              onClick={() =>
                                setConfirm({
                                  kind: "rollback",
                                  targetVersion: h.version,
                                  targetEnv: h.env,
                                  targetBox: h.box,
                                  archived: h.archived,
                                })
                              }
                            >
                              回滚
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!historyRows.length && (
              <div className="empty">
                <FileText size={35} />
                <h3>没有匹配的部署记录</h3>
                <p>试试其他版本号，或切换环境筛选。</p>
                <button
                  className="text-button"
                  onClick={() => {
                    setFilter("all");
                    setSearch("");
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
            <p className="footnote">
              <Info size={18} />
              历史操作结果不随环境健康变化改写。归档版本也可回滚，业务数据保持不变。
            </p>
          </section>
        )}
        <footer className="page-footer">
          <ShieldCheck size={16} />
          所有操作仅演示，不会连接或修改真实盒子
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={22} />
          {toast}
        </div>
      )}
      {confirm && (
        <Modal
          title={
            confirm.kind === "rollback" ? "确认回滚版本" : "发布到正式环境"
          }
          close={() => setConfirm(null)}
        >
          <div className="dialog-body">
            <div className="confirm-symbol">
              {confirm.kind === "rollback" ? (
                <ArrowCounterClockwise size={30} />
              ) : (
                <RocketLaunch size={30} />
              )}
            </div>
            <h3>
              {confirm.kind === "rollback"
                ? `回滚到 ${confirm.targetVersion}`
                : `将 ${confirm.targetVersion} 发布到正式环境`}
            </h3>
            <p className="muted">
              {confirm.targetBox} · {envName(confirm.targetEnv)}环境
            </p>
            <dl className="detail-list">
              <div>
                <dt>当前版本</dt>
                <dd>
                  {envs[keyOf(confirm.targetBox, confirm.targetEnv)].version}
                </dd>
              </div>
              <div>
                <dt>目标版本</dt>
                <dd>{confirm.targetVersion}</dd>
              </div>
              <div>
                <dt>业务数据</dt>
                <dd>保留，不恢复旧数据库</dd>
              </div>
              <div>
                <dt>
                  {confirm.kind === "rollback"
                    ? "依赖兼容检查"
                    : "上游回归与放行"}
                </dt>
                <dd className={scenario === "approval" ? "warn" : "good"}>
                  {scenario === "approval" ? "缺少正式放行" : "已通过（模拟）"}
                </dd>
              </div>
            </dl>
            {confirm.archived && (
              <div className="notice">
                <Info size={20} />
                将先取回归档版本及固定依赖。
              </div>
            )}
            <p className="muted">
              {confirm.kind === "rollback"
                ? "切换应用版本，已有业务数据与在途任务引用继续保留。"
                : "使用已验证的同一发布包，正式环境使用独立配置和数据。"}
            </p>
          </div>
          <footer className="dialog-actions">
            <button className="secondary" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={
                scenario === "blocked" ||
                (confirm.targetEnv === "prod" && scenario === "approval")
              }
              onClick={() => begin(confirm)}
            >
              {confirm.kind === "rollback" ? "确认回滚" : "确认发布"}
            </button>
          </footer>
        </Modal>
      )}
      {modal === "scenarios" && (
        <Modal title="演示场景" close={() => setModal(null)}>
          <div className="dialog-body">
            <p className="muted">
              选择下一次部署的模拟结果。不会触发真实操作。
            </p>
            <div className="scenario-list">
              {Object.entries(scenarios).map(([value, label]) => (
                <button
                  key={value}
                  disabled={!!busy}
                  className={
                    scenario === value
                      ? "scenario-option selected"
                      : "scenario-option"
                  }
                  onClick={() => {
                    setScenario(value);
                    setModal(null);
                  }}
                >
                  <span>
                    <strong>{label}</strong>
                    <small>
                      {
                        {
                          normal: "双端部署完成并通过验证",
                          offline: "停在客户端准备阶段，手动模拟重连",
                          blocked: "空间预检失败，部署按钮不可用",
                          degraded: "后端已切换，但客户端入口验证失败",
                          receipt: "部署成功，回执暂未同步；可单独重试",
                          approval: "联调仍可部署，正式发布缺少上游放行",
                        }[value]
                      }
                    </small>
                  </span>
                  {scenario === value && <Check size={21} />}
                </button>
              ))}
            </div>
            {busy && (
              <p className="warn">请先完成或恢复当前操作，或重置整个演示。</p>
            )}
          </div>
          <footer className="dialog-actions">
            <span className="muted">刷新也会清空演示状态</span>
            <button className="secondary" onClick={reset}>
              <ArrowCounterClockwise size={18} />
              重置演示
            </button>
          </footer>
        </Modal>
      )}
      {modal === "progress" && detail && (
        <Modal
          drawer
          title={
            detail.kind === "rollback"
              ? "回滚详情"
              : detail.kind === "recover"
                ? "恢复详情"
                : "部署详情"
          }
          close={() => setModal(null)}
        >
          <div className="dialog-body">
            <div className="operation-meta">
              {detail.box} · {envName(detail.env)}环境
              <span>{detail.version}</span>
            </div>
            <div
              className={`result-header ${["success", "recovered"].includes(detail.status) ? "good" : ["waiting", "degraded"].includes(detail.status) ? "warn" : ""}`}
            >
              {detail.status === "running" ? (
                <CircleNotch className="spin" size={34} />
              ) : ["success", "recovered"].includes(detail.status) ? (
                <CheckCircle weight="fill" size={34} />
              ) : (
                <WarningCircle size={34} />
              )}
              <h3>{statusText[detail.status]}</h3>
            </div>
            <p className="muted result-description">
              {
                {
                  running: "正在准备并验证后端与配套客户端。",
                  waiting:
                    "后端候选已就绪。必需客户端连接后，才会继续验证并切换。",
                  success:
                    detail.kind === "rollback"
                      ? "历史版本已激活，现有业务数据保持不变。"
                      : "本次操作的后端与配套客户端验证均通过。应用入口以当前环境状态为准。",
                  degraded:
                    "新版本已提交，但客户端入口未就绪。此次操作记录保留部分失败结果。",
                  recovered: `已补齐 ${detail.version} 的客户端入口，业务数据保持不变。原部署的部分失败结果已保留。`,
                }[detail.status]
              }
            </p>
            <div className="environment-state">
              <Info size={18} />
              <span>
                当前环境：{envs[keyOf(detail.box, detail.env)].version} ·{" "}
                {envs[keyOf(detail.box, detail.env)].health === "healthy"
                  ? "运行正常"
                  : "部分不可用"}
                。以下为本次操作结果。
              </span>
            </div>
            <div className="component-results">
              <div>
                <HardDrives size={23} />
                <span>后端服务</span>
                <strong>{detail.step > 1 ? detail.version : "准备中"}</strong>
              </div>
              <div>
                <Desktop size={23} />
                <span>
                  {detail.delivery === "load" ? "客户端加载" : "客户端安装"}
                </span>
                <strong
                  className={
                    ["degraded", "waiting"].includes(detail.status)
                      ? "warn"
                      : ""
                  }
                >
                  {detail.status === "waiting"
                    ? "等待连接"
                    : detail.status === "degraded"
                      ? "入口验证失败"
                      : detail.step > 2
                        ? detail.version
                        : "待准备"}
                </strong>
              </div>
            </div>
            {detail.kind !== "recover" && (
              <ol className="steps">
                {stepNames.map((name, i) => (
                  <li
                    key={name}
                    className={
                      detail.status === "degraded" && i === 4
                        ? "failed"
                        : detail.step > i
                          ? "done"
                          : detail.step === i
                            ? "current"
                            : ""
                    }
                  >
                    {detail.status === "degraded" && i === 4 ? (
                      <WarningCircle size={23} />
                    ) : detail.step > i ? (
                      <CheckCircle size={23} weight="fill" />
                    ) : detail.step === i ? (
                      <CircleNotch
                        size={23}
                        className={detail.status === "running" ? "spin" : ""}
                      />
                    ) : (
                      <Clock size={23} />
                    )}
                    <div>
                      <strong>
                        {detail.kind === "rollback" && i === 1
                          ? "取回历史版本与固定依赖"
                          : name}
                      </strong>
                      {detail.step === i && (
                        <small>
                          {detail.status === "waiting"
                            ? "等待客户端重连"
                            : "正在执行…"}
                        </small>
                      )}
                      {detail.status === "degraded" && i === 4 && (
                        <small className="warn">
                          部分入口验证失败，未达到完整可用
                        </small>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <details className="logs">
              <summary>
                执行日志
                <FileText size={17} />
              </summary>
              <pre>{`[模拟] 目标已固定：${detail.box} / ${envName(detail.env)}\n[模拟] 版本：${detail.version}；${detail.kind === "rollback" ? "回滚保留业务数据" : "校验不可变发布包"}\n${stepNames
                .slice(0, Math.min(detail.step, 4))
                .map((s) => `[完成] ${s}`)
                .join(
                  "\n",
                )}\n${detail.status === "waiting" ? "[等待] 必需客户端离线，尚未切换版本" : detail.status === "degraded" ? "[失败] 版本已提交；客户端入口验证失败" : detail.status === "recovered" ? `[恢复] 关联 ${detail.recoveryOf}，已补齐当前版本入口；业务数据保留` : detail.status === "success" ? "[完成] 必需组件可用性验证通过" : "[进行中] " + stepNames[detail.step]}`}</pre>
            </details>
            <div className="receipt-row">
              <Info size={19} />
              <span>
                回执
                {detail.receipt === "synced"
                  ? "已同步"
                  : ["running", "waiting"].includes(detail.status)
                    ? "将在操作结束后生成"
                    : "待同步"}
              </span>
              {detail.receipt === "pending" && detail.status === "success" && (
                <button className="text-button" onClick={syncReceipt}>
                  重试同步
                </button>
              )}
            </div>
          </div>
          <footer className="drawer-actions">
            {detail.status === "waiting" && (
              <button
                className="primary"
                onClick={() =>
                  setActive((a) => ({
                    ...a,
                    status: "running",
                    reconnected: true,
                  }))
                }
              >
                模拟客户端重新连接
              </button>
            )}
            {detail.status === "degraded" && active?.id === detail.id && (
              <button className="primary" onClick={recover}>
                <ArrowCounterClockwise size={19} />
                恢复当前版本入口
              </button>
            )}
            {["success", "recovered"].includes(detail.status) && (
              <>
                <button
                  className="secondary"
                  disabled={
                    envs[keyOf(detail.box, detail.env)].version !==
                      detail.version ||
                    envs[keyOf(detail.box, detail.env)].health !== "healthy"
                  }
                  onClick={() => {
                    setPreviewSent(false);
                    setModal("preview");
                  }}
                >
                  <ArrowSquareOut size={18} />
                  打开模拟应用
                </button>
                {detail.env === "dev" && (
                  <button
                    className="primary"
                    onClick={() => {
                      setBox(detail.box);
                      setVersion(detail.version);
                      setEnv("prod");
                      setPage("deploy");
                      setModal(null);
                    }}
                  >
                    去正式发布
                    <CaretRight size={18} />
                  </button>
                )}
              </>
            )}
            {detail.status === "recovered" && (
              <button className="primary" onClick={() => setModal(null)}>
                返回部署工作台
              </button>
            )}
          </footer>
        </Modal>
      )}
      {modal === "preview" && (
        <Modal title="销售知识助手 · 模拟客户端" close={() => setModal(null)}>
          <div className="dialog-body">
            <div className="notice">
              <Info size={20} />
              仅验证原型跳转，不连接真实应用或 AI 服务。
            </div>
            <div className="chat-message">
              <ChatCircleDots size={26} />
              <p>
                你好，我是销售知识助手。可以帮你查询产品资料、准备客户沟通要点。
              </p>
            </div>
            {previewSent ? (
              <div className="chat-answer">
                <strong>产品介绍提纲</strong>
                <p>
                  1. 客户需求与使用场景
                  <br />
                  2. 产品能力与适用范围
                  <br />
                  3. 演示安排与下一步沟通
                </p>
                <small>以上为固定演示内容</small>
              </div>
            ) : (
              <button
                className="suggestion"
                onClick={() => setPreviewSent(true)}
              >
                帮我准备一份产品介绍提纲
                <CaretRight size={18} />
              </button>
            )}
          </div>
          <footer className="dialog-actions">
            <button className="secondary" onClick={() => setModal("progress")}>
              返回部署详情
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
