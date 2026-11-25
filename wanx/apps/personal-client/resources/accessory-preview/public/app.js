// 录音智能体 · 独立试用 —— 浏览器端。所有文本经 textContent 写入，不使用 innerHTML。
const MAX_PENDING_PCM = 24 * 1024 * 1024;
const LS_PREF = 'memoBoxRecording.preferredInput';
const PROJECT_ID = /^m-\d{8}-\d{6}-[0-9a-f]{6}$/;
const ACCESSORIES_PATH = '/accessories';
const accessoryRoute = location.pathname.replace(/\/$/, '').split('/');
const inAccessories = accessoryRoute[1] === 'accessories';
const accessoryPage = inAccessories ? accessoryRoute[2] || 'catalog' : null;
const accessoryAgents = {
  disk: { title: '会议录音智能体', description: '桌面会议拾音，边录边看实时字幕。', action: '开始录音', empty: '开始第一次圆盘录音后，项目会显示在这里。' },
  clip: { title: '随身录音智能体', description: '适合随身长时间录音，导入后在盒端异步转写。', action: '导入录音', empty: '导入第一份领夹录音后，项目会显示在这里。' },
};
const accessoryAgent = Object.hasOwn(accessoryAgents, accessoryPage) ? accessoryAgents[accessoryPage] : null;
let accessoryBoxReady = true;

const S = {
  view: 'meeting',
  health: null,
  settings: null,
  templateCatalog: null,
  templateViewId: null,
  templateEdit: null,
  meetings: [],
  projectQuery: '',
  projectFilter: '',
  transcriptQuery: '',
  nextTemplateId: '',
  currentId: null,
  meeting: null,
  devices: [],
  usb: null,
  micTest: null,
  permission: 'unknown',
  checkingMic: false,
  micError: '',
  selectedDeviceId: '',
  rec: null,
  edit: null,
  lastSig: '',
  player: null,
  lib: { spaceId: null, spaceFile: null, vaultId: null, materialId: null },
};

// —— 小工具 ——
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}


const templateById = (id) => S.templateCatalog?.templates.find((t) => t.id === id);

function fmt(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.json !== undefined || opts.body ? 'POST' : 'GET'), headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  else if (opts.body !== undefined) init.body = opts.body;
  let r;
  try { r = await fetch(path, init); } catch (e) { const err = new Error('无法连接本机服务'); err.network = true; throw err; }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) {
    const err = new Error((data && data.error) || `请求失败（${r.status}）`);
    err.status = r.status; err.body = data; throw err;
  }
  return data;
}
const ts = (ms, onClick) => (ms === null || ms === undefined)
  ? h('span', { class: 'ts none', title: '无关联原话' }, '--:--')
  : h('button', { class: 'ts', type: 'button', title: '回听此处', onclick: onClick || (() => seek(ms)) }, fmt(ms));

// —— 状态文本 ——
function listStatus(s) {
  if (S.rec && S.rec.meetingId === s.id) return S.rec.state === 'paused' ? '已暂停' : '录音中';
  if (s.state === 'recording') return `录音未结束 · 已存 ${s.chunks} 片`;
  if (['pending', 'composing'].includes(s.audio)) return '保存原音中';
  if (s.audio === 'error') return '原音保存失败 · 可重试';
  if (['pending', 'running'].includes(s.transcript)) return '转录中';
  if (s.transcript === 'offline') return '转录离线 · 可重试';
  if (s.transcript === 'error') return '转录失败 · 可重试';
  if (s.minutes === 'running' || s.minutes === 'pending') return '生成总结中';
  if (s.review === 'confirmed') return `总结已确认`;
  if (s.minutes === 'offline' || s.minutes === 'error') return '待生成总结';
  return '待确认总结';
}

function projectStatus(project) {
  if (project.audio === 'saved' && project.transcript === 'offline') return ['待转写', 'warn'];
  if (project.state === 'recording') return ['录音中', 'neutral'];
  const stages = [project.audio, project.transcript, project.minutes];
  if (stages.some((status) => ['error', 'offline', 'partial'].includes(status))) return ['处理失败', 'bad'];
  if (stages.some((status) => ['pending', 'running', 'composing'].includes(status))) return ['处理中', 'neutral'];
  if (project.review === 'confirmed') return ['已完成', 'good'];
  if (project.review === 'draft') return ['待确认', 'warn'];
  return ['处理中', 'neutral'];
}

// —— 初始化 ——
async function init() {
  if (inAccessories) {
    setupAccessoryShell();
    renderMain();
    if (!accessoryAgent) {
      if (embeddedCatalog) connectCatalogToHost();
      void refreshHardware();
      setInterval(() => { if (!document.hidden) void refreshHardware(); }, 5000);
      return;
    }
    window.addEventListener('recording-box-connection', event => {
      if (typeof event.detail !== 'boolean' || accessoryBoxReady === event.detail) return;
      accessoryBoxReady = event.detail;
      if (!accessoryBoxReady) {
        for (const audio of document.querySelectorAll('audio')) audio.pause();
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        if (S.rec) {
          S.rec.boxInterrupted = true;
          pauseCapture(S.rec);
          releaseStream(S.rec);
        }
      } else {
        void loadHealth();
        void loadList();
      }
      renderMain();
    });
    window.addEventListener('recording-open-project', event => {
      if (!accessoryBoxReady) return;
      if (S.rec || S.starting) return toast('请先结束当前录音');
      if (PROJECT_ID.test(event.detail)) void selectMeeting(event.detail);
    });
    void updateCapture();
    document.querySelector('link[rel="icon"]').href = '/' + accessoryPage + '-agent.svg';
    window.addEventListener('popstate', () => openAccessoryLocation());
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $('appMenu').open = false; go(a.dataset.view); }));
  $('newMeeting').addEventListener('click', () => { if (S.rec) { toast('请先结束当前录音'); selectMeeting(S.rec.meetingId); return; } selectMeeting(null); });
  window.addEventListener('beforeunload', (e) => { if (S.rec || (accessoryAgent && S.starting)) { e.preventDefault(); e.returnValue = ''; } });
  if (!inAccessories || accessoryPage === 'disk') {
    if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    try { S.settings = await api('/api/settings'); } catch { S.settings = { preferredInput: null, memoryDefault: true }; }
    if (!S.settings.preferredInput) {
      try { const p = JSON.parse(localStorage.getItem(LS_PREF) || 'null'); if (p && (p.deviceId || p.label)) S.settings.preferredInput = p; } catch { /* 忽略 */ }
    }
    await checkPermission();
  }
  await Promise.all([loadHealth(), loadList(), refreshTemplates().catch(() => {})]);
  if (accessoryPage === 'disk' && S.health?.desktop) {
    await updateUsb();
    setInterval(() => { if (!document.hidden) void updateUsb(); }, 4500);
  }
  const hid = location.hash.slice(1);
  if (accessoryAgent && hid) await openAccessoryLocation();
  else if (PROJECT_ID.test(hid) && S.meetings.some((m) => m.id === hid)) await selectMeeting(hid);
  else render();
  if (accessoryAgent) window.addEventListener('recording-media-status', () => loadHealth().then(() => { if (!S.edit) renderMain(); }));
  setInterval(loadHealth, 20000);
  setInterval(poll, 600);
  if (accessoryAgent) setInterval(() => {
    if (!document.hidden && (S.view === 'history' || (S.view === 'meeting' && !S.currentId)) && !S.starting) void loadList({ quiet: true });
  }, 3000);
  requestAnimationFrame(drawLoop);
}

async function refreshTemplates() {
  S.templateCatalog = await api('/api/minutes-templates');
}

async function loadHealth() {
  const previous = S.health?.media;
  try { S.health = await api('/api/health'); } catch { S.health = null; }
  const connection = S.health?.media;
  $('modeBadge').textContent = connection?.connected ? '盒端已连接' : '独立模块';
  if (JSON.stringify(previous) !== JSON.stringify(connection) && S.view === 'meeting' && !S.edit) {
    if (!S.currentId || ['offline', 'done'].includes(S.meeting?.transcript?.status)) renderMain();
  }
}
let listRequest = 0;
async function loadList({ quiet = false } = {}) {
  const request = ++listRequest;
  try {
    const { meetings } = await api('/api/meetings');
    if (request !== listRequest) return;
    if (accessoryAgent && quiet && !S.listError && JSON.stringify(meetings) === JSON.stringify(S.meetings)) return;
    S.meetings = meetings;
    S.listError = '';
  } catch (e) {
    if (request !== listRequest) return;
    S.listError = e.message;
    if (!quiet && !accessoryAgent) toast(e.message);
  }
  if (accessoryAgent) renderAccessoryProjects();
  else renderSide();
}

async function checkPermission() {
  try {
    const st = await navigator.permissions?.query({ name: 'microphone' });
    if (st) { S.permission = st.state; st.onchange = () => { S.permission = st.state; refreshDevices().then(render); }; }
  } catch { /* 部分浏览器不支持 */ }
  await refreshDevices();
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) { S.devices = []; return { added: [], removed: [] }; }
  const all = await navigator.mediaDevices.enumerateDevices();
  const ins = all.filter((d) => d.kind === 'audioinput' && d.label && (!accessoryAgent || !['default', 'communications'].includes(d.deviceId)));
  if (ins.length) { S.permission = 'granted'; S.micError = ''; }
  const prev = new Map(S.devices.map((d) => [d.deviceId, d]));
  const next = ins.map((d) => ({ deviceId: d.deviceId, label: d.label }));
  const nextIds = new Set(next.map((d) => d.deviceId));
  const added = prev.size ? next.filter((d) => !prev.has(d.deviceId)) : [];
  const removed = [...prev.values()].filter((d) => !nextIds.has(d.deviceId));
  S.devices = next;
  if (S.selectedDeviceId && !nextIds.has(S.selectedDeviceId)) S.selectedDeviceId = '';
  if (!S.rec && !S.selectedDeviceId) S.selectedDeviceId = preferredDeviceId() || (!inAccessories && !S.settings?.preferredInput ? (next.find((d) => d.deviceId === 'default') || next[0])?.deviceId || '' : '');
  if (accessoryPage === 'disk') matchDisc();
  return { added, removed };
}
function preferredDeviceId() {
  const p = S.settings?.preferredInput;
  if (!p) return '';
  const d = S.devices.find((x) => p.deviceId && x.deviceId === p.deviceId) || S.devices.find((x) => p.label && x.label === p.label);
  return d ? d.deviceId : '';
}
const deviceLabel = (id) => S.devices.find((d) => d.deviceId === id)?.label || '';

function normalizedInput(label) {
  return (label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i,'').trim().toLowerCase();
}
function detectedDisc() {
  const candidates = S.usb?.devices.filter(d => d.manufacturer.toLowerCase() === 'timesintelli' && normalizedInput(d.name) === 'usb microphone v1.2');
  return candidates?.length === 1 ? candidates[0] : null;
}
function matchDisc() {
  const disc = detectedDisc();
  if (!disc || S.rec) return;
  const matches = S.devices.filter(d => normalizedInput(d.label) === normalizedInput(disc.name));
  if (matches.length === 1 && !S.selectedDeviceId) S.selectedDeviceId = matches[0].deviceId;
}
let scanningUsb = false;
async function updateUsb() {
  if (scanningUsb) return;
  scanningUsb = true;
  try {
    const next = await api('/api/usb-inputs');
    if (JSON.stringify(next) === JSON.stringify(S.usb)) return;
    S.usb = next;
    await refreshDevices();
    if (S.view === 'meeting' && !S.currentId) renderMain();
  } catch { /* 浏览器设备列表仍可使用。 */ }
  finally { scanningUsb = false; }
}
async function requestPermission() {
  if (S.checkingMic) return false;
  S.checkingMic = true;
  S.micError = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Chromium exposes input labels while this temporary track is active.
    await refreshDevices();
    S.permission = 'granted';
    if (!S.devices.length) S.micError = '已允许麦克风，但还没有读到音频输入。请确认圆盘已接好，再点「重新检测」。';
  } catch (e) {
    S.permission = e.name === 'NotAllowedError' ? 'denied' : 'unknown';
    S.micError = S.permission === 'denied' ? (S.health?.desktop ? '请在系统设置的麦克风权限中允许记忆盒子，再重新检测。' : '请允许浏览器使用麦克风。') : '无法打开音频输入，请检查设备后重新检测。';
  } finally { stream?.getTracks().forEach(t => t.stop()); S.checkingMic = false; }
  if (S.micError) S.setupOpen = true;
  render();
  return !S.micError && S.devices.length > 0;
}

async function savePreference(deviceId) {
  const label = deviceLabel(deviceId);
  if (!label) return;
  const pref = { deviceId, label };
  try { localStorage.setItem(LS_PREF, JSON.stringify(pref)); } catch { /* 忽略 */ }
  try { S.settings = await api('/api/settings', { method: 'PUT', json: { preferredInput: pref } }); } catch (e) { toast(`偏好未保存：${e.message}`); }
  renderSide();
}

async function onDeviceChange() {
  const { added, removed } = await refreshDevices();
  if (accessoryPage === 'disk' && S.health?.desktop) await updateUsb();
  const rec = S.rec;
  if (rec) {
    if (rec.state === 'paused' && added.length) {
      rec.notice = { kind: 'warn', text: `检测到新输入「${added.map((d) => d.label).join('」「')}」。不会自动切换；如需使用，请在选择器中明确选择后点「继续」。` };
    } else if (rec.state === 'recording' && added.length) {
      rec.notice = { kind: 'info', text: `检测到新输入「${added.map((d) => d.label).join('」「')}」，录音仍使用「${rec.deviceLabel}」。如需切换请先暂停再明确选择。` };
    }
    if (removed.some((d) => d.deviceId === rec.deviceId) && rec.state === 'paused' && !rec.deviceLost) {
      rec.notice = { kind: 'bad', text: `暂停中的输入「${rec.deviceLabel}」已移除，请明确选择其他输入后继续。` };
    }
  }
  render();
}

function go(view) {
  S.view = view;
  render();
}

function setMeetingLocation(id, replace = false) {
  if (!accessoryAgent) {
    history.replaceState(null, '', id ? `#${id}` : location.pathname);
    return;
  }
  const hash = id ? `#${id}` : '';
  if (location.hash === hash) return;
  const url = location.pathname + hash;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

async function openAccessoryLocation() {
  const id = location.hash.slice(1);
  if (id && !PROJECT_ID.test(id)) {
    toast('项目链接无效');
    return selectMeeting(null, { replace: true });
  }
  return selectMeeting(id || null, { replace: true });
}

async function selectMeeting(id, { replace = false } = {}) {
  if (accessoryAgent && id && S.rec && S.rec.meetingId !== id) {
    setMeetingLocation(S.rec.meetingId, true);
    toast('请先结束当前录音');
    return;
  }
  S.view = 'meeting';
  if (S.currentId !== id) { S.edit = null; S.transcriptOpen = false; S.transcriptQuery = ''; S.lastSig = ''; }
  S.currentId = id;
  S.meeting = null;
  setMeetingLocation(id, replace);
  if (accessoryAgent) {
    $('main').scrollTop = 0;
    renderMain();
  }
  if (id) {
    try {
      const meeting = await api(`/api/meetings/${id}`);
      if (S.currentId !== id) return;
      if (accessoryAgent && meeting.source !== accessoryPage) throw new Error('此项目不属于当前智能体');
      S.meeting = meeting;
      const row = S.meetings.find((entry) => entry.id === id);
      if (row) Object.assign(row, {
        state: meeting.state, audio: meeting.audio.status, transcript: meeting.transcript.status,
        minutes: meeting.minutes.status, review: meeting.review.status, reviewVersion: meeting.review.version, durationMs: meeting.durationMs,
      });
    } catch (e) {
      if (S.currentId !== id) return;
      toast(e.message); S.currentId = null;
      if (accessoryAgent) setMeetingLocation(null, true);
    }
  } else if (accessoryAgent) {
    void loadList({ quiet: true });
  }
  render();
}

let polling = false;
async function poll() {
  if (polling || !S.currentId || S.view !== 'meeting') return;
  const m = S.meeting;
  const live = S.rec && S.rec.meetingId === S.currentId;
  const busy = m && (m.pipelineRunning || ['pending', 'composing'].includes(m.audio.status) || ['pending', 'running'].includes(m.transcript.status) || ['pending', 'running'].includes(m.minutes.status));
  if (m && !live && !busy) return;
  polling = true;
  try {
    const fresh = await api(`/api/meetings/${S.currentId}`);
    if (fresh.id !== S.currentId || (accessoryAgent && fresh.source !== accessoryPage)) return;
    S.meeting = fresh;
    if (live) updateLive();
    else if (sig(fresh) !== S.lastSig) { render(); }
    if (!live) loadList();
  } catch { /* 下次再试 */ } finally { polling = false; }
}
const sig = (m) => [m.state, m.audio.status, m.transcript.status, m.transcript.segments.length, m.minutes.status, m.minutes.rev, m.review.status, m.review.version, m.memory?.status, m.pipelineRunning, m.memoryEnabled].join('|');

// —— 渲染骨架 ——
function render() {
  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.view === S.view;
    a.classList.toggle('on', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!inAccessories) renderSide();
  renderMain();
}

function renderSide() {
  const list = $('meetingList'); list.replaceChildren();
  if (!S.meetings.length) list.append(h('p', { class: 'empty' }, '还没有录音'));
  for (const s of S.meetings) {
    const recNow = S.rec && S.rec.meetingId === s.id;
    list.append(h('button', {
      class: `mitem ${S.view === 'meeting' && S.currentId === s.id ? 'on' : ''}`, type: 'button', 'aria-current': S.view === 'meeting' && S.currentId === s.id ? 'true' : undefined,
      onclick: () => selectMeeting(s.id),
    }, h('span', { class: 'ic' }, h('span', { class: `disc ${recNow ? 'rec' : s.review === 'confirmed' ? 'is-ready' : ''}` })),
    h('span', null, h('span', { class: 't', title: s.title }, s.title), h('small', null, `${s.source === 'clip' ? '领夹' : '圆盘'} · ${listStatus(s)}`))));
  }
}

let renderSeq = 0;
function renderMain() {
  const main = inAccessories ? $('accessoryContent') : $('main');
  renderSeq++;
  main.replaceChildren();
  if (accessoryAgent) {
    const blocked = !accessoryBoxReady || Boolean(S.rec?.boxInterrupted);
    document.querySelector('.studio-nav nav').inert = blocked;
    if (blocked) {
      $('accessoryDetailBack').hidden = true;
      const rec = S.rec;
      const title = accessoryBoxReady ? '录音待保存' : '盒子未连接';
      const detail = rec ? '录音已暂停。结束后，原音会保存在本机。' : '连接盒子后可使用配件功能。';
      main.append(h('section', { class:'box-connect-notice accessory-box-connect', 'aria-label':'配件连接提示' },
        h('span', {class:'box-connect-icon'}, h('span', {class:'box-connect-glyph', 'aria-hidden':'true'})),
        h('div', {class:'box-connect-copy', role:'status'}, h('strong', null, title), h('p', null, detail),
          rec?.notice ? h('p', { role:'alert' }, rec.notice.text) : null),
        rec ? h('button', { class:'box-connect-button', type:'button', disabled:rec.state==='finishing', onclick:finishRecording },
          rec.state==='finishing' ? '正在保存…' : '结束录音并保存') :
          h('a', { class:'box-connect-button', href:'/accessories/connect-box' }, '连接盒子')));
      return;
    }
  }
  if (inAccessories) {
    $('accessoryDetailBack').hidden = !accessoryAgent || (S.view === 'meeting' && !S.currentId);
    if (!accessoryAgent) return renderAccessoryCatalog(main);
    for (const button of document.querySelectorAll('[data-agent-view]')) {
      if (button.dataset.agentView === S.view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (S.view === 'history') {
      main.append(projectShelf(true));
      return renderAccessoryProjects();
    }
    if (S.view === 'meeting' && !S.currentId) return renderAccessoryWorkbench(main);
  }
  if (S.view === 'templates') return renderTemplates(main);
  if (S.view === 'space') return renderSpace(main);
  if (S.view === 'starmap') return renderStarmap(main);
  if (S.view === 'memory') return renderMemory(main);
  if (!S.currentId) return renderSetup(main);
  const m = S.meeting;
  if (!m) { main.append(h('div', { class: 'muted' }, '加载中…')); return; }
  if (m.state === 'recording') {
    if (S.rec && S.rec.meetingId === m.id) return renderLive(main);
    return renderInterrupted(main);
  }
  return renderReview(main);
}

function setupAccessoryShell() {
  $('recordingApp').classList.add('accessory-mode');
  $('accessoryHeader').hidden = false;
  $('recordingHeader').hidden = true;
  $('recordingSidebar').hidden = true;
  $('recordingBody').classList.add('accessory-body');
  $('main').classList.add('accessory-main');
  const content = h('div', { class:'accessory-content', id:'accessoryContent' });
  const back = h('div', {class:'accessory-detail-back', id:'accessoryDetailBack', hidden:true},
    h('a', {class:'accessory-back', href:location.pathname, onclick:handleProjectLink(null)}, '‹ 返回智能体工作台'));
  if (accessoryAgent) {
    const navigate = (key) => key === 'meeting' ? selectMeeting(null) : go(key);
    const rail = h('header', {class:'studio-nav'},
      h('span', {class:'agent-directory-link agent-identity'},
        h('img', {src:'/' + accessoryPage + '-agent.svg', width:30, height:30, alt:''}), accessoryAgent.title),
      h('nav', {'aria-label':'智能体导航'}, [['meeting','工作台'],['history','历史项目'],['templates','总结偏好']].map(([key,label]) =>
        h('button', {type:'button', 'data-agent-view':key, onclick:() => navigate(key)}, label))));
    $('main').append(h('div', {class:'agent-frame studio-'+accessoryPage}, rail, h('div', {class:'agent-pane'}, back, content)));
  } else $('main').append(back, content);
  $(accessoryPage === 'boxes' ? 'accessoryBoxesTab' : 'accessoriesTab').setAttribute('aria-current', 'page');
  if (accessoryAgent) document.title = `${accessoryAgent.title} · 记忆盒子`;
  else document.title = `${accessoryPage === 'boxes' ? '盒子' : '配件'} · 记忆盒子`;
  $('accessoryTabs').addEventListener('click', (event) => {
    if (event.target.closest('a') && (S.rec || S.starting)) {
      event.preventDefault();
      toast(S.rec ? '请先结束当前录音' : '录音项目正在创建');
    }
  });
}

function accessoryArt(source) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 170');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `/accessory-art.svg#${source}`);
  svg.append(use);
  return h('div', { class: 'accessory-art', 'aria-hidden': 'true' }, svg);
}

const hardware = {
  disk: { name:'会议AI定向麦克风', description:'会议现场定向拾音，支持实时字幕。' },
  clip: { name:'随身AI领夹麦克风', description:'随身录制音频，导入后转写并整理。' },
  storage: { name:'拓展存储硬盘', description:'在空间中浏览盒子上的外接硬盘。' },
};

const embeddedCatalog = location.protocol === 'wanx-accessories:' && parent !== window;
function publishCatalog() {
  const items = Object.entries(hardware).map(([key, item]) => ({
    key, title:item.name, status:document.querySelector('[data-hardware="' + key + '"]')?.textContent || '',
  }));
  parent.postMessage({type:'catalog-items', items}, '*');
}
function connectCatalogToHost() {
  publishCatalog();
  window.addEventListener('message', event => {
    if (event.source === parent && event.data?.type === 'catalog-check') publishCatalog();
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('.accessory-card-link');
    if (link) {
      event.preventDefault();
      parent.postMessage({type:'catalog-open', key:new URL(link.href).pathname.split('/').pop()}, '*');
    } else if (!event.target.closest('a,button,input,textarea,select') && !getSelection()?.toString()) {
      parent.postMessage({type:'catalog-background'}, '*');
    }
  });
  document.addEventListener('keydown', event => {
    if (!event.repeat && !event.isComposing && (event.ctrlKey || event.metaKey)
      && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      parent.postMessage({type:'catalog-guide'}, '*');
    } else if (event.key === 'Escape') parent.postMessage({type:'catalog-background'}, '*');
  });
}

let readingVolumes = false;
function hardwareState(kind, text) {
  const node = document.querySelector('[data-hardware="' + kind + '"]');
  if (node) {
    node.textContent = text;
    node.dataset.ready = String(text === '已连接');
    if (embeddedCatalog) publishCatalog();
  }
}

async function refreshHardware() {
  if (!readingVolumes) {
    readingVolumes = true;
    api('/api/nas/volume-status', {json:{}}).then(result => hardwareState('storage', result.connected ? '已连接' : '未连接'))
      .catch(() => hardwareState('storage', '无法读取盒子连接状态')).finally(() => { readingVolumes = false; });
  }
  try {
    S.usb = await api('/api/usb-inputs');
    const available = S.usb.supported && !S.usb.unavailable;
    hardwareState('disk', detectedDisc() ? '已连接' : available ? '未检测到匹配设备' : '连接状态未知');
    const clip = S.usb.devices.some(device => /领夹|lavalier|lapel/i.test(device.name));
    hardwareState('clip', clip ? '已连接' : available ? '未检测到匹配设备' : '连接状态未知');
  } catch {
    hardwareState('disk', '连接状态未知');
    hardwareState('clip', '连接状态未知');
  }
}

function renderAccessoryCatalog(main) {
  main.append(h('section', {class:'accessory-catalog', 'aria-label':'配件目录'},
    h('div', {class:'accessory-grid'}, Object.entries(hardware).map(([kind, item]) =>
      h('article', {class:'accessory-card'},
        h('div', {class:'catalog-art '+kind}, accessoryArt(kind)),
        h('div', {class:'accessory-card-copy'},
          h('span', {class:'studio-status', 'data-hardware':kind}, '正在检测…'),
          h('h2', null, item.name), h('p', null, item.description),
          h('a', {class:'accessory-card-link', href:ACCESSORIES_PATH + '/' + kind},
            kind === 'storage' ? '打开空间' : '打开' + accessoryAgents[kind].title)))))));
}

function mediaReconnectLink() {
  return S.health?.desktop ? h('a', {href:'/accessories/connect'}, '重新连接媒体服务') : null;
}

let captureEnabled = null;
let captureBusy = false;
let captureError = '';

async function updateCapture(action) {
  if (captureBusy) return;
  captureBusy = true;
  captureError = '';
  renderMain();
  try {
    const result = await api('/api/recording-capture', action ? {json:{action}} : {});
    captureEnabled = result.enabled;
  } catch (error) {
    captureEnabled = null;
    captureError = error.message;
  } finally {
    captureBusy = false;
    if (S.view === 'meeting' && !S.currentId) renderMain();
  }
}

function captureControl() {
  const label = captureEnabled ? '移出自动记忆采集' : '添加到自动记忆采集';
  return h('div', {class:'studio-service'},
    h('button',{type:'button',class:'studio-link','aria-label':'让 CentaurAI 解释记忆采集',onclick:()=>location.assign('/accessories/guide-capture?capture='+(captureEnabled===null?'unknown':captureEnabled?'on':'off'))},'记忆采集 ✨'),
    h('span', {role:'status'}, captureError || (captureEnabled === null ? '正在读取采集设置…'
      : captureEnabled ? '已加入 · 确认后的录音总结会自动存入记忆' : '尚未加入 · 可逐条手动保存总结')),
    h('button', {class:'studio-link', type:'button', disabled:captureBusy || (captureEnabled === null && !captureError),
      onclick:() => updateCapture(captureError ? undefined : captureEnabled ? 'remove' : 'add')},
      captureError ? '重新读取' : label));
}

function renderAccessoryWorkbench(main) {
  const media = S.health?.media;
  const disk = accessoryPage === 'disk';
  const statusText = (capability, label) => media?.[capability] ? (capability === 'transcribe' ? '可转写' : label+'已就绪')
    : media?.connected ? label+'待盒端就绪' : label+'暂不可用';
  const file = h('input', { type: 'file', hidden: true, accept: 'audio/*,.wav,.flac,.m4a,.mp3,.ogg',
    onchange: e => { if (e.target.files[0]) void importClip(e.target.files[0]); } });
  const begin = async () => {
    if (S.rec) return selectMeeting(S.rec.meetingId);
    if (S.starting || S.importing || S.micTest?.active) return;
    if (!disk) return file.click();
    if (S.checkingMic) return;
    if ((!S.devices.length || S.permission !== 'granted') && !await requestPermission()) return;
    if (!S.selectedDeviceId) { S.setupOpen = true; renderMain(); toast('请选择本次拾音设备'); return; }
    S.starting = true;
    try { await startRecording(null, 'disk'); } finally { S.starting = false; if (!S.currentId) renderMain(); }
  };
  const profile = templateById(S.nextTemplateId || S.templateCatalog?.defaultId);
  const disc = disk && detectedDisc();
  const chosen = disk && deviceLabel(S.selectedDeviceId);
  const deviceText = disc ? '圆盘已连接 · '+disc.name : chosen ? '已选输入 · '+chosen :
    S.usb?.supported && !S.usb.unavailable ? '未检测到已识别的圆盘' : '等待识别拾音设备';
  const status = h('span', {class:'studio-status', 'data-ready':String(disk ? !!(disc || chosen) : !!media?.transcribe)}, disk ? deviceText : '本机音频导入');
  const primary = h('button', {class:'studio-action', type:'button', onclick:begin, disabled:S.starting || S.importing || S.micTest?.active},
        S.rec ? '返回当前录音' : S.importing ? '正在导入…' : accessoryAgent.action);
  main.append(h('section', {class:'accessory-workbench'},
    h('div', {class:'studio-cover'},
      h('div', {class:'studio-copy'}, status, h('h1', null, accessoryAgent.title),
        h('p', null, disk ? '拾取现场声音，边录边看字幕。' : '把随身录下的长音频，整理成可以回看的文字。'), primary,
        file), accessoryArt('studio-'+accessoryPage)),
    captureControl(),
    disk && !S.rec ? micPanel() : null,
    h('div', {class:'studio-service'},
      h('span', null, [disk && statusText('live','实时字幕'), statusText('transcribe','文件转写')].filter(Boolean).join(' · ')),
      !media?.transcribe || (disk && !media?.live) ? mediaReconnectLink() : null),
    media?.summaryLocation === 'cloud' ? h('small', {class:'muted'}, '总结时由盒子将转录文本发送到云模型。') : null,
    profile && !S.rec ? h('details', {class:'studio-method', open:S.methodOpen,
      ontoggle:e => { if (e.target.isConnected) S.methodOpen = e.target.open; }},
      h('summary', null, h('span',{class:'studio-method-icon', 'aria-hidden':'true'}, '≡'), '本次总结方式', h('strong', null, profile.name)),
      h('div', {class:'studio-method-body'}, h('div', {class:'studio-choices', 'aria-label':'选择本次总结方式'},
        S.templateCatalog.templates.map(t => h('button', {type:'button', 'aria-pressed':String(t.id === profile.id),
          onclick:() => { S.nextTemplateId = t.id; S.methodOpen = true; renderMain(); $('chosenMethod')?.focus(); },
          id:t.id === profile.id ? 'chosenMethod' : undefined}, t.name))),
        h('p', null, profile.rules), h('button', {type:'button', class:'studio-link', onclick:() => { S.templateViewId = profile.id; go('templates'); }}, '自定义总结规则 →'))) : null,
    projectShelf(false)));
  renderAccessoryProjects();
}

function projectShelf(full) {
  const search = h('input', {type:'search', 'aria-label':'搜索项目标题', placeholder:'搜索项目标题', value:S.projectQuery,
    oninput:e => { S.projectQuery = e.target.value; renderAccessoryProjects(); }});
  const filters = ['', '录音中', '待转写', '处理中', '待确认', '已完成', '处理失败'];
  return h('section', {class:'studio-shelf'},
    h('div', {class:'studio-shelf-head'}, h(full ? 'h1' : 'h2', null, full ? '历史项目' : '最近项目'),
      full ? null : h('button', {class:'studio-link', type:'button', onclick:() => go('history')}, '查看全部 →')),
    full ? h('div', {class:'studio-library-controls'}, search,
      h('div', {class:'studio-choices', 'aria-label':'按项目状态筛选'}, filters.map(status =>
        h('button', {type:'button', 'data-filter':status, 'aria-pressed':String(S.projectFilter === status),
          onclick:() => { S.projectFilter = status; renderAccessoryProjects(); }}, status || '全部')))) : null,
    h('div', {class:'accessory-project-list', id:'accessoryProjectList'}));
}

function renderAccessoryProjects() {
  const list = $('accessoryProjectList');
  if (!list) return;
  const activeHref = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  const all = S.meetings.filter(p => p.source === accessoryPage).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const query = S.projectQuery.trim().toLocaleLowerCase();
  const projects = S.view === 'history'
    ? all.filter(p => (!S.projectFilter || projectStatus(p)[0] === S.projectFilter) && p.title.toLocaleLowerCase().includes(query))
    : all.slice(0, 4);
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === S.projectFilter));
  list.replaceChildren();
  if (S.listError) list.append(h('p', { class: 'accessory-empty', role: 'status' }, '暂时无法更新历史项目，服务恢复后会自动重试。'));
  if (!projects.length && !S.listError) list.append(h('div', {class:'studio-empty', role:'status'}, h('div', {class:'paper-icon', 'aria-hidden':'true'}, h('i')), h('strong', null, all.length ? '没有匹配的项目' : '还没有录音项目'), h('p', null, all.length ? '换个关键词或状态再试试。' : accessoryAgent.empty)));
  for (const project of projects) {
    const href = `#${project.id}`;
    const [label, tone] = projectStatus(project);
    const link = h('a', { class: 'accessory-project-row', href, onclick: handleProjectLink(project.id) },
      h('span', { class: 'accessory-project-name' }, project.title),
      h('span', { class: 'accessory-project-meta' }, h('time', { datetime: project.createdAt }, fmtDate(project.createdAt)), ' · ', fmt(project.durationMs)),
      h('span', { class: 'accessory-project-status', 'data-tone': tone }, label));
    list.append(link);
    if (href === activeHref) link.focus({ preventScroll: true });
  }
}

function handleProjectLink(id) {
  return (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void selectMeeting(id).then(() => $('main').focus({ preventScroll: true }));
  };
}

function renderTemplates(main) {
  main.append(h('div', { class: 'head' }, h('h1', null, '总结偏好')));
  const catalog = S.templateCatalog;
  if (!catalog) {
    main.append(h('button', { class: 'btn', type: 'button', onclick: () => refreshTemplates().then(render).catch((e) => toast(e.message)) }, '重新加载'));
    return;
  }
  const t = templateById(S.templateViewId) || templateById(catalog.defaultId);
  const edit = S.templateEdit;
  const beginEdit = () => {
    S.templateEdit = { id: t.builtin ? undefined : t.id, revision: t.builtin ? undefined : t.revision, name: t.builtin ? '' : t.name, rules: t.rules };
    renderMain();
    $('preferenceName').focus();
  };
  const pick = (profile) => h('button', { class: `btn ${t.id === profile.id ? 'selected' : ''}`, type: 'button', disabled: !!edit,
    'aria-pressed': String(t.id === profile.id), onclick: () => { S.templateViewId = profile.id; renderMain(); } },
  profile.name, profile.id === catalog.defaultId ? h('small', { class: 'muted' }, '默认') : null);
  const makeDefault = async (id) => {
    await api('/api/settings', { method: 'PUT', json: { defaultTemplateId: id } });
    await refreshTemplates();
  };
  const feedback = h('p', { class: 'err', role: 'alert' });
  const name = h('input', { type: 'text', id: 'preferenceName', value: edit?.name || '', maxlength: catalog.limits.name, required: true });
  const rules = h('textarea', { value: edit?.rules || '', rows: 5, maxlength: catalog.limits.rules, required: true });
  const save = h('button', { class: 'btn pri', type: 'submit' }, '保存偏好');
  const form = edit ? h('form', { class: 'preference-form', onsubmit: async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const payload = { id: edit.id, revision: edit.revision, name: name.value, rules: rules.value };
    save.disabled = true;
    feedback.textContent = '';
    try {
      const result = await api('/api/minutes-templates', { method: 'PUT', json: payload });
      S.templateCatalog = result;
      S.templateViewId = result.savedId;
      S.templateEdit = null;
      if (S.view === 'templates') renderMain();
      toast('已保存个人模板');
    } catch (err) { feedback.textContent = err.message; }
    finally { save.disabled = false; }
  } }, h('label', { class: 'field' }, '名称', name), h('label', { class: 'field' }, '希望 AI 怎样总结？', rules), feedback,
  h('div', { class: 'row' },
    h('button', { class: 'btn', type: 'button', onclick: () => { if (!save.disabled) { S.templateEdit = null; renderMain(); } } }, '取消'), save)) : null;
  if (edit) {
    name.addEventListener('input', () => { edit.name = name.value; });
    rules.addEventListener('input', () => { edit.rules = rules.value; });
  }
  main.append(h('section', { class: 'card preferences' },
    h('div', { class: 'preference-list', 'aria-label': '总结模板' }, catalog.templates.map(pick)),
    form || h('div', { class: 'preference-form' },
      h('p', { class: 'preference-rules' }, t.rules),
      h('div', { class: 'row' },
        t.id !== catalog.defaultId ? h('button', { class: 'btn pri', type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await makeDefault(t.id); if (S.view === 'templates') renderMain(); }
          catch (err) { toast(err.message); if (S.view === 'templates') renderMain(); }
        } }, '用于以后的录音') : null,
        h('button', { class: 'btn', type: 'button', onclick: beginEdit }, t.builtin ? '改成我的规则' : '编辑规则')))));
}

// —— 新录音 ——
function devicePicker({ disabled = false, onPick } = {}) {
  const wrap = h('div', { class: 'devpick' });
  if (S.permission !== 'granted' || !S.devices.length) {
    wrap.append(h('div', { class: 'grow' },
      h('div', { class: 'muted' }, S.micError || '允许使用麦克风后，可以选择圆盘或其他音频输入。')),
    h('button', { class: 'btn', type: 'button', disabled: S.checkingMic, onclick: requestPermission }, S.micError ? '重新检测' : '允许使用麦克风'));
    return wrap;
  }
  const sel = h('select', { 'aria-label': '输入设备', disabled, onchange: (e) => { S.selectedDeviceId = e.target.value; onPick && onPick(e.target.value); } },
    h('option', { value: '', disabled: true, selected: !S.selectedDeviceId }, '请选择输入设备'),
    S.devices.map((d) => h('option', { value: d.deviceId }, d.label)));
  sel.value = S.selectedDeviceId || '';
  wrap.append(sel, h('button', { class: 'btn sm', type: 'button', title: '重新检测输入设备', disabled, onclick: async () => { await refreshDevices(); render(); } }, '刷新'));
  return wrap;
}


function micPanel() {
  const test = S.micTest;
  const disc = detectedDisc();
  const selected = deviceLabel(S.selectedDeviceId);
  return h('details', {class:'studio-method', open:S.setupOpen,
    ontoggle:e => { if (e.target.isConnected) S.setupOpen = e.target.open; }},
    h('summary', null, '拾音设备', h('strong', null, selected || disc?.name || '选择麦克风')),
    h('div', {class:'studio-method-body'}, devicePicker({disabled:test?.active, onPick:() => {
      const id = S.selectedDeviceId;
      if (S.micTest?.url) URL.revokeObjectURL(S.micTest.url);
      S.micTest = null;
      void savePreference(id); renderMain();
    }}),
    h('button', {class:'btn sm', type:'button', disabled:test?.active || S.starting || !S.selectedDeviceId,
      onclick:testMicrophone}, test?.active ? '正在试录…' : '试录 5 秒'),
    test?.message ? h('p', {role:'status'}, test.message) : null,
    test?.url ? h('audio', {controls:true, src:test.url, 'aria-label':'本次试录回听'}) : null));
}

async function testMicrophone() {
  if (!accessoryBoxReady || S.micTest?.active || S.rec || S.starting || !S.selectedDeviceId) return;
  if (S.micTest?.url) URL.revokeObjectURL(S.micTest.url);
  const test = S.micTest = {active:true, message:'仅在本机试录，5 秒后自动停止。'};
  S.setupOpen = true;
  const deviceId = S.selectedDeviceId;
  renderMain();
  let stream, ctx, monitor, timeout;
  try {
    const input = await openInput(deviceId);
    stream = input.stream;
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    await ctx.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    monitor = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }, 45);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const started = performance.now();
    await new Promise((resolve,reject) => {
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => reject(new Error('采集失败，请检查拾音设备'));
      recorder.onstop = resolve;
      recorder.start();
      timeout = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 5000);
    });
    if (!chunks.length || performance.now()-started < 4700 || input.track.readyState !== 'live') throw new Error('试录被中断，请检查设备连接');
    test.url = URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));
    test.message = input.label+' · 已实录 5 秒 · '+(peak > 0 ? '峰值 '+Math.round(20*Math.log10(peak))+' dBFS' : '未检测到声音');
  } catch (err) { test.message = '试录失败：'+err.message; }
  finally {
    clearInterval(monitor); clearTimeout(timeout);
    stream?.getTracks().forEach(t => t.stop());
    if (ctx) await ctx.close().catch(() => {});
    test.active = false;
    if (S.view === 'meeting' && !S.currentId) renderMain();
  }
}

function renderSetup(main) {
  const connection = S.health?.media;
  const settings = h('details', { class: 'setup-settings source-settings', open: S.setupOpen,
    ontoggle: (e) => { if (e.target.isConnected) S.setupOpen = e.target.open; } },
    h('summary', null, '录音设置'),
    h('label', { class: 'field' }, '录音名称', h('input', { type: 'text', maxlength: '80', placeholder: '选填',
      value: S.draftTitle || '', oninput: (e) => { S.draftTitle = e.target.value; } })),
    h('div', { class: 'field' }, h('span', null, '拾音设备'), devicePicker({ onPick: () => render() })));
  const begin = async (source, button) => {
    if (S.starting || S.importing) return;
    S.starting = true; button.disabled = true;
    try {
      if (S.permission !== 'granted' && !await requestPermission()) return;
      if (!S.selectedDeviceId) { S.setupOpen = true; renderMain(); toast('请选择拾音设备'); return; }
      await startRecording(null, source);
    } catch (err) { toast(err.message); }
    finally { S.starting = false; button.disabled = false; }
  };
  const upload = h('input', { type: 'file', hidden: true, accept: 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aac,.webm',
    onchange: async (e) => { const file = e.target.files[0]; if (file) await importClip(file); e.target.value = ''; },
  });
  const sourceCard = (source, name, description, action, extra) => h('section', { class: 'card source-card' },
    h('div', { class: 'source-icon ' + source, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('h2', null, name), h('p', { class: 'muted' }, description), action, extra);
  main.append(h('section', { class: 'recording-home' },
    h('div', { class: 'home-heading' }, h('h1', null, '录音智能体'),
      h('p', null, '记录声音，整理成可以回听的录音总结。')),
    h('div', { class: 'source-grid' },
      sourceCard('disk', '会议圆盘', '边录边看字幕，结束后生成完整转写。',
        h('button', { class: 'btn pri', type: 'button', disabled: S.starting, onclick: (e) => begin('disk', e.currentTarget) }, '开始录音'),
        h('small', { class: 'muted' }, deviceLabel(S.selectedDeviceId) || '连接圆盘后选择拾音设备')),
      sourceCard('clip', '领夹麦克风', '长时间录音，导入后交给盒端异步转写。',
        h('button', { class: 'btn', type: 'button', disabled: S.starting || S.importing,
          onclick: () => upload.click(),
        }, S.importing ? '正在保存音频…' : '导入音频'),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: S.starting, onclick: (e) => begin('clip', e.currentTarget) }, '用接收器录音'))),
      h('p', { class: 'environment-note' }, connection?.connected ? '音频由已连接的盒子转写和总结。' : '请先连接盒端转录服务。'),
    settings, upload));
}

async function importClip(file) {
  if (!accessoryBoxReady || S.importing || S.starting || S.rec) return;
  S.importing = true;
  renderMain();
  try {
    const params = new URLSearchParams({name:file.name});
    const template = templateById(S.nextTemplateId);
    if (template) { params.set('templateId', template.id); params.set('templateRevision', template.revision); }
    const saved = await api('/api/import-audio?' + params, {
      method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' },
    });
    await loadList();
    S.nextTemplateId = ''; S.methodOpen = false;
    await selectMeeting(saved.id);
    if (template && saved.minutesTemplate && (saved.minutesTemplate.id !== template.id || saved.minutesTemplate.revision !== template.revision)) {
      toast('已打开此前导入的录音，可在总结中调整本次规则。');
    }
  } catch (err) { toast(err.message); }
  finally { S.importing = false; if (!S.currentId) renderMain(); }
}

// —— 录音引擎 ——
async function openInput(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const track = stream.getAudioTracks()[0];
  return { stream, track, deviceId, label: track.label || deviceLabel(deviceId) || '未命名输入' };
}

async function ensureGraph(rec) {
  if (!rec.node) {
    await rec.ctx.audioWorklet.addModule('/pcm-worklet.js');
    rec.node = new AudioWorkletNode(rec.ctx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: rec.channels, channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: { channels: rec.channels, live: rec.source === 'disk' } });
    rec.sink = rec.ctx.createGain(); rec.sink.gain.value = 0;
    rec.node.connect(rec.sink).connect(rec.ctx.destination);
    rec.node.port.onmessage = (e) => onWorkletMsg(rec, e.data);
  }
  if (rec.ctx.state === 'suspended') await rec.ctx.resume();
}

function attachStream(rec, inp) {
  rec.stream = inp.stream; rec.track = inp.track; rec.deviceId = inp.deviceId; rec.deviceLabel = inp.label; rec.deviceLost = null;
  rec.audioNode = rec.ctx.createMediaStreamSource(inp.stream);
  rec.audioNode.connect(rec.node);
  const track = inp.track;
  track.onended = () => onTrackEnded(rec, track);
  if (!rec.inputs.includes(inp.label)) rec.inputs.push(inp.label);
}
function releaseStream(rec) {
  try { rec.audioNode?.disconnect(); } catch { /* 已断开 */ }
  rec.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  rec.audioNode = null; rec.stream = null; rec.track = null;
}

function onWorkletMsg(rec, d) {
  if (!d) return;
  if (d.type === 'chunk') {
    const seq = rec.nextSeq++;
    rec.queue.push({ seq, pcm: d.pcm, fail: 0 });
    rec.pendingBytes += d.pcm.byteLength;
    if (rec.state === 'recording' && rec.pendingBytes >= MAX_PENDING_PCM) {
      pauseCapture(rec);
      rec.notice = { kind: 'bad', text: '待保存的音频较多，已暂停录音。恢复连接后可继续。' };
      render();
    }
    pumpUploads(rec);
  } else if (d.type === 'frame') {
    if (rec.source === 'disk' && S.health?.media?.live && !rec.liveSending) {
      rec.liveSending = true;
      void api(`/api/meetings/${rec.meetingId}/live`, {
        body: d.pcm, headers: { 'content-type': 'application/octet-stream' },
      }).catch(() => {}).finally(() => { rec.liveSending = false; });
    }
  } else if (d.type === 'level') {
    rec.levels.push(d.active && rec.state === 'recording' ? d.rms : 0);
    if (rec.levels.length > 120) rec.levels.shift();
    rec.peak = Math.max(d.peak, (rec.peak || 0) * 0.9);
    rec.rms = d.rms;
  } else if (d.type === 'flushed') {
    const w = rec.flushWaiters.get(d.id); if (w) w();
  }
}
function flushWorklet(rec) {
  return new Promise((resolve) => {
    if (!rec.node) return resolve();
    const id = ++rec.flushId;
    const done = () => { rec.flushWaiters.delete(id); resolve(); };
    rec.flushWaiters.set(id, done);
    rec.node.port.postMessage({ type: 'flush', id });
    setTimeout(done, 2000);
  });
}

async function pumpUploads(rec) {
  if (rec.uploading) return;
  rec.uploading = true;
  try {
    while (rec.queue.length && !rec.aborted) {
      const c = rec.queue[0];
      try {
        const r = await api(`/api/meetings/${rec.meetingId}/chunks?seq=${c.seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: c.pcm });
        rec.queue.shift();
        rec.pendingBytes -= c.pcm.byteLength;
        rec.saved = r.savedChunks; rec.savedMs = r.durationMs; rec.uploadError = '';
      } catch (e) {
        if (e.status && e.status < 500 && ![408, 429].includes(e.status)) { rec.uploadError = `片段 ${c.seq} 被拒绝：${e.message}`; rec.uploadFatal = true; break; }
        c.fail++;
        rec.uploadError = `本机保存失败，正在重试（${e.message}）`;
        updateLive();
        await sleep(Math.min(15000, 500 * 2 ** c.fail));
      }
      updateLive();
    }
  } finally { rec.uploading = false; updateLive(); }
}
async function waitDrained(rec, timeoutMs) {
  const t0 = Date.now();
  while (rec.queue.length) {
    if (rec.uploadFatal) throw new Error(rec.uploadError);
    if (Date.now() - t0 > timeoutMs) throw new Error(`仍有 ${rec.queue.length} 片未保存到本机`);
    pumpUploads(rec);
    await sleep(200);
  }
}

const elapsed = (rec) => rec.baseMs + rec.activeMs + (rec.state === 'recording' ? performance.now() - rec.resumedAt : 0);

async function startRecording(existing, source = existing?.source || 'disk') {
  if (!accessoryBoxReady) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { toast('此浏览器不支持 Web Audio 录音（需要 AudioWorklet）'); return; }
  const deviceId = S.selectedDeviceId;
  if (!deviceId) { toast('请先明确选择输入设备'); return; }
  let inp;
  try { inp = await openInput(deviceId); } catch (e) { toast(`无法打开输入「${deviceLabel(deviceId)}」：${e.message}`); await refreshDevices(); render(); return; }
  let m = existing;
  let context;
  try {
    if (!accessoryBoxReady) throw new Error('连接盒子后可使用配件功能。');
    const options = { latencyHint: 'interactive' };
    if (m?.sampleRate) options.sampleRate = m.sampleRate;
    context = new AudioContext(options);
    const channels = inp.track.getSettings().channelCount || m?.channels || 1;
    if (m?.channels && channels !== m.channels) throw new Error('拾音声道已变更，请使用原设备继续或开始新录音');
    if (channels > 8) throw new Error('当前录音最多支持 8 个声道');
    if (!m) {
      const title = (S.draftTitle || '').trim();
      const memoryEnabled = S.settings?.memoryDefault !== false;
      const template = templateById(S.nextTemplateId);
      m = await api('/api/meetings', { json: { title, templateId: template?.id, templateRevision: template?.revision, inputLabel: inp.label, memoryEnabled, source, sampleRate: context.sampleRate, channels } });
    }
  } catch (e) {
    void context?.close().catch(() => {});
    inp.stream.getTracks().forEach((t) => t.stop());
    if (e.status === 409) await refreshTemplates().then(render).catch(() => {});
    toast(`开始录音失败：${e.message}`);
    return;
  }
  const rec = captureState(m, inp.label);
  rec.ctx = context;
  try {
    await ensureGraph(rec);
    if (!accessoryBoxReady) {
      rec.boxInterrupted = true;
      rec.state = 'paused';
      inp.stream.getTracks().forEach(track => track.stop());
      await showActiveCapture(m, rec);
      return;
    }
    attachStream(rec, inp);
    rec.node.port.postMessage({ type: 'resume' });
  } catch (e) {
    inp.stream.getTracks().forEach((t) => t.stop());
    try { await rec.ctx?.close(); } catch { /* 忽略 */ }
    toast(`音频处理初始化失败：${e.message}`);
    return;
  }
  void savePreference(deviceId);
  await showActiveCapture(m, rec);
}

function captureState(m, label) {
  const rec = {
    meetingId: m.id, source: m.source, deviceLabel: label, state: 'recording', nextSeq: m.chunks.length, saved: m.chunks.length, savedMs: m.durationMs,
    channels: m.channels || 1, pendingBytes: 0, queue: [], uploading: false, uploadError: '', uploadFatal: false, aborted: false,
    levels: [], peak: 0, rms: 0, flushId: 0, flushWaiters: new Map(), inputs: [],
    baseMs: m.durationMs || 0, activeMs: 0, resumedAt: performance.now(), notice: null, deviceLost: null,
  };
  return rec;
}

async function showActiveCapture(m, rec) {
  rec.resumedAt = performance.now();
  S.nextTemplateId = ''; S.methodOpen = false;
  S.rec = rec; S.draftTitle = ''; S.setupOpen = false;
  S.view = 'meeting';
  S.currentId = m.id; S.meeting = m; S.edit = null;
  setMeetingLocation(m.id);
  await loadList();
  render();
}

function pauseCapture(rec) {
  if (rec.state !== 'recording') return;
  rec.node?.port.postMessage({ type: 'pause' });
  rec.activeMs += performance.now() - rec.resumedAt;
  rec.state = 'paused';
}

function onTrackEnded(rec, track) {
  if (rec.track !== track || S.rec !== rec) return;
  const label = rec.deviceLabel;
  pauseCapture(rec);
  releaseStream(rec);
  rec.deviceLost = label;
  S.selectedDeviceId = '';
  rec.notice = { kind: 'bad', text: `输入「${label}」已断开（例如 USB 被拔出），录音已自动暂停并释放该输入。已保存的片段全部保留；请明确选择输入后点「继续」，或直接「结束录音」。` };
  refreshDevices().then(() => { S.selectedDeviceId = ''; render(); });
}

async function resumeCapture() {
  const rec = S.rec;
  if (!accessoryBoxReady || !rec || rec.boxInterrupted || rec.state !== 'paused') return;
  if (rec.pendingBytes >= MAX_PENDING_PCM) { toast('请等待已录音频保存完成'); return; }
  if (rec.simulated) {
    rec.resumedAt = performance.now(); rec.state = 'recording'; render(); return;
  }
  const want = S.selectedDeviceId;
  if (!want) { toast('请先在选择器中明确选择输入设备'); return; }
  try {
    if (!rec.track || rec.track.readyState === 'ended' || rec.deviceId !== want) {
      const inp = await openInput(want);
      if (!accessoryBoxReady || rec.boxInterrupted) {
        inp.stream.getTracks().forEach(track => track.stop());
        return;
      }
      const count = inp.track.getSettings().channelCount;
      if (count && count !== rec.channels) {
        inp.stream.getTracks().forEach(track => track.stop());
        throw new Error('拾音声道已变更，请使用原设备继续');
      }
      releaseStream(rec);
      attachStream(rec, inp);
      api(`/api/meetings/${rec.meetingId}`, { method: 'PATCH', json: { inputLabel: rec.inputs.join(' → ') } }).catch(() => {});
    }
    if (rec.ctx.state === 'suspended') await rec.ctx.resume();
    if (!accessoryBoxReady || rec.boxInterrupted) return;
    rec.node.port.postMessage({ type: 'resume' });
    rec.state = 'recording'; rec.resumedAt = performance.now(); rec.notice = null;
  } catch (e) { toast(`无法打开输入：${e.message}`); }
  render();
}

async function teardown(rec) {
  rec.aborted = true;
  releaseStream(rec);
  try { rec.node?.disconnect(); } catch { /* 忽略 */ }
  try { await rec.ctx?.close(); } catch { /* 忽略 */ }
}

async function finishRecording() {
  const rec = S.rec;
  if (!rec || rec.state === 'finishing') return;
  pauseCapture(rec);
  rec.state = 'finishing';
  if (rec.boxInterrupted) renderMain();
  else updateLive();
  await flushWorklet(rec);
  try {
    await waitDrained(rec, 90000);
  } catch (e) {
    rec.state = 'paused';
    rec.notice = { kind: 'bad', text: `${e.message}。未保存片段仍在浏览器内存中，请检查本机服务后再点「结束录音」。` };
    rec.uploadFatal = false;
    render();
    return;
  }
  try {
    const audioOnly = rec.boxInterrupted || !accessoryBoxReady;
    const m = await api(`/api/meetings/${rec.meetingId}/finish`, { json: { chunkCount: rec.nextSeq, ...(audioOnly && {audioOnly:true}) } });
    await teardown(rec);
    S.rec = null;
    S.meeting = m; S.lastSig = '';
    toast(audioOnly ? '录音已结束，正在保存原音' : '录音已结束，正在保存原音并生成总结');
  } catch (e) {
    rec.state = 'paused';
    rec.notice = { kind: 'bad', text: `结束失败：${e.message}` };
  }
  await loadList();
  render();
}

// —— 录音中 ——
let liveRefs = null;

function renderLive(main) {
  const rec = S.rec;
  const paused = rec.state !== 'recording';
  const R = liveRefs = {
    timer: h('strong', null, fmt(elapsed(rec))),
    canvas: h('canvas', { class: 'wave', width: '800', height: '164', 'aria-label': '实时波形' }),
    level: h('p', { class: 'muted' }),
    draft: h('div', { class: 'tr', 'aria-live': 'polite' }),
  };
  const live = h('div', { class: 'agent-live' });
  main.append(live);
  live.append(
    h('section', { class: 'card capture' },
      h('div', { class: 'head' }, h('h1', null, S.meeting.title), h('span', { class: 'muted' }, rec.deviceLabel)),
      h('div', { class: 'timer' }, h('span', { class: `dot ${paused ? 'paused' : ''}` }), R.timer),
      R.canvas, R.level,
      rec.notice ? h('p', { class: `notice ${rec.notice.kind === 'bad' ? 'bad' : 'info'}` }, rec.notice.text) : null,
      paused && !rec.simulated && rec.state !== 'finishing' ? h('details', { open: !!rec.deviceLost || !S.selectedDeviceId, class: 'setup-settings' },
        h('summary', null, '拾音设备'), devicePicker({ onPick: () => render() })) : null,
      h('div', { class: 'row' },
        rec.state === 'recording'
          ? h('button', { class: 'btn', type: 'button', onclick: () => { pauseCapture(rec); render(); } }, '暂停')
          : h('button', { class: 'btn', type: 'button', disabled: rec.state === 'finishing' || (!S.selectedDeviceId && !rec.simulated), onclick: resumeCapture }, '继续'),
        h('button', { class: 'btn pri', type: 'button', disabled: rec.state === 'finishing', onclick: finishRecording }, rec.state === 'finishing' ? '正在保存…' : '结束录音'))),
    rec.source === 'disk'
      ? h('section', { class: 'card live-transcript' }, h('div', { class: 'card-h' }, '实时字幕', h('small', { class: 'x' }, '转录草稿')), R.draft)
      : h('p', { class: 'muted capture-note' }, '结束录音后，盒子会提取完整转写。'),
  );
  updateLive();
}
function updateLive() {
  const rec = S.rec, R = liveRefs;
  if (!rec || !R?.timer.isConnected) return;
  const lines = (S.meeting?.draft || []).slice(-60);
  if (!R.draft.isConnected) return;
  const fingerprint = JSON.stringify([S.health?.media?.live, S.meeting?.liveStatus, lines]);
  if (R.fingerprint === fingerprint) return;
  R.fingerprint = fingerprint;
  const atBottom = R.draft.scrollHeight - R.draft.scrollTop - R.draft.clientHeight < 40;
  R.draft.replaceChildren(...(lines.length ? lines.map((line) => h('div', { class: 'line' },
    h('span', { class: 'caption-dot' + (line.final ? ' stable' : ''), 'aria-hidden': 'true' }), h('p', null, line.text))) : [
    h('p', { class: 'empty' }, !S.health?.media?.live ? '原音正在本机保存。实时字幕未就绪，录音结束后可以转写。' : S.meeting?.liveStatus === 'offline' ? '暂时无法获取字幕，原音仍会保存。' : S.meeting?.liveStatus === 'reconnecting' ? '正在重连字幕…' : '正在等待语音…'),
  ]));
  if (atBottom) R.draft.scrollTop = R.draft.scrollHeight;
}
function drawLoop() {
  const rec = S.rec, R = liveRefs;
  if (rec && R && R.canvas.isConnected) {
    R.timer.textContent = fmt(elapsed(rec));
    const c = R.canvas, g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const n = 60, bw = W / n;
    const lv = rec.levels.slice(-n);
    for (let i = 0; i < n; i++) {
      const v = lv[i - (n - lv.length)] ?? 0;
      const db = v > 0 ? 20 * Math.log10(v) : -90;
      const k = Math.max(0.03, Math.min(1, (db + 60) / 54));
      const bh = k * (H - 16);
      g.fillStyle = v > 0 ? '#A6533F' : '#D7C1AB';
      g.fillRect(i * bw + bw * 0.2, (H - bh) / 2, bw * 0.6, bh);
    }
    const rms = rec.state === 'recording' ? rec.rms : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    const status = rec.uploadError || (rec.state === 'finishing' ? '正在保存录音' : rec.state === 'paused' ? '已暂停' : rec.peak > 0.98 ? '声音过响，请放远一点' : db < -50 ? '声音较轻' : '录音中');
    if (R.level.textContent !== status) R.level.textContent = status;
  }
  requestAnimationFrame(drawLoop);
}

// —— 未正常结束的录音 ——
function renderInterrupted(main) {
  const m = S.meeting;
  main.append(
    h('div', { class: 'head' }, h('div', null, h('h1', null, m.title), h('div', { class: 'sub' }, `录音未正常结束 · 已保存 ${m.chunks.length} 片 · ${fmt(m.durationMs)}`))),
    h('div', { class: 'notice' }, h('span', { class: 'grow' }, '这段录音没有按「结束录音」收尾（例如页面被关闭）。已写入本机的片段都在。可以继续在这段录音，或直接结束并处理已保存片段。')),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, '继续或结束'),
      h('div', { class: 'card-b' },
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, '继续录音使用的输入'), devicePicker({ onPick: () => render() })),
        h('div', { class: 'ctrl' },
          h('button', { class: 'btn', type: 'button', disabled: !S.selectedDeviceId || !!S.rec, onclick: () => startRecording(m) }, '继续录音'),
          h('button', { class: 'btn pri', type: 'button', disabled: !!S.rec, onclick: async () => { try { S.meeting = await api(`/api/meetings/${m.id}/finish`, { json: {} }); await loadList(); render(); } catch (e) { toast(e.message); } } }, '结束并处理已保存片段')))),
  );
}


// —— 录音总结 ——
async function openRegenerate(m) {
  const initial = m.minutes.template?.rules || m.minutesTemplate?.rules || templateById(S.templateCatalog?.defaultId)?.rules || '';
  const cloudSummary = S.health?.media?.summaryLocation === 'cloud';
  const requirements = h('textarea', { value: initial, rows: 5, maxlength: 2000, required: true });
  const feedback = h('p', { class: 'err', role: 'alert' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '取消');
  const submit = h('button', { class: 'btn pri', type: 'submit' }, '生成总结');
  const dialog = h('dialog', { class: 'modal regen-dialog', 'aria-labelledby': 'regenTitle',
    onclose: () => dialog.remove(), oncancel: (e) => { if (submit.disabled) e.preventDefault(); },
  }, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = cancel.disabled = requirements.disabled = true;
    feedback.textContent = '';
    try {
      const result = await api(`/api/meetings/${m.id}/retry`, { json: { stage: 'minutes', instruction: requirements.value, rev: m.minutes.rev } });
      dialog.close();
      if (S.currentId === m.id) { S.meeting = result; render(); }
    } catch (err) {
      feedback.textContent = err.message;
      submit.disabled = cancel.disabled = requirements.disabled = false;
    }
  } },
  h('div', { class: 'm-h' }, h('h2', { id: 'regenTitle' }, m.minutes.status === 'waiting' ? '生成录音总结' : '调整这次总结')),
  h('div', { class: 'm-b' },
    h('label', { class: 'field' }, '你希望 AI 怎样总结？', requirements),
    cloudSummary ? h('p', { class: 'muted' }, '生成总结时，盒子会将这条录音的转录文本和总结要求发送给已配置的云模型。') : null,
    m.review.status === 'confirmed' ? h('p', { class: 'muted' }, '重新生成会创建草稿，原确认版仍可在试用空间查看。') : null,
    feedback),
  h('div', { class: 'm-f' }, cancel, submit)));
  $('modalRoot').append(dialog);
  dialog.showModal();
}

async function confirmReview(m, button) {
  button.disabled = true;
  try {
    const r = await api(`/api/meetings/${m.id}/confirm`, { json: { documentReview: true, rev: m.minutes.rev } });
    if (S.currentId === m.id) { S.meeting = r.meeting; render(); }
    await loadList();
    toast(accessoryAgent ? (r.memory.status === 'saved' ? '总结已确认并存入记忆'
      : r.memory.status === 'pending' ? '总结已确认，采集暂未完成，可点「保存到记忆」重试' : '总结已确认，可以选择保存位置') : '总结已确认并存入试用空间');
  } catch (e) { toast(e.message); button.disabled = false; }
}

function getPlayer(m) {
  if (m.audio.status !== 'saved') return null;
  if (!S.player || S.player.id !== m.id) {
    const el = h('audio', { controls: true, preload: 'metadata', src: `/api/meetings/${m.id}/audio` });
    el.addEventListener('timeupdate', () => highlightPlaying(el.currentTime * 1000));
    S.player = { id: m.id, el };
  }
  return S.player.el;
}
function seek(ms) {
  const el = S.player?.el;
  const segs = S.meeting?.transcript?.segments || [];
  const seg = segs.find((s) => ms >= s.fromMs && ms < s.toMs) || segs.find((s) => s.fromMs >= ms);
  if (seg) { const drawer = document.querySelector('.transcript-drawer'); if (drawer) drawer.open = true; const row = document.querySelector(`[data-seg="${seg.i}"]`); if (row?.hidden) { const input = $('transcriptSearch'); if (input) { input.value = ''; input.dispatchEvent(new Event('input')); } } row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (!el || !el.isConnected) { toast('原始录音尚未就绪'); return; }
  el.currentTime = ms / 1000;
  el.play().catch(() => {});
}
function highlightPlaying(ms) {
  document.querySelectorAll('.ex .exl').forEach((r) => {
    const f = Number(r.dataset.from), t = Number(r.dataset.to);
    r.classList.toggle('hl', ms >= f && ms < t);
  });
}


function renderReview(main) {
  const m = S.meeting;
  S.lastSig = sig(m);
  const busy = m.pipelineRunning || ['running', 'pending'].includes(m.minutes.status);
  const sections = m.summarySections;
  const currentText = m.minutes.document?.text ?? sections.map((s) => [s.heading, ...s.blocks.map((b) => b.text)].join('\n\n')).join('\n\n');
  const confirmed = m.review.status === 'confirmed';
  const player = getPlayer(m);
  const editor = S.edit?.id === m.id ? S.edit : null;
  const canSummarize = m.transcript.status === 'done' && m.transcript.segments.length > 0;
  const media = S.health?.media;
  const awaitingSummary = canSummarize && media?.summaryOnRequest && m.minutes.status === 'waiting';
  let summaryUnavailable = '';
  if (accessoryAgent && !media?.summarize) {
    if (!media) summaryUnavailable = '正在检查盒端总结服务。';
    else if (!media.connected) summaryUnavailable = '请先连接盒子，再生成总结。';
    else if (media.summaryLocation === 'cloud') summaryUnavailable = '当前盒子的云端总结模型尚未就绪。';
    else summaryUnavailable = '当前盒子的总结服务暂不可用。';
  }
  const summaryAction = (label) => h('button', { class: 'btn sm', type: 'button',
    disabled: !!summaryUnavailable, onclick: () => openRegenerate(m) }, label);
  const reconnectSummary = media?.connected === false ? mediaReconnectLink() : null;

  const paragraph = (text, source) => h('p', { class: 'summary-paragraph' }, text,
    player && Number.isFinite(source?.startMs) ? ts(source.startMs) : null);
  const renderText = () => {
    if (typeof m.minutes.document?.text !== 'string') return sections.map((section) => h('section', null,
      h('h3', null, section.heading), section.blocks.map((b) => paragraph(b.text, b))));
    const titles = new Set(sections.map((s) => s.heading));
    const byText = new Map(sections.flatMap((s) => s.blocks.map((b) => [b.text, b])));
    return currentText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) =>
      titles.has(line) ? h('h3', null, line) : paragraph(line, byText.get(line)));
  };
  const more = h('details', { class: 'summary-more' }, h('summary', { 'aria-label': '总结操作' }, '···'),
    h('div', { class: 'menu-panel' },
      canSummarize && !awaitingSummary && !summaryUnavailable ? h('button', { type: 'button', onclick: () => { more.open = false; openRegenerate(m); } }, '调整这次总结') : null,
      accessoryAgent ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.memoryEnabled, onchange: async (e) => {
        try { const next = await api(`/api/meetings/${m.id}`, { method: 'PATCH', json: { memoryEnabled: e.target.checked } }); if (S.currentId === m.id) S.meeting = next; }
        catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
      } }), '确认时提炼到记忆'),
      accessoryAgent ? null : h('button', { type: 'button', onclick: () => { S.lib.spaceId = m.id; S.lib.spaceFile = null; go('space'); } }, '在试用空间查看')));
  const retry = async (stage, button) => {
    button.disabled = true;
    try { const result = await api(`/api/meetings/${m.id}/retry`, { json: { stage } }); if (S.currentId === m.id) { S.meeting = result; render(); } }
    catch (e) { toast(e.message); button.disabled = false; }
  };
  const reviewActions = busy || editor ? [] : [
    currentText ? h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      S.edit = { id: m.id, rev: m.minutes.rev, text: currentText };
      renderMain();
      $('summaryText').focus();
    } }, '编辑') : null,
    confirmed ? (accessoryAgent ? null : h('button', { class: 'btn pri', type: 'button', onclick: openImport }, '导入星图')) :
      currentText ? h('button', { class: 'btn pri', type: 'button', onclick: (e) => confirmReview(m, e.currentTarget) }, '确认总结') : null,
    more,
  ];
  const documentTitle = h('div', { class: 'summary-header' },
    h('h2', null, '录音总结'),
    confirmed ? h('span', { class: 'confirmed-label' }, '已确认 · v' + m.review.version) : null,
    h('div', { class: 'summary-actions' }, reviewActions));
  let body;
  if (editor) {
    const input = h('textarea', { id: 'summaryText', value: editor.text, rows: 10, maxlength: 60000, required: true,
      'aria-label': '总结正文', oninput: (e) => { editor.text = e.target.value; } });
    const feedback = h('p', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn pri', type: 'submit' }, '保存');
    body = h('form', { class: 'summary-editor', onsubmit: async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        const result = await api(`/api/meetings/${m.id}/minutes`, { method: 'PUT', json: { rev: editor.rev, documentText: editor.text } });
        if (S.currentId === m.id) { S.meeting = result; S.edit = null; render(); }
        await loadList();
      } catch (err) { feedback.textContent = err.message; save.disabled = false; }
    } }, input, feedback, h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { if (!save.disabled) { S.edit = null; renderMain(); } } }, '取消'), save));
  } else if (busy) {
    body = h('p', { class: 'muted summary-message', role: 'status' },
      m.audio.status !== 'saved' ? '正在保存录音…' : ['pending', 'running'].includes(m.transcript.status) ? '正在转录…' : '正在生成录音总结…');
  } else {
    const stage = m.audio.status !== 'saved' ? 'audio' : !canSummarize && ['offline', 'error', 'partial'].includes(m.transcript.status) ? 'transcript' : 'minutes';
    const error = m[stage].error;
    body = h('div', { class: 'summary-document' },
      awaitingSummary ? h('p', { class: 'notice info' },
        summaryUnavailable || '转写已完成，可以生成录音总结。', summaryAction('生成总结'), reconnectSummary) : null,
      error && ['error', 'offline', 'partial'].includes(m[stage].status) ? h('p', { class: 'notice info' },
        stage === 'audio' ? '录音保存失败。' : stage === 'transcript' ? (m.transcript.status === 'partial' ? `转录尚未完成，${error}。` : '转录暂不可用。') : summaryUnavailable || '这次未能生成总结。',
        stage === 'transcript' && m.audio.status === 'saved' && !S.health?.media?.transcribe && accessoryAgent ?
          h('span', null, ' 原音已保存在本机，可随时回听。',
            S.health?.media?.connected ? '盒端转写尚未就绪。' : '请确认已连接盒子。',
            mediaReconnectLink()) :
        stage === 'minutes' ? [summaryAction('重试'), reconnectSummary] :
          h('button', { class: 'btn sm', type: 'button', onclick: (e) => retry(stage, e.currentTarget) }, stage === 'transcript' ? '重试转写' : '重试')) : null,
      currentText ? renderText() : h('div', { class: 'summary-message' }, h('p', { class: 'muted' }, '还没有总结。'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { S.edit = { id: m.id, rev: m.minutes.rev, text: '' }; renderMain(); $('summaryText').focus(); } }, '手动编写')));
  }
  const transcript = m.transcript.segments.length ? m.transcript.segments : m.draft;
  main.append(h('div', { class: 'recording-detail' },
    h('div', { class: 'head detail-heading' }, h('h1', null, m.title),
      h('p', { class: 'muted' }, `${m.source === 'clip' ? '领夹' : '圆盘'} · ${fmtDate(m.createdAt)} · ${fmt(m.durationMs)}`)),
    h('article', { class: 'card summary-card' }, documentTitle, body, accessoryAgent && confirmed && !editor ? recordingDestinations(m) : null, confirmed ? importReceipt(m) : null),
    h('aside', { class: 'card listening' }, h('h2', { class: 'card-h' }, '原音回听'), player ? h('div', { class: 'audio-strip' }, player) : h('p', { class: 'empty' }, '正在准备原音…'),
    accessoryAgent && player ? h('label', {class:'playback-speed'}, '播放速度',
      h('select', {'aria-label':'播放速度', onchange:e => { player.playbackRate = Number(e.target.value); }},
        [0.75, 1, 1.25, 1.5, 2].map(rate => h('option', {value:rate, selected:player.playbackRate === rate}, rate+'×')))) : null,
    transcriptDrawer(transcript, player))));
}

function transcriptDrawer(transcript, player) {
  const rows = h('div', {class:'ex'});
  const result = h('p', {class:'transcript-count', role:'status'});
  const search = h('input', {type:'search', id:'transcriptSearch', 'aria-label':'搜索转录原文', placeholder:'搜索转录原文', value:S.transcriptQuery,
    oninput:e => { S.transcriptQuery = e.target.value; filter(); }});
  function filter() {
    const query = S.transcriptQuery.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows.children) {
      row.hidden = !!query && !row.lastElementChild.textContent.toLocaleLowerCase().includes(query);
      if (!row.hidden) visible++;
    }
    result.textContent = query ? (visible ? '找到 '+visible+' 段原话' : '没有找到这句话，试试更短的关键词。') : '';
  }
  for (const line of transcript) {
    rows.append(h('div', {class:'exl', 'data-seg':line.i, 'data-from':line.fromMs, 'data-to':line.toMs},
      player ? ts(line.fromMs) : h('span', {class:'muted'}, fmt(line.fromMs)), h('span', null, line.text)));
  }
  filter();
  return h('details', {class:'transcript-drawer', open:S.transcriptOpen,
    ontoggle:e => { if (e.target.isConnected) S.transcriptOpen = e.target.open; }},
    h('summary', null, '转录原文'), accessoryAgent && transcript.length ? h('div', {class:'transcript-tools'}, search, result) : null,
    transcript.length ? rows : h('p', {class:'empty'}, '暂无文字'));
}

function recordingDestinations(m) {
  const version = m.review.version;
  return h('section', {class:'recording-destinations', 'aria-label':'保存位置'},
    h('h3', null, '保存位置'),
    [['space','空间','原音、完整转录和确认版总结'],['memory','记忆','已确认的总结及关联原话，按录音智能体归档']].map(([key,label,description]) => {
      const saved = m.savedTo?.[version]?.[key];
      const button = h('button', {class:'btn sm', type:'button', disabled:!!saved, onclick:async () => {
        button.disabled = true;
        button.textContent = '保存中…';
        try {
          const result = await api('/api/meetings/'+m.id+'/save', {json:{destination:key, version}});
          if (S.currentId === m.id) { S.meeting = result; render(); }
        } catch (error) { toast(error.message); button.disabled = false; button.textContent = '保存到'+label; }
      }}, saved ? '已保存到'+label : '保存到'+label);
      return h('div', {class:'destination-row'}, h('div', null, h('strong', null, label), h('small', null, description)), button);
    }));
}

function importReceipt(m) {
  const receipt = m.imports?.filter(row => row.version === m.review.version).at(-1);
  if (!receipt) return null;
  return h('div', { class: 'import-receipt' }, '已导入试用星图',
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
      const content = h('div', { class: 'm-b' });
      const dialog = h('dialog', { class: 'modal', 'aria-label': '星图材料', onclose: () => dialog.remove() },
        h('div', { class: 'm-h' }, h('h2', null, '星图材料')), content,
        h('div', { class: 'm-f' }, h('button', { class: 'btn', onclick: () => dialog.close() }, '关闭')));
      $('modalRoot').append(dialog); dialog.showModal();
      api('/api/starmap/vaults/' + receipt.vaultId + '/materials/' + receipt.materialId).then(r => {
        content.append(h('b', null, r.vault.name), h('pre', { class: 'preview' }, r.content));
      }).catch(e => content.append(h('p', { class: 'err' }, e.message)));
    } }, '打开材料'));
}

// —— 导入试用星图 ——
async function openImport() {
  const m = S.meeting;
  let vaults;
  try { vaults = (await api('/api/starmap/vaults')).vaults; }
  catch (e) { toast(e.message); return; }
  if (S.currentId !== m.id) return;
  let selected = vaults.length === 1 ? vaults[0].id : null;
  const choices = h('div', { class: 'vault-choices' });
  const error = h('p', { class: 'err', role: 'alert' });
  const close = () => dialog.close();
  const cancel = h('button', { class: 'btn', type: 'button', onclick: close }, '取消');
  const submit = h('button', { class: 'btn pri', type: 'submit', disabled: !selected }, '确认导入');
  const draw = () => choices.replaceChildren(...vaults.map((v) => h('label', { class: 'vault-choice' },
    h('input', { type: 'radio', name: 'vault', value: v.id, checked: selected === v.id,
      onchange: () => { selected = v.id; submit.disabled = false; } }), v.name)));
  const dialog = h('dialog', { class: 'modal regen-dialog', 'aria-labelledby': 'importTitle',
    onclose: () => dialog.remove(), oncancel: (e) => { if (cancel.disabled) e.preventDefault(); },
  }, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!selected || submit.disabled) return;
    submit.disabled = cancel.disabled = true;
    choices.querySelectorAll('input').forEach((input) => { input.disabled = true; });
    error.textContent = '';
    try {
      const result = await api(`/api/meetings/${m.id}/import`, { json: { vaultId: selected } });
      close();
      if (S.currentId === m.id) await selectMeeting(m.id, { replace: true });
      toast(result.deduped ? '此版本已在选中的知识仓' : `已导入「${result.vault.name}」`);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = cancel.disabled = false;
      choices.querySelectorAll('input').forEach((input) => { input.disabled = false; });
    }
  } }, h('div', { class: 'm-h' }, h('h2', { id: 'importTitle' }, '导入试用星图')),
  h('div', { class: 'm-b' }, h('strong', null, m.title + ' · 确认版 v' + m.review.version),
    h('small', { class: 'muted' }, m.spacePath), h('p', { class: 'muted' }, vaults.length ? '选择已有知识仓' : '当前没有可用的知识仓。'), choices, error),
  h('div', { class: 'm-f' }, cancel, vaults.length ? submit : null)));
  draw();
  $('modalRoot').append(dialog);
  dialog.showModal();
}

// —— 试用空间 ——
async function renderSpace(main) {
  main.append(h('div', { class: 'head' }, h('div', null, h('h1', null, '试用空间'), h('div', { class: 'sub' }, '查阅原始录音、完整转录和总结版本。'))));
  const my = renderSeq;
  let data;
  try { data = await api('/api/space'); } catch (e) { main.append(h('div', { class: 'err' }, e.message)); return; }
  if (my !== renderSeq) return;
  const list = h('div', { class: 'card' }, h('div', { class: 'card-h' }, data.root, h('span', { class: 'x' }, `${data.meetings.length} 个文件夹`)));
  const lb = h('div', { class: 'card-b scroll' });
  list.append(lb);
  if (!data.meetings.length) lb.append(h('div', { class: 'muted' }, '还没有归档的录音。'));
  if (!S.lib.spaceId && data.meetings[0]) S.lib.spaceId = data.meetings[0].id;
  for (const f of data.meetings) {
    lb.append(h('button', { class: `libitem ${S.lib.spaceId === f.id ? 'on' : ''}`, type: 'button', onclick: () => { S.lib.spaceId = f.id; S.lib.spaceFile = null; render(); } },
      h('b', null, f.title), h('span', { class: 'muted' }, f.folder)));
  }
  const right = h('div', { class: 'card' });
  const cur = data.meetings.find((f) => f.id === S.lib.spaceId);
  if (cur) {
    const preview = h('div');
    right.append(h('div', { class: 'card-h' }, cur.title, h('span', { class: 'x' }, h('button', { class: 'btn xs', type: 'button', onclick: () => selectMeeting(cur.id) }, '打开录音'))),
      h('div', { class: 'card-b' }, h('div', { class: 'path' }, cur.path),
        h('div', { class: 'files' }, cur.files.map((fl) => h('div', { class: 'file' }, h('span', { class: 'n' }, fl.name), h('span', { class: 'muted' }, fl.bytes !== null ? `${(fl.bytes / 1024).toFixed(1)} KB` : fmtDate(fl.mtime)),
          h('button', { class: 'btn xs', type: 'button', onclick: () => { S.lib.spaceFile = fl.key; showSpaceFile(cur, fl, preview); } }, '打开')))),
        preview));
    const want = cur.files.find((x) => x.key === S.lib.spaceFile) || cur.files.find((x) => x.key === 'minutes') || cur.files.find((x) => x.key === 'transcript');
    if (want) showSpaceFile(cur, want, preview);
  } else right.append(h('div', { class: 'card-b muted' }, '选择左侧文件夹查看文件'));
  main.append(h('div', { class: 'lib' }, list, right));
}
async function showSpaceFile(cur, fl, preview) {
  preview.replaceChildren(h('div', { class: 'lbl' }, fl.name));
  const url = `/api/space/${cur.id}/${fl.key}`;
  if (fl.key === 'audio') { preview.append(h('audio', { controls: true, preload: 'metadata', src: url })); return; }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`读取失败（${r.status}）`);
    preview.append(h('pre', { class: 'preview' }, await r.text()));
  } catch (e) { preview.append(h('div', { class: 'err' }, e.message)); }
}

// —— 试用星图 ——
async function renderStarmap(main) {
  main.append(h('div', { class: 'head' }, h('div', null, h('h1', null, '试用星图'), h('div', { class: 'sub' }, '本机独立试用仓 · 与正式星图隔离'))));
  const my = renderSeq;
  let vaults;
  try { vaults = (await api('/api/starmap/vaults')).vaults; } catch (e) { main.append(h('div', { class: 'err' }, e.message)); return; }
  if (my !== renderSeq) return;
  if (!S.lib.vaultId && vaults[0]) S.lib.vaultId = vaults[0].id;
  const left = h('div', { class: 'card' }, h('div', { class: 'card-h' }, '试用仓', h('span', { class: 'x' }, `${vaults.length} 个`)),
    h('div', { class: 'card-b scroll' },
      vaults.length ? vaults.map((v) => h('button', { class: `libitem ${S.lib.vaultId === v.id ? 'on' : ''}`, type: 'button', onclick: () => { S.lib.vaultId = v.id; S.lib.materialId = null; render(); } },
        h('b', null, v.name), h('span', { class: 'muted' }, `${v.description || '无说明'} · ${v.materials} 份材料`))) : h('div', { class: 'muted' }, '当前没有可用的试用仓。')));
  const right = h('div', { class: 'card' });
  if (S.lib.vaultId) {
    try {
      const v = await api(`/api/starmap/vaults/${S.lib.vaultId}`);
      if (my !== renderSeq) return;
      const preview = h('div');
      right.append(h('div', { class: 'card-h' }, v.name, h('span', { class: 'x' }, `试用星图 › ${v.name}`)),
        h('div', { class: 'card-b' },
          v.materials.length ? h('div', { class: 'files' }, v.materials.map((mt) => h('div', { class: 'file' },
            h('span', { class: 'n' }, mt.title, h('br'), h('span', { class: 'muted' }, `${mt.sourcePath} · ${fmtDate(mt.importedAt)} · ${mt.status}`)),
            h('button', { class: 'btn xs', type: 'button', onclick: () => { S.lib.materialId = mt.id; showMaterial(v.id, mt.id, preview); } }, '预览')))) : h('div', { class: 'muted' }, '这个仓还没有材料。在已确认的录音中点「导入试用星图」。'),
          preview));
      const mid = S.lib.materialId && v.materials.some((x) => x.id === S.lib.materialId) ? S.lib.materialId : v.materials[0]?.id;
      if (mid) showMaterial(v.id, mid, preview);
    } catch (e) { right.append(h('div', { class: 'card-b err' }, e.message)); }
  } else right.append(h('div', { class: 'card-b muted' }, '有可用的试用仓后，可以在这里查看材料。'));
  main.append(h('div', { class: 'lib' }, left, right));
}
async function showMaterial(vid, mid, preview) {
  try {
    const r = await api(`/api/starmap/vaults/${vid}/materials/${mid}`);
    preview.replaceChildren(h('div', { class: 'lbl' }, r.material.title), h('pre', { class: 'preview' }, r.content),
      h('button', { class: 'btn xs', type: 'button', onclick: () => selectMeeting(r.material.meetingId) }, '打开来源录音'));
  } catch (e) { preview.replaceChildren(h('div', { class: 'err' }, e.message)); }
}

// —— 试用记忆 ——
async function renderMemory(main) {
  main.append(h('div', { class: 'head' }, h('div', null, h('h1', null, '试用记忆'), h('div', { class: 'sub' }, '从已确认录音总结中提炼的内容，可回听原文。'))));
  const my = renderSeq;
  let data;
  try { data = await api('/api/memory'); } catch (e) { main.append(h('div', { class: 'err' }, e.message)); return; }
  if (my !== renderSeq) return;
  const groups = new Map();
  for (const e of data.entries) { if (!groups.has(e.meetingId)) groups.set(e.meetingId, []); groups.get(e.meetingId).push(e); }
  if (!groups.size) { main.append(h('div', { class: 'card' }, h('div', { class: 'card-b muted' }, '还没有试用记忆。'))); return; }
  for (const [mid, list] of [...groups.entries()].sort((a, b) => (b[1][0].recordedAt || '').localeCompare(a[1][0].recordedAt || ''))) {
    const first = list[0];
    main.append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, first.meetingTitle, h('span', { class: 'muted' }, `${fmtDate(first.recordedAt)} · 确认版 v${first.version}`),
        h('span', { class: 'x' }, h('button', { class: 'btn xs', type: 'button', onclick: () => selectMeeting(mid) }, '打开录音'), ' ',
          h('button', { class: 'btn xs ghost', type: 'button', onclick: async () => { if (!confirm('从试用记忆中移除本场全部条目？')) return; try { await api(`/api/memory/meetings/${mid}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); } } }, '移除本场记忆'))),
      h('div', { class: 'card-b' }, list.map((e) => h('div', { class: 'memrow' },
        ts(e.startMs, () => openMeetingAt(mid, e.startMs)),
        h('span', { class: `tag ${e.kind === 'decision' ? 'd' : 'a'}` }, e.kind === 'decision' ? '决定' : e.kind === 'action' ? '行动项' : '要点'),
        h('div', { class: 'grow' }, h('div', null, e.text, e.kind === 'action' ? ` · ${e.owner || '负责人未填'} · ${e.due || '期限未填'}` : ''),
          h('div', { class: 'muted' }, `原话：「${e.quote}」`), h('div', { class: 'muted' }, e.source)))))));
  }
}
async function openMeetingAt(id, ms) {
  await selectMeeting(id);
  setTimeout(() => seek(ms), 300);
}

init();
