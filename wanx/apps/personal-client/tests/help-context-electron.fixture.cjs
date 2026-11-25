const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const edition = process.argv[2] || 'personal-client';
const directory = path.join(root, 'apps', edition, 'local-ui', 'renderer');
const evidence = path.join(root, 'verification', 'faq-context', edition);
mkdirSync(evidence, { recursive: true });
app.setPath('userData', path.join(evidence, 'electron-profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const mock = `
window.fixtureCalls = []; window.fixtureErrors = [];
window.addEventListener('error', e => window.fixtureErrors.push(e.message));
window.addEventListener('unhandledrejection', e => window.fixtureErrors.push(String(e.reason)));
window.fixtureState = { route: 'applications', phase: 'idle', account: { phase: 'authenticated', accountId: 'fixture-account', clientId: 'fixture-client' }, devices: [], applications: [], network: { enabled: false } };
window.wanxClient = {
 onFaqUpdated: fn => {window.fixtureFaqUpdated=fn;},
 getLocalState: async () => window.fixtureState, onLocalState: fn => { window.fixturePublish = fn; },
 action: async (name, input) => { window.fixtureCalls.push({name,input}); return { ok: true, value: name === 'help.faq' ? { data: { categories: [
 { id: 71, name: '添加盒子、发现与配网', items: [{ id: 701, question: '扫描不到盒子怎么办？', answer: '请打开蓝牙后重试。' }] },
 { id: 93, name: '盒子连接与网络恢复', items: [{ id: 903, question: '盒子连接失败怎么办？', answer: '请检查网络。' }] }
 ] }, etag: 'fixture-etag' } : name === 'help.feedback' ? { received: true } : name === 'market.list' ? {items:[]} : undefined, state: window.fixtureState }; },
 listRememberedLogins: async () => ({items:[]}), getRememberedLogin: async () => ({remember:false})
};
window.wanxSetup = { state: async () => ({state:'idle'}), subscribe: fn => { window.fixtureSetup = fn; }, scanWifi: async () => [] };
`;
let html = readFileSync(path.join(directory, 'index.html'), 'utf8')
 .replace('<head>', '<head><base href="' + pathToFileURL(directory + path.sep).href + '">')
 .replace('<script src="./device-setup.bundle.js"></script>', '')
 .replace('<main id="app"></main>', '<main id="app"></main><script>' + mock + '</script>');
const fixtureHtml = path.join(evidence, 'fixture.html'); writeFileSync(fixtureHtml, html);
let win;
async function run() {
 await app.whenReady();
 win = new BrowserWindow({ show:false, width:1280, height:900, webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false} });
 const js = code => win.webContents.executeJavaScript(code, true);
 const wait = async code => { for(let i=0;i<100;i++){ if(await js(code))return; await new Promise(r=>setTimeout(r,25)); } throw Error('TIMEOUT: '+code); };
 const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await new Promise(r=>setTimeout(r,25)); };
 try {
  await win.loadFile(fixtureHtml); await wait('Boolean(currentState)');
  await click('[data-action="profile-menu"]');
  assert.equal(await js(`document.querySelector('.profile-menu [data-action="show-help"]').textContent.includes('问题与反馈')`),true);
  await click('.profile-menu [data-action="show-help"]');
  await wait(`Boolean(document.querySelector('.faq-category.active[data-id="all"]'))`);
  await click('[data-action="help-back"]');
  await click('[data-action="show-boxes"]');
  await js(`window.boxScroll=document.scrollingElement.scrollTop`);
  assert.equal(await js('document.querySelector(".box-faq-entry")'), null);
  assert.equal(await js('!document.querySelector(".wanx-section-banner[data-section=boxes] button")'), true);
  assert.equal(await js('Boolean(document.querySelector(".box-section-heading [data-action=refresh]"))'), true);
  assert.equal(await js('document.querySelector(".box-device-grid").lastElementChild.id'), "box-add-device");
  assert.equal(await js('Boolean(document.querySelector(".box-identity .box-connect-icon > .box-connect-glyph"))'), true);
  await click('[data-action="profile-menu"]'); await click('.profile-menu [data-action="show-help"]');
  await click('[data-action="help-back"]'); assert.equal(await js('page'), 'boxes');
  assert.equal(await js('document.scrollingElement.scrollTop===boxScroll'),true);
  await js(`currentState.devices=[{deviceId:'fixture-box',name:'测试盒子'}]; connectionFailure={deviceId:'fixture-box',message:'模拟连接失败'};render(currentState);`);
  assert.equal(await js('Boolean(document.querySelector(".box-device-grid .device-card .box-connect-icon > .box-connect-glyph"))'), true);
  assert.equal(await js('document.querySelector(".box-overview img, .box-device-grid .device-card img")'), null);
  await click('.inline-error [data-action="show-help"]');
  await wait(`Boolean(document.querySelector('.faq-category.active[data-id="93"]'))`);
  await click('[data-action="help-back"]');
  await js(`page='provisioning'; setupReady=true; bluetoothState={status:'available'}; setupState={state:'awaitingWifi'}; render(currentState);
   window.savedWifiForm=document.querySelector('[data-form="wifi"]');
   savedWifiForm.querySelector('[name="password"]').value='synthetic-wifi-secret';
   savedWifiForm.querySelector('[name="ssid"]').value='synthetic-network';
   window.beforeHelpCalls=fixtureCalls.length;`);
  await click('[data-action="show-help"][data-scene="box_setup"]');
  await wait(`Boolean(document.querySelector('.faq-drawer .faq-category.active[data-id="71"]'))`);
  await js(`const buttons=[...document.querySelectorAll('.faq-drawer button:not(:disabled), .faq-drawer input:not(:disabled), .faq-drawer textarea:not(:disabled)')].filter(n=>n.getClientRects().length);window.lastHelpButton=buttons[buttons.length-1];lastHelpButton.focus();lastHelpButton.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));`);
  assert.equal(await js(`document.activeElement.dataset.action==='help-back'`),true);
  assert.equal(await js(`document.querySelector('#app').inert && page === 'provisioning' && document.querySelector('[data-form="wifi"]') === savedWifiForm`), true);
  assert.equal(await js(`document.querySelector('[data-action="help-refresh"]')===null`),true);
  await js(`fixtureFaqUpdated()`);
  await js(`const q=document.querySelector('.faq-drawer #faq-query'); q.value='扫描'; q.form.requestSubmit();`);
  await click('.faq-drawer [data-action="help-feedback-open"]');
  await js(`const text=document.querySelector('.faq-drawer textarea');text.value='synthetic feedback';text.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('.faq-drawer [data-form="help-feedback"] button[type="submit"]');
  await wait(`document.querySelector('.faq-drawer').textContent.includes('反馈已收到')`);
  await js(`fixtureFaqUpdated()`);
  assert.equal(await js(`document.querySelector('[data-form="wifi"]')===savedWifiForm && savedWifiForm.querySelector('[name="password"]').value==='synthetic-wifi-secret'`),true);
  // Real DOM keyboard event: Escape closes and restores the live trigger.
  await js(`document.querySelector('.faq-drawer-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  assert.equal(await js(`!document.querySelector('.faq-drawer') && !document.querySelector('#app').inert && document.activeElement.dataset.scene==='box_setup'`),true);
  await click('[data-action="show-help"][data-scene="box_setup"]');
  await js(`fixtureSetup({state:'awaitingWifi',preview:{display_name:'synthetic device'}});`);
  assert.equal(await js(`document.querySelector('[data-form="wifi"]')===savedWifiForm && savedWifiForm.querySelector('[name="ssid"]').value==='synthetic-network'`),true);
  await js(`fixtureSetup({state:'provisioningWifi'});fixtureSetup({state:'completed'});`);
  assert.equal(await js(`Boolean(document.querySelector('.faq-drawer')) && setupState.state==='completed'`),true);
  assert.equal(await js(`JSON.stringify(fixtureCalls).includes('synthetic-wifi-secret')`),false);
  const unexpected = await js(`fixtureCalls.slice(beforeHelpCalls).filter(row=>row.name!=='help.faq' && row.name!=='help.feedback')`);
  assert.deepEqual(unexpected,[]);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync(path.join(evidence,'drawer-desktop.png'),(await win.webContents.capturePage()).toPNG());
  win.setSize(560,800);
  await wait(`innerWidth < 700 && Math.abs(document.querySelector('.faq-drawer-panel').getBoundingClientRect().width-document.querySelector('.faq-drawer').getBoundingClientRect().width)<2`);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync(path.join(evidence,'drawer-narrow.png'),(await win.webContents.capturePage()).toPNG());
  await js(`fixtureState={route:'auth',phase:'signed_out',account:{phase:'signed_out',reason:'AUTH_CLIENT_REPLACED'},devices:[],applications:[]};fixturePublish(fixtureState);`);
  assert.equal(await js(`!document.querySelector('.faq-drawer') && !document.querySelector('#app').inert && document.body.textContent.includes('账号已在其他客户端登录')`),true);
  assert.deepEqual(await js('fixtureErrors'),[]);
  writeFileSync(path.join(evidence,'result.json'),JSON.stringify({ok:true,edition,boundary:'Real Electron DOM and shipped renderer; synthetic account, FAQ and setup state; no hardware or production writes'},null,2));
  console.log('PASS '+edition); app.exit(0);
 } catch(error) { console.error(error);console.error(await js('({errors:fixtureErrors,view:document.body.innerText.slice(0,1800)})').catch(()=>({})));app.exit(1); }
}
run().catch(error=>{console.error(error);app.exit(1);});
