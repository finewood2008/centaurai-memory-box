import { createExpertClient, stateLabel } from './state.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const time = value => new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });

export function mount(root, api) {
  const controller = createExpertClient(api);
  const history = el('nav', { 'aria-label': '执行历史', class: 'history' });
  const title = el('h2', {}, '开始一次处理');
  const detail = el('section', { class: 'detail', 'aria-live': 'polite' });
  const alert = el('p', { class: 'alert', role: 'alert' });
  const notice = el('p', { class: 'notice', role: 'status' });
  const input = el('textarea', { 'aria-label': '输入处理内容', placeholder: '写下需要处理的内容…', rows: '4', maxlength: '12000' });
  const submit = el('button', { type: 'submit', class: 'primary' }, '提交处理');
  const retry = el('button', { type: 'button', onclick: async () => { const r = await controller.retry(); if (r) input.value = ''; } }, '重试同一次请求');
  const refresh = el('button', { type: 'button', onclick: () => void controller.refresh() }, '刷新状态');
  const form = el('form', { class: 'composer', onsubmit: async event => { event.preventDefault(); const r = await controller.send(input.value); if (r) input.value = ''; } }, input, el('div', { class: 'actions' }, retry, submit));
  root.className = 'expert-app';
  root.replaceChildren(el('aside', { class: 'sidebar' }, el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, '象'), el('div', {}, el('h1', {}, '应用助手'), el('small', {}, '处理记录与结果'))), history),
    el('main', {}, el('header', {}, title, refresh), alert, notice, detail, form, el('p', { class: 'footnote' }, '任务由盒子处理。关闭窗口后，可重新打开查看结果。')));
  function render() {
    const s = controller.getSnapshot(), selected = s.items.find(item => item.id === s.selectedId);
    alert.textContent = s.error; alert.hidden = !s.error;
    notice.textContent = s.notice; notice.hidden = !s.notice;
    refresh.disabled = s.loading || s.busy;
    refresh.textContent = s.loading ? '正在刷新…' : '刷新状态';
    input.disabled = s.busy || Boolean(s.pending);
    if (s.pending) input.value = s.pending.text;
    submit.disabled = !s.ready || s.loading || s.busy || Boolean(s.pending);
    submit.textContent = s.busy ? '正在处理请求…' : '提交处理';
    retry.hidden = !s.pending; retry.disabled = !s.ready || s.loading || s.busy;
    title.textContent = selected ? stateLabel(selected.state) : '开始一次处理';
    history.replaceChildren(...s.items.map(item => {
      const button = el('button', { type: 'button', class: item.id === s.selectedId ? 'selected' : '', 'aria-pressed': String(item.id === s.selectedId), onclick: () => controller.select(item.id) }, el('strong', {}, item.text.slice(0, 40)), el('span', {}, stateLabel(item.state)), el('small', {}, time(item.createdAt)));
      return button;
    }));
    if (!s.items.length) history.append(el('p', { class: 'muted' }, s.loading ? '正在读取历史…' : s.ready ? '还没有处理记录。' : '历史暂不可用，请刷新。'));
    detail.replaceChildren();
    if (!selected) detail.append(el('div', { class: 'welcome' }, el('h3', {}, '把事情交给应用处理'), el('p', {}, '提交内容后，可以在左侧查看进度和历史结果。')));
    else {
      detail.append(el('section', { class: 'question' }, el('small', {}, '提交内容'), el('p', {}, selected.text)), el('section', { class: 'answer' }, el('small', {}, '处理结果'), el('p', {}, selected.result || (selected.state === 'interrupted' ? '上次执行已中断，未自动重新执行。你可以核对结果后发起新的处理。' : selected.state === 'cancelled' ? '这次处理已取消。' : selected.state === 'failed' ? '执行未完成，请检查应用服务后再发起新的处理。' : '结果尚未生成。'))));
      if (['queued', 'running'].includes(selected.state)) { const cancel = el('button', { type: 'button', onclick: () => void controller.cancel(selected.id) }, '取消这次处理'); cancel.disabled = s.busy || s.loading || !s.ready; detail.append(cancel); }
      detail.append(el('small', { class: 'muted' }, '最近更新 ' + time(selected.updatedAt)));
    }
  }
  const unsubscribe = controller.subscribe(render);
  render();
  void controller.refresh();
  const timer = setInterval(() => { if (document.visibilityState !== 'hidden' && controller.shouldPoll()) void controller.refresh(); }, 3000);
  return () => { clearInterval(timer); unsubscribe(); controller.dispose(); };
}
