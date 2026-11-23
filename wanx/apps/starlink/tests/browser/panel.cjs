// Hidden Electron smoke check against assembled assets; synthetic data, no network.
const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile, rm, copyFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const output = resolve(__dirname, '../../build/browser');
const runtime = process.env.WANX_STARLINK_TEST_RUNTIME || resolve(__dirname, '../../../personal-client/build/app');
const preview = process.env.WANX_STARLINK_UI_PREVIEW === '1';
const sample = preview || process.env.WANX_STARLINK_SAMPLE_LAYOUT === '1';
app.setPath('userData', join(output, preview ? 'preview-profile' : 'profile'));
let win;
let deadline;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, message) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (predicate(value)) return value; await delay(100); }
  throw new Error(message);
}
app.whenReady().then(async () => {
  deadline = setTimeout(() => { console.error('STARLINK_PANEL_SMOKE_TIMEOUT'); win?.destroy(); app.exit(1); }, 60000);
  await mkdir(output, { recursive: true });
  await rm(join(output, 'failure.json'), {force:true});
  await rm(join(output, 'result.json'), {force:true});
  const renderer = join(runtime, 'local-ui/renderer');
  await copyFile(join(__dirname, 'panel-host.js'), join(renderer, 'starlink-smoke-host.js'));
  const region = '<div id="starlink-panel-region" class="starlink-panel-region"></div>';
  const layout = `
    <link rel="stylesheet" href="styles.css">
    <link rel="stylesheet" href="data.css">
    <link rel="stylesheet" href="personal-layout.css">
    <link rel="stylesheet" href="material-theme.css">
    <style>body{margin:0;background:#faf7f2;font:13px system-ui}</style>
    <div class="app-layout starlink-layout"><header class="topbar">星图</header><header class="wanx-section-banner starlink-banner" data-section="starlink">
      <div class="personal-module-title"><span class="personal-module-mark" aria-hidden="true"></span>
      <div><h2>知识星图 <span class="wanx-section-english">Starlink</span></h2><p>在图谱中探索资料里的实体与关系，沿着关联追溯原文。</p></div></div>

    </header><div class="page-content data-page-content">${region}</div></div>`;
  await writeFile(join(renderer, 'starlink-smoke.html'), `<!doctype html><html lang="zh" data-sample="${sample}"><meta charset="utf-8"><title>星图 · 界面结构预览</title><body data-wanx-surface="main">${layout}<script src="data-view.js"></script><script src="starlink-smoke-host.js"></script></html>`);
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling:false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({cancel:true}));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Content-Security-Policy')) errors.push(message); });
  win.webContents.on('will-frame-navigate', event => {
    const expected = [join(runtime, 'local-ui/starlink/ui/index.html'), join(runtime, 'local-ui/starlink/ui/workbench/index.html')].map(file => pathToFileURL(file).href);
    if (event.isMainFrame || !expected.includes(event.url.split('?')[0])) event.preventDefault();
  });
  await win.loadFile(join(renderer, 'starlink-smoke.html'));
  const frame = await until(() => win.webContents.mainFrame.frames, frames => frames.some(frame => frame.url.endsWith('/starlink/ui/index.html')), 'panel document missing')
    .then(frames => frames.find(frame => frame.url.endsWith('/starlink/ui/index.html')));
  const js = code => win.webContents.mainFrame.frames.find(f=>f.url.endsWith('/starlink/ui/index.html')).executeJavaScript(code);
  await until(() => js('document.querySelector("#crumb-warehouse").textContent'), text => text.includes('迁移验收仓'), 'warehouse initialization failed');
  await until(() => win.webContents.executeJavaScript('window.fixtureCalls.some(call=>call.action==="launch-target-applied")'), Boolean, 'initial warehouse navigation did not settle');
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.find(call=>call.action==="launch-target-applied").input.ok'), true);
  assert.equal(await js('document.querySelector("#view-graph").hidden'),false);
  if (!preview) {
    await js('document.querySelector("#starlink-directory-entry").click()');
    await until(() => js('!document.querySelector("#view-warehouses").hidden'), Boolean, 'project directory did not open');
    await js('document.querySelector("#warehouse-directory [data-warehouse-id=fixture][data-warehouse-view=graph]").click()');
    await until(() => js('!document.querySelector("#view-graph").hidden'), Boolean, 'opening a project should show the graph');
    await js('document.querySelector(".starlink-rail [data-view=overview]").click()');
    await until(() => js('!document.querySelector("#view-overview").hidden'), Boolean, 'project overview did not open');
    await js('document.querySelector("#crumb-warehouse").click();document.querySelector("#warehouse-picker [data-warehouse-id=second]").click()');
    await until(() => js('!document.querySelector("#view-graph").hidden && document.querySelector("#crumb-warehouse").textContent === "第二验收仓"'), Boolean, 'switching projects should show the new graph');
    await js('document.querySelector("#crumb-warehouse").click();document.querySelector("#warehouse-picker [data-warehouse-id=fixture]").click()');
    await until(() => js('!document.querySelector("#view-graph").hidden && document.querySelector("#crumb-warehouse").textContent === "迁移验收仓"'), Boolean, 'initial graph after project switch');
  }
  if (preview) {
    clearTimeout(deadline);
    app.on('window-all-closed', () => app.quit());
    win.show();
    win.focus();
    return;
  }
  const layouts = [];
  for (const [width, height, zoom] of [[1920, 1080, 1], [1280, 800, 1], [1000, 680, 1], [1920, 1080, 0.8], [1280, 800, 1.25], [1280, 800, 1.5], [1280, 900, 1]]) {
    win.setContentSize(width, height); win.webContents.setZoomFactor(zoom);
    // ResizeObserver positions the retained iframe on the next layout cycle.
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const geometry = await until(() => win.webContents.executeJavaScript(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}; };
      return {viewport:{width:document.body.clientWidth,height:innerHeight}, region:rect('#starlink-panel-region'), overlay:rect('.starlink-panel-overlay'), banner:rect('.starlink-banner'), frame:rect('.starlink-panel-overlay iframe')};
    })()`), value => Math.abs(value.viewport.height - height / zoom) < 2 && ['x','y','width','height'].every(key => Math.abs(value.overlay[key] - value.region[key]) < 2), `iframe did not settle after resizing to ${width}x${height} at zoom ${zoom}`);
    const label = JSON.stringify({width,height,zoom,geometry});
    assert.ok(Math.abs(geometry.region.width - geometry.banner.width) < 3, `panel must fill the width below the banner: ${label}`);
    assert.ok(Math.abs(geometry.region.x - geometry.banner.x) < 2, `panel must align with the banner: ${label}`);
    assert.ok(geometry.region.y >= geometry.banner.bottom, `panel must sit below the banner: ${label}`);
    assert.ok(Math.abs(geometry.region.bottom - geometry.viewport.height + 15) < 2, `panel must fill the remaining height: ${label}`);
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(geometry.overlay[key] - geometry.region[key]) < 2, `iframe overlay must follow resized panel: ${label}`);
    assert.ok(Math.abs(geometry.frame.width - geometry.region.width) < 2 && Math.abs(geometry.frame.height - geometry.region.height) < 2, `iframe must fill the overlay: ${label}`);
    assert.equal(frame.detached, false);
    layouts.push({width,height,zoom,geometry});
  }
  assert.equal(await js('Boolean(window.semantica)'), true);
  assert.equal(await js('Boolean(window.wanxClient)'), false);
  assert.equal(await js('document.querySelectorAll(".nav-item[data-view=skills],.nav-item[data-view=data],.nav-item[data-view=releases]").length'), 0);
  await js('document.querySelector("#starlink-directory-entry").click()');
  await until(() => js('Boolean(document.querySelector("[data-warehouse-id=fixture][data-warehouse-view=sensitive]:enabled"))'), Boolean, 'warehouse delivery entry missing');
  assert.equal(await js('document.querySelector("[data-warehouse-id=fixture][data-warehouse-view=sensitive]").textContent'), '脱敏规则');
  await js('document.querySelector("[data-warehouse-id=fixture][data-warehouse-view=sensitive]").click()');
  assert.equal(await js('document.querySelector("#page-title").textContent'), '脱敏规则');
  await js('document.querySelector(".nav-item[data-view=graph]").click()');
  const beforeRulesEntry = await win.webContents.executeJavaScript('window.fixtureCalls.length');
  await js('document.querySelector("#starlink-browse [data-view=sensitive]").click()');
  assert.equal(await js('document.querySelector("#starlink-browse [aria-current=page]").dataset.view'), 'sensitive');
  assert.equal(await js('document.querySelector("#crumb-current").textContent'), '脱敏规则');
  const rulesPage = code => js(`(() => {
    const frame = document.querySelector('iframe.integrated-workbench');
    const doc = frame?.contentDocument;
    if (!doc) return null;
    const button = (label, parent = doc) => [...parent.querySelectorAll('button')].find(el => el.textContent.trim() === label);
    const input = (el, value) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
      el.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
    };
    return (${code});
  })()`);
  await until(() => rulesPage('Boolean(button("新增自定义规则"))'), Boolean, 'sensitive settings did not load');
  const rulesRequests = await win.webContents.executeJavaScript(`window.fixtureCalls.slice(${beforeRulesEntry}).filter(({action, input}) =>
    action === 'workbench-request' && input.method === 'GET' && input.url.startsWith('/api/sensitive/settings'))`);
  assert.ok(rulesRequests.length && rulesRequests.every(({input}) => input.warehouseId === 'fixture'));
  assert.equal(await rulesPage('doc.querySelector("#delivery-status-title").textContent'), '当前交付状态');
  assert.equal(await rulesPage('doc.querySelector("#delivery-preview-title").textContent'), '样文测试');
  await rulesPage('button("新增自定义规则").click()');
  await until(() => rulesPage('Boolean(doc.querySelector(".sensitive-editor input"))'), Boolean, 'rule editor did not open');
  await rulesPage('input(doc.querySelector(".sensitive-editor input"), "验收项目")');
  await rulesPage('input(doc.querySelector(".sensitive-editor textarea"), "识别合成材料中的完整项目名称")');
  await rulesPage('input(doc.querySelectorAll(".sensitive-editor textarea")[1], "验收项目")');
  await win.webContents.executeJavaScript('window.fixturePauseSensitiveSave = true');
  await rulesPage('button("保存脱敏设置", doc.querySelector(".sensitive-editor")).click()');
  await until(() => win.webContents.executeJavaScript('typeof window.fixtureReleaseSensitiveSave === "function"'), Boolean, 'rule save did not start');
  assert.equal(await rulesPage('doc.querySelector(".sensitive-editor input").matches(":disabled") && button("新增自定义规则").disabled'), true);
  await win.webContents.executeJavaScript('window.fixturePauseSensitiveSave = false; window.fixtureReleaseSensitiveSave()');
  await until(() => rulesPage('!doc.querySelector(".sensitive-editor") && doc.querySelector(".sensitive-custom-list").textContent.includes("验收项目")'), Boolean, 'custom rule was not saved');
  await rulesPage('input(doc.querySelector("textarea[aria-label=脱敏测试文本]"), "样例：验收项目")');
  await rulesPage('button("测试脱敏效果").click()');
  await until(() => rulesPage('doc.querySelector(".sensitive-preview [role=status]")?.textContent'), value => /已脱敏.*样例：\[已脱敏\]/s.test(value), 'preview did not use the saved rule');
  const protectionWindow = win.getContentSize();
  win.setContentSize(1440, 1080);
  await delay(180);
  await writeFile(join(output, 'delivery-protection.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(...protectionWindow);
  await win.webContents.executeJavaScript(`(() => {
    const current = window.fixtureSensitivePolicies.get('fixture');
    window.fixtureSensitivePolicies.set('fixture', { ...current, revision: current.revision + 1 });
  })()`);
  await until(() => rulesPage('!doc.querySelector(".sensitive-preview [role=status]")'), Boolean, 'preview remained visible after the saved revision changed');
  await js('document.querySelector(".nav-item[data-view=graph]").click()');
  assert.equal(await js('document.querySelector(".nav-item[aria-current=page]").dataset.view'), 'graph');
  assert.equal(await js('document.querySelector("#starlink-directory-entry").disabled'), false);
  for (const width of [1440, 1100, 850, 760]) {
    const wide = width >= 1100;
    win.setContentSize(width, wide ? 900 : 760);
    await until(() => js(`parent.innerWidth === ${width} && innerWidth === Math.round(parent.document.querySelector("#starlink-panel-region").getBoundingClientRect().width)`), Boolean, 'graph viewport did not resize');
    const banner = await win.webContents.executeJavaScript(`(() => {
      const starlink = document.querySelector(".starlink-banner");
      const reference = starlink.cloneNode(true);
      reference.classList.remove("starlink-banner");
      reference.dataset.section = "memory";
      reference.style.position = "absolute";
      reference.style.visibility = "hidden";
      reference.style.width = starlink.offsetWidth + "px";
      document.body.append(reference);
      const area = document.querySelector(".data-page-content").getBoundingClientRect();
      const header = starlink.getBoundingClientRect();
      const result = {
        sameMinHeight: getComputedStyle(starlink).minHeight === getComputedStyle(reference).minHeight,
        sameHeight: starlink.offsetHeight === reference.offsetHeight,
        sameIconSize: starlink.querySelector(".personal-module-mark").offsetHeight === reference.querySelector(".personal-module-mark").offsetHeight,
        subtitleVisible: getComputedStyle(starlink.querySelector(".personal-module-title p")).display !== "none",
        aligned: Math.abs(area.left - header.left) < 1 && Math.abs(area.right - header.right) < 1
      };
      reference.remove();
      return result;
    })()`);
    assert.deepEqual(banner, { sameMinHeight: true, sameHeight: true, sameIconSize: true, subtitleVisible: true, aligned: true });
    await until(() => js('getComputedStyle(document.querySelector("#starlink-rail")).visibility'),
      value => value === (width > 900 ? 'visible' : 'hidden'), 'rail did not settle');
    const layout = await js(`(() => {
      const graph = document.querySelector("#graph-space").getBoundingClientRect();
      const main = document.querySelector(".page-scroll").getBoundingClientRect();
      const rail = document.querySelector("#starlink-rail");
      const current = rail.querySelector("[aria-current=page]");
      return { ratio: graph.width * graph.height / (main.width * main.height),
        railVisible: getComputedStyle(rail).visibility === "visible",
        railWidth: rail.offsetWidth,
        navGroups: Array.from(rail.querySelectorAll(".nav-group-label"), label => label.textContent),
        managementAlwaysOpen: rail.querySelector('nav[aria-label="系统选项"]').closest("details") === null,
        current: current?.dataset.view,
        inspector: document.querySelector(".graph-inspector").hidden,
        filters: document.querySelector(".graph-filter-menu").open };
    })()`);
    assert.ok(layout.ratio >= (width === 1440 ? .69 : .63), JSON.stringify(layout));
    assert.equal(layout.railVisible, width > 900);
    if (layout.railVisible) assert.ok(layout.railWidth >= 182 && layout.railWidth <= 210, JSON.stringify(layout));
    assert.deepEqual(layout.navGroups, ['当前本体', '系统选项']);
    assert.equal(layout.managementAlwaysOpen, true);
    assert.equal(layout.current, 'graph');
    assert.equal(layout.inspector, true);
    assert.equal(layout.filters, false);
    await writeFile(join(output, `graph-${width}.png`), (await win.webContents.capturePage()).toPNG());
    if (width !== 760) {
      await js('document.querySelector(".graph-node[data-node=project]").dispatchEvent(new MouseEvent("click", {bubbles:true}))');
      const selected = await js(`(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const graph = rect(".network-panel");
        const details = rect(".graph-inspector");
        const controls = rect(".graph-controls");
        return {
          sideBySide: details.width === 300 && graph.right === details.left && graph.top === details.top,
          stacked: graph.bottom === details.top && graph.width === details.width,
          fullWidthControls: controls.width === rect(".network-layout").width - 2
        };
      })()`);
      assert.deepEqual(selected, { sideBySide: wide, stacked: !wide, fullWidthControls: true }, `selected graph at ${width}px`);
      if (width === 1100) await writeFile(join(output, 'graph-1100-inspector.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("[data-action=close-graph-details]").click()');
      assert.equal(await js(`(() => {
        const graph = document.querySelector(".network-panel");
        return document.querySelector(".graph-inspector").hidden
          && graph.getBoundingClientRect().width === document.querySelector(".graph-controls").getBoundingClientRect().width
          && document.querySelector(".graph-node.selected")?.dataset.node === "project";
      })()`), true, `closed graph at ${width}px`);
      await js('document.querySelector("#graph-focus-back").click()');
    }
  }
  assert.equal(await js(`(() => {
    const toggle = [...document.querySelectorAll(".mobile-toggle")].find(button => button.getClientRects().length);
    const rect = toggle.getBoundingClientRect();
    return rect.width > 0 && toggle.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })()`), true);
  await js('[...document.querySelectorAll(".mobile-toggle")].find(button => button.getClientRects().length).click()');
  assert.equal(await js('[...document.querySelectorAll(".mobile-toggle")].find(button => button.getClientRects().length).getAttribute("aria-expanded")'), 'true');
  await js('document.querySelector(".starlink-rail [data-view=graph]").click()');
  assert.equal(await js('[...document.querySelectorAll(".mobile-toggle")].find(button => button.getClientRects().length).getAttribute("aria-expanded")'), 'false');
  assert.equal(await js('document.querySelectorAll("#graph-scene .node-star-glow").length'), 0);
  assert.equal(await js('document.querySelector("#graph-filters").closest("details") === null'), true);
  const enhancedFilters = await js('!document.querySelector("#graph-exact-type").hidden');
  const selectGraphType = type => js(enhancedFilters ? `{
    const select = document.querySelector("#graph-exact-type-select");
    select.value = "${type}";
    select.dispatchEvent(new Event("change", {bubbles:true}));
  }` : `document.querySelector("#graph-filters [data-type=${type}]").click(); void 0`);
  await selectGraphType('PROJECT');
  assert.equal(await js('document.querySelector("#graph-scene .graph-node[data-node=person]")'), null);
  await selectGraphType('all');
  await js(`(() => {
    const search = document.querySelector("#graph-query");
    search.focus(); search.value="测试项目"; search.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  await until(() => js('document.querySelector("#graph-suggestions:not([hidden]) button")?.textContent || ""'), text => text.includes('测试项目'), 'graph entity suggestion missing');
  await js('document.querySelector("#graph-query").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await until(() => js('document.querySelector(".graph-inspector:not([hidden]) h2")?.textContent || ""'), text => text.includes('测试项目'), 'graph inspector did not open');
  assert.equal(await js('document.querySelector("#graph-query").value'), '测试项目');
  assert.equal(await js(`(() => {
    const graph = document.querySelector("#graph-space").getBoundingClientRect();
    const details = document.querySelector(".graph-inspector").getBoundingClientRect();
    return graph.bottom <= details.top;
  })()`), true);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(join(output, 'graph-narrow-inspector.png'), (await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#graph-details [data-edge=relation]").click()');
  await js('document.querySelector("#graph-details [data-source=doc]").click()');
  await until(() => js('document.querySelector("#source-dialog").open && document.querySelector("#source-body").textContent.includes("正文范围 20–25")'), Boolean, 'graph relation source did not open at the cited location');
  assert.match(await js('document.querySelector("#source-body").textContent'), /第 2 页.*引用版正文/s);
  assert.deepEqual(await win.webContents.executeJavaScript('window.fixtureCalls.filter(c => c.action === "document-text").at(-1).input'),
    { id: 'doc', versionId: 'cited-version', start: 20, warehouseId: 'fixture' });
  assert.doesNotMatch(await js('document.querySelector("#source-body").textContent'), /校对前正文/);
  await js('document.querySelector("#source-body [data-action=source-previous]").click()');
  await until(() => js('document.querySelector("#source-body").textContent.includes("引用版上一段")'), Boolean, 'graph context did not use the cited version');
  await js('document.querySelector("#source-dialog").close()');
  await win.webContents.executeJavaScript(`window.fixtureOverrides["document-text"]=({id,start})=>({ok:true,value:{
    document_id:id,version_id:"new-version",start,end:25,total_chars:25,text:"更新后的正文"
  }});void 0`);
  await js('document.querySelector("#graph-details [data-source=doc]").click()');
  await until(() => js('document.querySelector("#source-body").textContent'), text => text.includes('无法核对引用的正文版本'), 'stale evidence opened a newer source');
  assert.doesNotMatch(await js('document.querySelector("#source-body").textContent'), /更新后的正文/);
  await js('document.querySelector("#source-dialog").close()');
  await win.webContents.executeJavaScript('delete window.fixtureOverrides["document-text"];void 0');
  assert.match(await js('document.querySelector("#graph-inspector-trail").textContent'), /关系来源/);
  await js('document.querySelector("#graph-inspector-trail [data-action=graph-entity-details]").click()');
  await js('document.querySelector("[data-action=close-graph-details]").click()');
  assert.equal(await js('document.querySelector(".graph-inspector").hidden'), true);
  assert.equal(await js('document.querySelector(".graph-node.selected")?.dataset.node'), 'project');
  await js('document.querySelector("#graph-focus-back").click()');
  assert.equal(await js('document.querySelector(".graph-node.selected")'), null);
  assert.equal(await js('document.querySelector("#graph-query").value'), '测试项目');
  await js(`(() => {
    const search = document.querySelector("#graph-query");
    search.value="确定不存在的实体"; search.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  assert.equal(await js('document.querySelector("#graph-empty-title").textContent'), '没有找到相关实体');
  assert.equal(await js(`(() => {
    const button = document.querySelector("#graph-empty-action");
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })()`), true);
  await js('document.querySelector("#graph-empty-action").click()');
  assert.equal(await js('document.querySelector("#graph-empty").hidden'), true);
  await win.webContents.executeJavaScript(`(() => {
    const material = {id:'doc',status:'ready',original_name:'引用测试.txt',segment_count:1};
    const version = () => window.fixtureSourceVersion || 'current-version';
    const workflow = () => ({document_id:material.id,document:material,document_version_id:version(),
      label:'待核对正文',stage:'source_ready',tasks:[],conversations:[],actions:{start_dialogue:{allowed:false}},preparation:{ready:false,source_review:{status:'pending'},indexing:{status:'not_started',document_version_id:version()}}});
    Object.assign(window.fixtureOverrides,{
      document:()=>({ok:true,value:{document:material,version:{id:version(),version_number:2},
        segments:[{id:'current-segment',text:'资料库当前正文'}]}}),
      'conversation-material-workflows':()=>({ok:true,value:{items:[workflow()],total:1}}),
      'conversation-material-workflow':()=>({ok:true,value:workflow()})
    });
  })()`);
  await js('document.querySelector("#graph-query").value="";document.querySelector("#graph-query").dispatchEvent(new Event("input",{bubbles:true}))');
  const openGraphSource = async () => {
    await js('document.querySelector("#graph-svg [data-edge=relation], #graph-space [data-edge=relation]")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))');
    if (!await js('Boolean(document.querySelector("#graph-details [data-source=doc]"))')) {
      await js('document.querySelector("#graph-space [data-node=project]")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))');
      await js('document.querySelector("#graph-details [data-edge=relation]")?.click()');
    }
    await js('document.querySelector("#graph-details [data-source=doc]").click()');
    await until(() => js('Boolean(document.querySelector("[data-action=open-source-reader]"))'), Boolean, 'source handoff action missing');
  };
  await openGraphSource();
  assert.match(await js('document.querySelector("[data-action=open-source-reader]").textContent'), /当前版本/);
  await js('document.querySelector("[data-action=open-source-reader]").click()');
  await until(() => js('document.querySelector(".mw-reader-source")?.textContent'),
    text => text?.includes('引用使用历史版本') && text.includes('资料库当前正文'), 'historical source was mapped onto a current document');
  assert.equal(await js('Boolean(document.querySelector(".mw-reader-source [data-reader-match]"))'), false);
  assert.equal(await js('Boolean(document.querySelector("#view-conversation #cv-message, #view-conversation .conversation-composer, #view-conversation [data-cv=library-start]"))'), false);
  await js('document.querySelector(".nav-item[data-view=graph]").click()');
  await win.webContents.executeJavaScript('window.fixtureSourceVersion="cited-version";void 0');
  await openGraphSource();
  await js('document.querySelector("[data-action=open-source-reader]").click()');
  await until(() => js('document.querySelector(".mw-reader-source mark")?.textContent'), text => text === '引用版正文', 'current citation lost its range in the reader');
  assert.equal(await js('document.querySelector(".page-scroll").scrollTop'), 0);
  await delay(180);
  await writeFile(join(output, 'reader-graph-citation.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(await js('document.querySelector("#page-ontology-suggestions")'), null);
  await win.webContents.executeJavaScript('window.fixtureOntologyTask="running";void 0');
  await until(() => js('document.querySelector(".mw-reader-tools")?.textContent'), value => value?.includes('正在构建本体建议'), 'background ontology status not visible');
  await win.webContents.executeJavaScript('window.fixtureOntologyTask="completed";void 0');
  await until(() => js('document.querySelector(".mw-reader-tools")?.textContent'), value => value?.includes('核对本体建议（1）'), 'finished ontology suggestions not visible');
  await js('document.querySelector("[data-cv=import-ontology-suggestions]").click()');
  await until(() => js('document.querySelector("#mw-editor-dialog iframe")?.contentDocument?.querySelector(".ontology-suggestion blockquote")?.textContent'),
    value => value?.includes('引用版正文'), 'ontology suggestions did not preserve cited source');
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.some(x=>x.input.url?.includes("/ontology-suggestions/generate"))'),false);
  await js('document.querySelector("#mw-editor-dialog>header button").click()');
  await until(() => js('document.querySelector("#mw-editor-dialog") === null'), Boolean, 'could not return to the material');

  await win.webContents.executeJavaScript(`for (const key of ['document','conversation-material-workflow','conversation-material-workflows']) delete window.fixtureOverrides[key];void 0`);
  await js('document.querySelector(".nav-item[data-view=graph]").click()');
  win.setContentSize(1280, 900);
  await js('document.querySelector("#starlink-directory-entry").click()');
  assert.equal(await js('document.querySelectorAll("#warehouse-directory .warehouse-directory-card:not([hidden])").length'), 2);
  assert.equal(await js('document.querySelector("#page-primary").hidden'), true);
  await js(`(() => {
    const field = document.querySelector("#warehouse-query");
    field.value = "第二验收仓"; field.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  assert.equal(await js('document.querySelectorAll("#warehouse-directory .warehouse-directory-card:not([hidden])").length'), 1);
  await js('document.querySelector("#warehouse-query").value=""; document.querySelector("#warehouse-query").dispatchEvent(new Event("input",{bubbles:true}));');
  await delay(130);
  await writeFile(join(output, 'subpage-warehouses.png'), (await win.webContents.capturePage()).toPNG());

  await js('document.querySelector(".starlink-rail [data-view=conversation]").click(); document.querySelector("#page-tasks").click()');
  await until(() => js('document.querySelector(".task-error")?.textContent'), text => text === '合成失败原因', 'failed tasks missing');
  assert.match(await js('document.querySelector(".task-progress").textContent'), /失败.*2.*5/);
  assert.equal(await js('document.querySelector(".task-model-details").open'), false);
  assert.ok(await js('Boolean(document.querySelector(".task-end [data-retry]"))'));
  await writeFile(join(output, 'subpage-tasks.png'), (await win.webContents.capturePage()).toPNG());

  const modelSettingsStart = await win.webContents.executeJavaScript('window.fixtureCalls.length');
  await js('document.querySelector(".starlink-rail [data-view=models]").click()');
  await until(() => js('document.querySelectorAll("#model-stages .model-stage").length'), count => count === 5, 'configured roles missing');
  assert.match(await js('[...document.querySelectorAll("#model-stages .model-stage")].find(stage=>stage.querySelector("h3").textContent==="检索向量").textContent'), /未经脱敏的正文片段.*检索词/);
  assert.match(await js('document.querySelector("#import-model-summary").textContent'), /未经脱敏的正文片段.*检索词/);
  assert.equal(await js('document.querySelector("#model-scope, #model-inherit, #view-models #model-reprocess-all")'), null);
  assert.equal(await js('document.querySelector("#model-roles-title").textContent'), '共用处理模型');
  assert.match(await js('document.querySelector("#model-source").textContent'), /跟随万象底座默认模型/);
  assert.equal(await js('Boolean(document.querySelector("#view-tasks #model-reprocess-all"))'), true);
  const modelSettingsReads = await win.webContents.executeJavaScript(`window.fixtureCalls.slice(${modelSettingsStart})
    .filter(({action}) => ['processing', 'model-catalog'].includes(action))`);
  assert.deepEqual(modelSettingsReads.map(({action}) => action), ['processing', 'model-catalog']);
  assert.ok(modelSettingsReads.every(({input}) => input.scope === 'default' && input.warehouseId === null));
  await delay(130);
  await writeFile(join(output, 'subpage-models.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript('window.fixtureOverrides["conversation-material-workflows"]=()=>({ok:false,code:"SEMANTICA_CONNECTION_FAILED",status:503});void 0');
  await js('document.querySelector(".starlink-rail [data-view=conversation]").click()');
  await until(() => js('Boolean(document.querySelector(".mw-library [data-cv=material-refresh]"))'), Boolean, 'material load failure was presented as empty');
  assert.match(await js('document.querySelector(".mw-list-empty").textContent'), /暂不可读/);
  await writeFile(join(output, 'subpage-material-failure.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('delete window.fixtureOverrides["conversation-material-workflows"]');
  await js('document.querySelector(".mw-library [data-cv=material-refresh]").click()');
  await until(() => js('!document.querySelector(".mw-library [data-cv=material-refresh]") && Boolean(document.querySelector("#page-primary[data-action=import]:enabled:not([hidden])"))'), Boolean, 'material retry did not restore the import action');
  assert.equal(await js('document.querySelector(".material-load-failure")'), null);
  assert.equal(await js('document.querySelector("#page-title").textContent'), '资料库');
  assert.equal(await js('document.querySelectorAll(".mw-library [data-cv=material-add]").length'), 0);
  await writeFile(join(output, 'subpage-material.png'), (await win.webContents.capturePage()).toPNG());

  assert.deepEqual(await js('[...document.querySelectorAll("#starlink-browse [data-view]")].map(button => button.textContent.trim())'), ['概览','星图','资料库','本体','数据列表','脱敏规则']);
  assert.equal(await js('Boolean(document.querySelector("#view-search"))'), false);
  await win.webContents.executeJavaScript(`(() => {
    const material = { id: 'body-fixture', original_name: '源文验收.html', status: 'ready', document_format: 'html', segment_count: 24 };
    const version = { id: 'body-v1', version_number: 1, metadata: {} };
    const segment = { id: 'body-segment', kind: 'text', text: '待校对的合成正文', source_locator: {} };
    const detail = { document: material, version, segments: [segment, ...Array.from({length: 23}, (_, index) =>
      ({...segment, id: 'body-segment-' + index, text: '正文片段 ' + (index + 2)}))] };
    const result = value => ({ ok: true, value });
    let processing, indexFailed=false;
    const workflow = () => ({ document_id: material.id, document: material, document_version_id: version.id,
      label: '待处理', workflow_revision: processing ? 2 : 1, latest_transition_id: processing?.receipt.transition_id,
      tasks: [], conversations: [], actions: { start_dialogue: { allowed: true }, process_source: { allowed: !processing } },
      preparation: { ready: processing?.current.stage === 'published',
        source_review: processing ? {status:'confirmed', confirmed_version_id:version.id, confirmation_id:'body-confirmed'} : {status:'unconfirmed'},
        indexing: {status: processing?.current.stage === 'published' ? 'ready' : indexFailed ? 'failed' : processing ? 'queued' : 'not_started',
          document_version_id: version.id, retryable:indexFailed} } });
    window.fixtureFailBodyIndex = () => { indexFailed=true; };
    window.fixturePublishBody = () => {
      processing.current = {stage:'published',is_current:true,publication_performed:true,published_run_id:'body-run'};
      detail.processing = {sensitive_status:'running'};
    };
    window.fixtureCompleteDetection = () => { detail.processing = {sensitive_status:'completed'}; };
    Object.assign(window.fixtureOverrides, {
      'conversation-material-workflows': () => result({ items: [workflow()], total: 1 }),
      'conversation-material-workflow': () => result(workflow()),
      'conversation-index-retry': input => {
        if (!indexFailed || input.confirmationId!=='body-confirmed' || input.documentVersionId!==version.id)
          return {ok:false,status:409,code:'SOURCE_VERSION_CONFLICT'};
        indexFailed=false;
        return result({receipt:{document_id:material.id,document_version_id:version.id,operation_id:input.operationId,
          confirmation_id:'body-confirmed',extraction_started:false,publication_performed:false}});
      },
      'conversation-processing-start': input => {
        if (input.documentVersionId !== version.id || input.workflowRevision !== 1 || input.confirmed !== true)
          return {ok:false, status:409, code:'SOURCE_VERSION_CONFLICT'};
        processing = {receipt:{operation_id:input.operationId,document_id:material.id,document_version_id:version.id,
          transition_id:'body-process',target_mode:'automatic',job_id:'body-extraction',waits_for_source_index:true},
          current:{stage:'queued',is_current:true}};
        return result(processing);
      },
      'conversation-processing-status': () => result(processing),
      'conversation-published-run': () => result({
        run:{id:'body-run',document_id:material.id,document_version_id:version.id,status:'published'},
        candidates:Array.from({length:20},(_,i)=>({id:'fact-'+i,kind:'entity',status:'published',payload:{name:'发布条目 '+i,type:'CONCEPT'}})),
      }),
      document: () => result(structuredClone(detail)),
      'workbench-request': input => {
        if (input.url === '/api/documents/body-fixture/content' && input.method === 'PATCH') {
          const body = JSON.parse(input.body);
          if (body.base_version_id !== version.id) return { ok: false, status: 409, code: 'SOURCE_VERSION_CONFLICT' };
          version.id = 'body-v3'; version.version_number = 3;
          segment.text = body.segments[0].text;
          return result(detail);
        }
        if (input.url.startsWith('/api/documents/body-fixture?')) return result(window.fixtureBodyStale
          ? { ...detail, version: { ...version, id: 'body-v2', version_number: 2 } } : detail);
        return result({ items: [], total: 0, document_coverage: [] });
      },
    });
  })()`);
  await js('document.querySelector("[data-view=tasks]").click(); document.querySelector("[data-view=conversation]").click()');
  const bodyEditButton = '.mw-source-heading h3 + [data-cv=import-edit-source]:enabled';
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(bodyEditButton)}))`), Boolean, 'body edit entry missing beside the heading');
  const editBody = () => js(`document.querySelector(${JSON.stringify(bodyEditButton)}).click()`);
  const cancelBody = () => js('document.querySelector("[data-cv=import-source-cancel]").click()');
  await win.webContents.executeJavaScript('window.fixtureBodyStale=true');
  await editBody();
  await until(() => js('document.querySelector(".mw-source-edit-toolbar [role=alert]")?.textContent.includes("材料正文已更新")'), Boolean, 'body editor did not reject a changed version');
  assert.equal(await js('Boolean(document.querySelector(".mw-source-edit textarea"))'), false);
  await cancelBody();
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(bodyEditButton)}))`), Boolean, 'material did not return after a version conflict');
  await win.webContents.executeJavaScript('window.fixtureBodyStale=false');
  await editBody();
  const bodyField = '.mw-source-edit textarea[data-inline-source="0"]';
  const awaitBody = () => until(() => js(`document.querySelector(${JSON.stringify(bodyField)})?.value`), value => value === '待校对的合成正文', 'edit entry did not start inline correction');
  await awaitBody();
  assert.equal(await js('document.querySelector("#mw-editor-dialog")'), null);
  const bodyWindowSize = win.getContentSize();
  win.setContentSize(1084, 841);
  assert.equal(await js(`(() => {
    const panel = document.querySelector('.mw-review-content');
    panel.scrollTop = 360;
    const toolbar = document.querySelector('.mw-source-edit-toolbar');
    const bounds = toolbar.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + 8, bounds.top + bounds.height / 2);
    return getComputedStyle(toolbar).backgroundColor.startsWith('rgb(') &&
      panel.scrollTop > 0 && bounds.bottom <= panel.getBoundingClientRect().top && toolbar.contains(hit);
  })()`), true, 'the editing toolbar must mask scrolled text and stay below the material header');
  const typeBody = text => js(`(() => {
    const area = document.querySelector(${JSON.stringify(bodyField)});
    area.value = ${JSON.stringify(text)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await typeBody('取消的校对');
  await cancelBody();
  await until(() => js('document.querySelector(".mw-import-source")?.textContent.includes("待校对的合成正文")'), Boolean, 'cancel did not return to the original preview');
  await editBody();
  await awaitBody();
  await typeBody('已经校对的合成正文');
  await js('document.querySelector("[data-cv=import-source-save]:enabled").click()');
  await until(() => js('document.querySelector(".mw-import-source")?.textContent.includes("已保存新的星图正文版本")'), Boolean, 'body edits were not saved');
  assert.match(await js('document.querySelector(".mw-source-segments").textContent'), /已经校对的合成正文/);
  const bodyRequests = await win.webContents.executeJavaScript('window.fixtureCalls.filter(call=>call.action==="workbench-request" && call.input.url.includes("body-fixture"))');
  assert.equal(bodyRequests.filter(call=>call.input.method==='PATCH').length, 1);
  assert.ok(bodyRequests.every(call=>!call.input.url.includes('/corrections')));
  assert.deepEqual(await js('[...document.querySelectorAll(".mw-import-steps strong")].map(step=>step.textContent)'), ['核对正文', '自动处理']);
  assert.equal(await js('document.querySelector("[data-cv=import-process-source]").textContent'), '确认正文并处理');
  await js('document.querySelector("[data-cv=import-process-source]:enabled").click()');
  await until(() => js('document.querySelector(".mw-import-process")?.textContent.includes("等待索引")'), Boolean, 'one click did not show the queued processing chain');
  const startRequests = await win.webContents.executeJavaScript('window.fixtureCalls.filter(call=>call.action==="conversation-processing-start")');
  assert.equal(startRequests.length, 1);
  assert.equal(startRequests[0].input.documentVersionId, 'body-v3');
  assert.equal(await js('document.querySelector(".mw-reader-progress").open'), false);
  await win.webContents.executeJavaScript('window.fixtureFailBodyIndex()');
  await until(() => js('Boolean(document.querySelector(".mw-reader-next [data-cv=import-index-retry]:enabled"))'), Boolean, 'inline retry missing after index failure');
  await js('document.querySelector(".mw-reader-next [data-cv=import-index-retry]").click()');
  await until(() => win.webContents.executeJavaScript('window.fixtureCalls.filter(c=>c.action==="conversation-index-retry").length'), n=>n===1, 'inline retry not sent');
  await until(() => js('!document.querySelector(".mw-reader-next [data-cv=import-index-retry]")'), Boolean, 'inline retry did not restore the queued state');
  await win.webContents.executeJavaScript('window.fixturePublishBody()');
  await until(() => js('document.querySelector(".mw-published-results")?.textContent.includes("已发布知识 · 20 项")'), Boolean, 'published results missing');
  assert.match(await js('document.querySelector(".mw-import-steps").textContent'), /正在脱敏检测/);
  await win.webContents.executeJavaScript('window.fixtureCompleteDetection()');
  await until(() => js('document.querySelector(".mw-import-steps")?.textContent.includes("处理完成")'), Boolean, 'processing did not finish after detection');
  assert.equal(await js(`(() => {
    const results = document.querySelector('.mw-published-results');
    const bodyButton = document.querySelector(${JSON.stringify(bodyEditButton)});
    return !results.open && results.getBoundingClientRect().height < 65 && !!bodyButton;
  })()`), true, 'a long publication must leave the editor entry visible');
  await js('document.querySelector(".mw-published-results > summary").click()');
  assert.equal(await js('document.querySelector(".mw-published-results").open'), true);
  win.setContentSize(...bodyWindowSize);
  await win.webContents.executeJavaScript(`for (const action of ['conversation-material-workflows', 'conversation-material-workflow',
    'conversation-processing-start', 'conversation-processing-status', 'conversation-published-run', 'document', 'workbench-request']) delete window.fixtureOverrides[action];
    delete window.fixturePublishBody; delete window.fixtureCompleteDetection; delete window.fixtureFailBodyIndex; delete window.fixtureOverrides['conversation-index-retry']`);

  await js('document.querySelector("[data-view=conversation]").click()');
  await js('document.querySelector("#page-primary").click()');
  await until(() => js('document.querySelector("#import-dialog").open'), Boolean, 'header import did not open the shared dialog');
  assert.equal(await js('Boolean(document.querySelector("#import-dialog #space-browser")) && !document.querySelector("#source-computer,#computer-browser,#choose-files")'), true);
  await js('document.querySelector("#import-dialog [data-close]").click()');
  await until(() => js('document.querySelector("#import-dialog").open'), open => !open, 'header import did not close cleanly');
  const openCurrentSource = () => js(`{
    const link = document.createElement("button");
    link.dataset.source = "doc";
    document.querySelector("#view-conversation").append(link);
    link.click();
    link.remove();
  }`);
  await win.webContents.executeJavaScript('window.fixtureOverrides.correct=()=>({ok:false,code:"SEMANTICA_CONNECTION_FAILED"});void 0');
  await openCurrentSource();
  await until(() => js('Boolean(document.querySelector("[data-action=edit-source]"))'), Boolean, 'source detail missing');
  await js('document.querySelector("[data-action=edit-source]").click()');
  await until(() => js('Boolean(document.querySelector("#source-body textarea"))'), Boolean, 'source correction editor missing');
  await js('document.querySelector("#source-body textarea").value="合成校对修改";document.querySelector("[data-action=save-correction]").click()');
  await until(() => win.webContents.executeJavaScript('window.fixtureCalls.filter(c=>c.action==="correct").length'), n => n === 1, 'correction request missing');
  await until(() => js('Boolean(document.querySelector("[data-action=save-correction]:not(:disabled)"))'), Boolean, 'failed correction remained locked');
  assert.equal(await js('document.querySelector("#source-body textarea").value'), '合成校对修改');
  await js('document.querySelector("[data-action=save-correction]").click()');
  await until(() => win.webContents.executeJavaScript('window.fixtureCalls.filter(c=>c.action==="correct").length'), n => n === 2, 'correction retry missing');
  const correctionIds = await win.webContents.executeJavaScript('window.fixtureCalls.filter(c=>c.action==="correct").map(c=>c.input.operationId)');
  assert.equal(correctionIds[0], correctionIds[1]);
  await until(() => js('Boolean(document.querySelector("[data-action=save-correction]:not(:disabled)"))'), Boolean, 'correction retry did not settle');
  await js('document.querySelector("#source-actions [data-close]").click()');
  await until(() => js('document.querySelector("#source-dialog").open'), open => !open, 'source dialog did not close');
  assert.deepEqual(await js('[...document.querySelectorAll("#starlink-browse [data-view=ontology], #page-rules-guide")].map(button => button.textContent.trim())'), ['本体']);
  assert.equal(await js('Boolean(document.querySelector("#ontology-actions"))'), false);
  const chooseOntology = action => action === 'published'
    ? js('document.querySelector(".starlink-rail [data-ontology-action=published]").click()')
    : ontologyJs(`[...document.querySelectorAll(".rules-workspace-header button")].find(button => ["本体修改", "查看草稿"].includes(button.textContent.trim())).click()`);
  await chooseOntology('published');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  await until(() => js('document.querySelector("#page-title").textContent'), text => text === '本体', 'ontology navigation did not complete');
  await until(() => win.webContents.mainFrame.framesInSubtree.map(f => f.url), urls => urls.some(url => url.includes('/workbench/index.html')), 'ontology workbench missing');
  await until(() => js('document.querySelector("#view-workbench iframe")?.contentDocument?.body.textContent || ""'), text => text.includes('本体'), 'ontology content did not render');
  assert.equal(await js('document.querySelector("#view-workbench iframe").contentDocument.body.textContent.includes("页面加载失败")'), false);
  const workbenchFrame = () => win.webContents.mainFrame.framesInSubtree.find(f => f.url.includes('/workbench/index.html'));
  await until(() => workbenchFrame()?.executeJavaScript('Boolean(document.querySelector(".rules-catalog-grid"))'), Boolean, 'personal ontology catalog did not render');
  const ontologyFrame = workbenchFrame();
  const ontologyJs = code => ontologyFrame.executeJavaScript(code);
  const catalogTab = label => ontologyJs(`[...document.querySelectorAll(".rules-catalog-toolbar [role=tab]")].find(button => button.textContent.startsWith("${label}")).click()`);
  const addFromCatalog = async kind => {
    await catalogTab(kind);
    await ontologyJs('document.querySelector(".rules-catalog-toolbar .primary:not(:disabled)").click()');
  };
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-toolbar .primary:not(:disabled)"))'), Boolean, 'add action did not render for the selected type');
  await addFromCatalog('实体类型');
  await until(() => ontologyJs('document.querySelector(".ontology-type-page h2")?.textContent'), heading => heading === '实体定义', 'entity list action did not open the form');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-drawer[open]"))'), false);
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.ontologyAction'), 'published');
  assert.equal(await ontologyJs('document.querySelector(".ontology-page-actions")'), null);
  await ontologyJs('window.fixtureConfirmCount=0;window.confirm=()=>{window.fixtureConfirmCount++;return false;};{const field=document.querySelector(".ontology-type-page input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,"UNSAVED_TYPE");field.dispatchEvent(new Event("input",{bubbles:true}));}void 0');
  await js('document.querySelector(".starlink-rail [data-view=graph]").click()');
  await chooseOntology('published');
  assert.equal(await js('document.querySelector("#view-workbench").hidden'), false);
  await until(() => ontologyJs('window.fixtureConfirmCount'), count => count === 1, 'switch did not guard the unapplied entry');
  assert.equal(await ontologyJs('document.querySelector(".ontology-type-page input").value'), 'UNSAVED_TYPE');
  await ontologyJs('window.confirm=()=>true');
  await chooseOntology('published');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-grid"))'), Boolean, 'confirmed switch did not reopen the rules');
  await addFromCatalog('关系类型');
  await until(() => ontologyJs('document.querySelector(".ontology-type-page h2")?.textContent'), heading => heading === '关系定义', 'relation list action did not open the form');
  assert.equal(await ontologyJs('document.querySelectorAll(".ontology-type-page .ontology-endpoints").length'), 2);
  await delay(130);
  await writeFile(join(output, 'subpage-ontology-relation.png'), (await win.webContents.capturePage()).toPNG());
  await ontologyJs('document.querySelector(".ontology-type-page footer button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-workspace-tabs"))'), Boolean, 'rule workspace did not return after closing the relation form');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".rules-assistant-page"))'), false);
  assert.equal(await ontologyJs('[...document.querySelectorAll(".rules-workspace-tabs button")].some(button => button.textContent.includes("对话"))'), false);
  await catalogTab('实体类型');
  assert.equal(await ontologyJs('[...document.querySelectorAll(".rules-catalog-detail button")].some(button => button.textContent.includes("对话"))'), false);
  assert.equal(await ontologyJs('[...document.querySelectorAll(".rules-catalog-detail button")].some(button => button.textContent.includes("手动编辑"))'), true);
  await chooseOntology('drafts');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-editor:not([hidden])"))'), Boolean, 'draft management did not open');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-tabs [aria-current=page]")?.textContent || ""'), /^本体修改$/);
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-editor table[aria-label=实体类型列表]"))'), true);
  await ontologyJs('document.querySelector(".rules-draft-tabs button:last-child").click()');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-editor table[aria-label=关系类型列表]"))'), true);
  await ontologyJs('document.querySelector(".rules-draft-tabs button:first-child").click()');
  await ontologyJs('document.querySelector(".ontology-editor .ontology-list-heading button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-type-page"))'), Boolean, 'adding directly from the draft list did not open the form');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  await ontologyJs('document.querySelector(".ontology-type-page footer button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-editor:not([hidden])"))'), Boolean, 'cancel did not return to the draft list');
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-tabs [aria-current=page]")?.textContent || ""'), /^本体修改$/);
  await chooseOntology('published');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-grid"))'), Boolean, 'published ontology did not return');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.ontologyAction'), 'published');
  await catalogTab('实体类型');
  await until(() => ontologyJs('document.querySelector(".rules-catalog-detail").textContent'), text=>/人物.*姓名.*必填/.test(text), 'entity definition did not return');
  assert.equal(await ontologyJs('document.querySelectorAll(".rules-catalog-detail").length'), 1);
  await catalogTab('关系类型');
  assert.match(await ontologyJs('document.querySelector(".rules-catalog-detail .rules-type-direction").textContent'), /人物 → 参与 → 项目/);
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-instances .rules-instance-row > button"))'), Boolean, 'published relation instance was not displayed');
  await ontologyJs('document.querySelector(".rules-instances .rules-instance-row > button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-instance-sources button"))'), Boolean, 'relation sources did not load');
  await ontologyJs('document.querySelector(".rules-instance-sources button").click()');
  await until(() => js('document.querySelector("#source-body").textContent.includes("引用版正文")'), Boolean, 'instance source did not locate the exact version and segment');
  await writeFile(join(output, 'subpage-ontology-source.png'), (await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#source-dialog").close()');
  await catalogTab('实体类型');
  await ontologyJs('const search=document.querySelector(".rules-catalog-search input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(search,"姓名");search.dispatchEvent(new Event("input",{bubbles:true}));void 0');
  await until(() => ontologyJs('document.querySelectorAll(".rules-type-list li").length'), count => count === 1, 'published rule search did not filter by property');
  await ontologyJs('[...document.querySelectorAll(".rules-workspace-version button")].find(button => button.textContent === "版本与影响").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-history-page.workbench-inline"))'), Boolean, 'version history did not open in the workspace');
  await ontologyJs('[...document.querySelectorAll(".ontology-history-page button")].find(button => button.textContent === "查看影响与更新材料").click()');
  await until(() => ontologyJs('document.querySelectorAll(".rules-material-row input").length'), n=>n===2, 'batch choices are missing');
  await ontologyJs('document.querySelectorAll(".rules-material-row input").forEach(el=>el.click()); document.querySelector(".rules-material-selection .primary").click()');
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.filter(call=>call.input.url?.endsWith("/ontology-updates/sample-schema/start")).length'),0);
  assert.equal(await ontologyJs('document.querySelectorAll(".rules-batch-confirm li").length'),2);
  await writeFile(join(output, 'subpage-ontology-batch.png'), (await win.webContents.capturePage()).toPNG());
  await ontologyJs('document.querySelector(".rules-batch-confirm .primary").click()');
  await until(() => ontologyJs('document.querySelector(".rules-material-impact").textContent'), text=>text.includes("已提交 2 份资料"), 'batch receipt did not render');
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.filter(call=>call.input.url?.endsWith("/ontology-updates/sample-schema/start")).length'),1);
  await ontologyJs('document.querySelector(".ontology-updates-drawer > header button").click()');
  await ontologyJs('document.querySelector(".ontology-history-page > header button").click()');
  await catalogTab('规则关系图');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-graph .network-canvas"))'), Boolean, 'ontology graph no longer accessible');
  assert.equal(await ontologyJs('document.querySelector("select[aria-label=展示范围]").value'), 'focus');
  await catalogTab('实体类型');
  await delay(130);
  await writeFile(join(output, 'subpage-ontology.png'), (await win.webContents.capturePage()).toPNG());
  await addFromCatalog('实体类型');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-type-page"))'), Boolean, 'add entity page did not reopen');
  await ontologyJs('const [id,label]=document.querySelectorAll(".ontology-type-page .ontology-fields input");for(const [field,value] of [[id,"NEW_TYPE"],[label,"验收实体"]]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));}void 0');
  await ontologyJs('document.querySelector(".ontology-type-page footer .primary").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-editor:not([hidden]) [data-type-name=NEW_TYPE]"))'), Boolean, 'applying a type did not show it in pending rules');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-tabs [aria-current=page]")?.textContent || ""'), /^本体修改$/);
  await ontologyJs('document.querySelector(".ontology-draft-actions .primary").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-saved-drafts .workflow-draft-row"))'), Boolean, 'saving the type did not add it to the draft list');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-history-page"))'), false);
  await delay(130);
  await writeFile(join(output, 'subpage-ontology-drafts.png'), (await win.webContents.capturePage()).toPNG());
  await chooseOntology('published');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-grid"))'), Boolean, 'published rules did not reopen after editing');
  await ontologyFrame.executeJavaScript('document.querySelector(".rules-catalog-detail button[aria-label=编辑人物]").click()');
  await until(() => ontologyFrame.executeJavaScript('Boolean(document.querySelector(".ontology-drawer input"))'), Boolean, 'type drawer missing');
  const drawerTheme = await ontologyJs('(()=>{const dialog=document.querySelector(".ontology-drawer"),r=dialog.getBoundingClientRect(),apply=dialog.querySelector(".ontology-apply"),base=document.querySelector(".ontology-draft-actions .primary");return {primary:getComputedStyle(apply).backgroundColor,base:getComputedStyle(base).backgroundColor,backdrop:getComputedStyle(dialog,"::backdrop").backgroundColor,radius:getComputedStyle(dialog).borderTopRightRadius,inside:r.top>0&&r.right<innerWidth,label:dialog.querySelector("[data-starxiaotu-term=type-id]").title,required:dialog.querySelector("[data-starxiaotu-term=required-property]").title};})()');
  assert.equal(drawerTheme.primary,drawerTheme.base);
  assert.equal(drawerTheme.primary,'rgb(166, 83, 63)');
  assert.equal(drawerTheme.radius,'12px');
  assert.ok(drawerTheme.inside);
  assert.match(drawerTheme.backdrop,/^rgba\(68, 53, 40,/);
  assert.match(drawerTheme.label,/类型标识.*PERSON/);
  assert.match(drawerTheme.required,/必填.*无法通过校验/);
  await writeFile(join(output, 'subpage-ontology-warm-drawer.png'), (await win.webContents.capturePage()).toPNG());
  await ontologyFrame.executeJavaScript('window.fixtureConfirmCount=0;window.confirm=()=>{window.fixtureConfirmCount++;return false;};const field=document.querySelector(".ontology-drawer input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,"DRAFT_TYPE");field.dispatchEvent(new Event("input",{bubbles:true}));void 0');
  await until(() => ontologyFrame.executeJavaScript('document.querySelector(".ontology-live-review").textContent'), text => text.includes('DRAFT_TYPE'), 'drawer edits not registered');
  await js('document.querySelector("#crumb-warehouse").click();document.querySelector("#warehouse-picker [data-warehouse-id=second]").click()');
  await until(() => ontologyFrame.executeJavaScript('window.fixtureConfirmCount'), n => n === 1, 'unapplied type edits did not guard warehouse switching');
  assert.equal(await js('document.querySelector("#crumb-warehouse").textContent'), '迁移验收仓');
  assert.equal(await ontologyFrame.executeJavaScript('document.querySelector(".ontology-drawer input").value'), 'DRAFT_TYPE');
  await ontologyFrame.executeJavaScript('window.confirm=()=>true;document.querySelector("[aria-label=关闭配置抽屉]").click()');
  await js('document.querySelector("#warehouse-picker").close()');
  await catalogTab('实体类型');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".rules-assistant-page"))'), false);
  // A normal host broadcast must keep the original browsing document alive.
  await win.webContents.executeJavaScript('window.fixturePanel.mount()');
  assert.equal(frame.detached, false);
  await js('window.parent.fixtureOldBridge=window.semantica');
  await win.webContents.executeJavaScript('window.fixtureLaunchTarget=null;window.fixtureWarehouses=[];document.querySelector("iframe").contentWindow.location.reload()');
  await until(() => js('document.querySelector("#graph-empty-title")?.textContent'), value => value === '建立我的星图', 'empty box should show the first setup entry');
  assert.equal(await js('Boolean(document.querySelector("#warehouse-creation[open],#onboarding-shell:not([hidden])"))'), false);
  await until(() => js('!document.querySelector("#starlink-directory-entry").disabled'), Boolean, 'banner action did not reconnect');
  await js('document.querySelector("#starlink-directory-entry").click()');
  await js('document.querySelector("#view-warehouses:not([hidden]) .warehouse-directory-tools [data-action=new-warehouse]").click()');
  await until(() => js('Boolean(document.querySelector("#warehouse-creation[open] #warehouse-creation-name:not(:read-only)"))'), Boolean, 'new warehouse form remained blocked');
  assert.equal(await js('document.querySelector("#warehouse-profile-options").hidden'), true);
  assert.equal(await js('document.querySelector("#warehouse-creation-profile").textContent'), '通用知识');
  assert.equal(await js('document.querySelector("#warehouse-creation-error").hidden'), true);
  assert.equal(await js('document.querySelector("#app").hidden'), false);
  assert.equal(await js('document.querySelector("#starlink-directory-entry").nextElementSibling.id'), 'starlink-sidebar-project');
  // A retired document's Promise callbacks can be suspended by Chromium. Check
  // that it cannot dispatch a request, without awaiting work in that old realm.
  await win.webContents.executeJavaScript('window.fixtureOldBridge.call("upload",{handle:"retired-document"}).catch(()=>{});void 0');
  await delay(100);
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.some(call=>call.action==="upload")'),false);
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['packaged UI', 'current warehouse', 'scoped bridge', 'feature menu', 'desktop and narrow 3D layout', 'host sizes and zoom levels', 'graph search, focus and inspector', 'shared import entry', 'retired search route opens the graph', 'correction failure preserves text and retry identity', 'ontology workbench', 'unapplied type edits block warehouse switch', 'retained document', 'unblocked new warehouse form', 'reload revokes old document'], layouts, errors };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, 'panel.png'), (await win.webContents.capturePage()).toPNG());
  console.log('STARLINK_PANEL_SMOKE_PASS');
  clearTimeout(deadline);
  win.destroy(); app.exit(0);
}).catch(async error => {
  clearTimeout(deadline);
  await mkdir(output, {recursive:true});
  const diagnostic = win && !win.isDestroyed() ? await win.webContents.executeJavaScript('({calls:window.fixtureCalls,frames:[...document.querySelectorAll("iframe")].map(f=>({url:f.src,text:f.contentDocument?.body.innerText.slice(0,6000)}))})').catch(() => null) : null;
  await writeFile(join(output, 'failure.json'), JSON.stringify({message:error.message,errors,diagnostic}, null, 2));
  console.error(error); win?.destroy(); app.exit(1);
});
