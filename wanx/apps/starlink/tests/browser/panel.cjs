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
    <div class="wanx-section-actions"><button type="button" id="starlink-banner-create" class="button primary" disabled>＋ 新建数据仓</button></div>
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
  assert.equal(await js('document.querySelectorAll(".nav-item[data-view=skills],.nav-item[data-view=data],.nav-item[data-view=sensitive],.nav-item[data-view=releases]").length'), 0);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#starlink-banner-create").disabled'), false);
  for (const width of [1440, 1100, 850, 760]) {
    const wide = width >= 1100;
    win.setContentSize(width, wide ? 900 : 760);
    await until(() => js(`parent.innerWidth === ${width} && innerWidth === Math.round(parent.document.querySelector("#starlink-panel-region").getBoundingClientRect().width)`), Boolean, 'graph viewport did not resize');
    const banner = await win.webContents.executeJavaScript(`(() => {
      const starlink = document.querySelector(".starlink-banner");
      const reference = starlink.cloneNode(true);
      reference.classList.remove("starlink-banner");
      reference.dataset.section = "memory";
      reference.querySelector(".wanx-section-actions").remove();
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
        current: current?.dataset.view,
        inspector: document.querySelector(".graph-inspector").hidden,
        filters: document.querySelector(".graph-filter-menu").open };
    })()`);
    assert.ok(layout.ratio >= (width === 1440 ? .69 : .63), JSON.stringify(layout));
    assert.equal(layout.railVisible, width > 900);
    if (layout.railVisible) assert.ok(layout.railWidth >= 182 && layout.railWidth <= 210, JSON.stringify(layout));
    assert.deepEqual(layout.navGroups, ['探索', '资料处理', '本体与关系', '管理']);
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
    const toggle = document.querySelector(".mobile-toggle");
    const rect = toggle.getBoundingClientRect();
    return rect.width > 0 && toggle.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })()`), true);
  await js('document.querySelector(".mobile-toggle").click()');
  assert.equal(await js('document.querySelector(".mobile-toggle").getAttribute("aria-expanded")'), 'true');
  await js('document.querySelector(".starlink-rail [data-view=graph]").click()');
  assert.equal(await js('document.querySelector(".mobile-toggle").getAttribute("aria-expanded")'), 'false');
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
  win.setContentSize(1280, 900);
  await js('document.querySelector(".starlink-rail [data-view=warehouses]").click()');
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

  await js('document.querySelector(".starlink-rail [data-view=tasks]").click()');
  await until(() => js('document.querySelector(".task-error")?.textContent'), text => text === '合成失败原因', 'failed tasks missing');
  assert.match(await js('document.querySelector(".task-progress").textContent'), /失败.*2.*5/);
  assert.equal(await js('document.querySelector(".task-model-details").open'), false);
  assert.ok(await js('Boolean(document.querySelector(".task-end [data-retry]"))'));
  await writeFile(join(output, 'subpage-tasks.png'), (await win.webContents.capturePage()).toPNG());

  await js('document.querySelector(".starlink-rail [data-view=models]").click()');
  await until(() => js('document.querySelectorAll("#model-stages .model-stage").length'), count => count === 5, 'configured roles missing');
  assert.ok(await js('document.querySelector("#model-scope").getBoundingClientRect().top < document.querySelector("#model-stages").getBoundingClientRect().top'));
  await delay(130);
  await writeFile(join(output, 'subpage-models.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript('window.fixtureOverrides["conversation-list"]=()=>({ok:false,code:"SEMANTICA_CONNECTION_FAILED"});void 0');
  await js('document.querySelector(".starlink-rail [data-view=conversation]").click()');
  await until(() => js('Boolean(document.querySelector(".material-load-failure [data-action=reload-materials]"))'), Boolean, 'material load failure was presented as empty');
  assert.match(await js('document.querySelector(".mw-list-empty").textContent'), /暂不可读/);
  await writeFile(join(output, 'subpage-material-failure.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('delete window.fixtureOverrides["conversation-list"]');
  await js('document.querySelector("[data-action=reload-materials]").click()');
  await until(() => js('Boolean(document.querySelector("#page-primary[data-action=import]:enabled:not([hidden])"))'), Boolean, 'material retry did not restore the import action');
  assert.equal(await js('document.querySelector(".material-load-failure")'), null);
  assert.equal(await js('document.querySelector("#page-title").textContent'), '资料库');
  assert.equal(await js('document.querySelectorAll(".mw-library [data-cv=material-add]").length'), 0);
  await writeFile(join(output, 'subpage-material.png'), (await win.webContents.capturePage()).toPNG());

  assert.deepEqual(await js('[...document.querySelectorAll("[aria-labelledby=starlink-browse] button")].map(button => button.textContent.trim())'), ['知识星图']);
  assert.equal(await js('Boolean(document.querySelector("#view-search"))'), false);
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
  assert.deepEqual(await js('[...document.querySelectorAll("[aria-labelledby=starlink-ontology] button")].map(button => button.textContent)'), ['规则总览','规则调整向导']);
  assert.equal(await js('Boolean(document.querySelector("#ontology-actions"))'), false);
  const chooseOntology = action => action === 'published'
    ? js('document.querySelector(".starlink-rail [data-ontology-action=published]").click()')
    : ontologyJs(`[...document.querySelectorAll(".rules-workspace-header button")].find(button => ["待发布草稿", "查看草稿"].includes(button.textContent.trim())).click()`);
  await chooseOntology('published');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  await until(() => js('document.querySelector("#page-title").textContent'), text => text === '本体与关系', 'ontology navigation did not complete');
  await until(() => win.webContents.mainFrame.framesInSubtree.map(f => f.url), urls => urls.some(url => url.includes('/workbench/index.html')), 'ontology workbench missing');
  assert.equal(await js('document.querySelector("#rules-guide-entry").hidden'), false);
  await until(() => js('document.querySelector("#view-workbench iframe")?.contentDocument?.body.textContent || ""'), text => text.includes('本体'), 'ontology content did not render');
  assert.equal(await js('document.querySelector("#view-workbench iframe").contentDocument.body.textContent.includes("页面加载失败")'), false);
  const ontologyFrame = win.webContents.mainFrame.framesInSubtree.find(f => f.url.includes('/workbench/index.html'));
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
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-version [aria-current=page], .rules-draft-banner [aria-current=page]")?.textContent || ""'), /^(待发布草稿|查看草稿)/);
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-editor table[aria-label=实体类型列表]"))'), true);
  await ontologyJs('document.querySelector(".rules-draft-tabs button:last-child").click()');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-editor table[aria-label=关系类型列表]"))'), true);
  await ontologyJs('document.querySelector(".rules-draft-tabs button:first-child").click()');
  await ontologyJs('document.querySelector(".ontology-editor .ontology-list-heading button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-type-page"))'), Boolean, 'adding directly from the draft list did not open the form');
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]")?.dataset.view'), 'ontology');
  await ontologyJs('document.querySelector(".ontology-type-page footer button").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-editor:not([hidden])"))'), Boolean, 'cancel did not return to the draft list');
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-version [aria-current=page], .rules-draft-banner [aria-current=page]")?.textContent || ""'), /^(待发布草稿|查看草稿)/);
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
  assert.match(await ontologyJs('document.querySelector(".rules-workspace-version [aria-current=page], .rules-draft-banner [aria-current=page]")?.textContent || ""'), /^(待发布草稿|查看草稿)/);
  await ontologyJs('document.querySelector(".ontology-draft-actions .primary").click()');
  await until(() => ontologyJs('Boolean(document.querySelector(".ontology-saved-drafts .workflow-draft-row"))'), Boolean, 'saving the type did not add it to the draft list');
  assert.equal(await ontologyJs('Boolean(document.querySelector(".ontology-history-page"))'), false);
  await delay(130);
  await writeFile(join(output, 'subpage-ontology-drafts.png'), (await win.webContents.capturePage()).toPNG());
  await chooseOntology('published');
  await until(() => ontologyJs('Boolean(document.querySelector(".rules-catalog-grid"))'), Boolean, 'published rules did not reopen after editing');
  await ontologyFrame.executeJavaScript('document.querySelector(".rules-catalog-detail button[aria-label=编辑人物]").click()');
  await until(() => ontologyFrame.executeJavaScript('Boolean(document.querySelector(".ontology-drawer input"))'), Boolean, 'type drawer missing');
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
  await until(() => js('document.querySelector("#graph-empty-title")?.textContent'), value => value === '创建你的第一座数据仓', 'empty warehouse should land on the 3D home');
  assert.equal(await js('document.querySelector("#onboarding-shell").hidden'), true);
  await until(() => win.webContents.executeJavaScript('!document.querySelector("#starlink-banner-create").disabled'), Boolean, 'banner action did not reconnect');
  await win.webContents.executeJavaScript('document.querySelector("#starlink-banner-create").click()');
  await until(() => js('Boolean(document.querySelector("#onboarding-shell:not([hidden]) #od-name-form button[type=submit]:not(:disabled)"))'), Boolean, 'new warehouse onboarding remained blocked');
  assert.equal(await js('document.querySelectorAll("#onboarding-shell .wp-error").length'),0);
  assert.equal(await js('document.querySelector("#onboarding-shell").closest("#app").hidden'),false);
  assert.equal(await js('document.querySelector(".starlink-rail [aria-current=page]").dataset.view'),'warehouses');
  // A retired document's Promise callbacks can be suspended by Chromium. Check
  // that it cannot dispatch a request, without awaiting work in that old realm.
  await win.webContents.executeJavaScript('window.fixtureOldBridge.call("upload",{handle:"retired-document"}).catch(()=>{});void 0');
  await delay(100);
  assert.equal(await win.webContents.executeJavaScript('window.fixtureCalls.some(call=>call.action==="upload")'),false);
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['packaged UI', 'current warehouse', 'scoped bridge', 'feature menu', 'desktop and narrow 3D layout', 'host sizes and zoom levels', 'graph search, focus and inspector', 'shared import entry', 'retired search route opens the graph', 'correction failure preserves text and retry identity', 'ontology workbench', 'unapplied type edits block warehouse switch', 'retained document', 'unblocked onboarding', 'reload revokes old document'], layouts, errors };
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
