import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as studio from '../../builder/integration/host-control.mjs';
import navigation from '../../builder/integration/preview-navigation.cjs';

const source=await readFile(new URL('../shell/main.mjs',import.meta.url),'utf8');
function window(){
  const webContents=new EventEmitter();
  Object.assign(webContents,{mainFrame:{},session:{webRequest:{onBeforeRequest(){}}},setWindowOpenHandler(handler){this.open=handler}});
  return{webContents};
}

test('the Team root consumes the canonical preview guard from its shipped Studio bundle',()=>{
  assert.equal(typeof studio.installPreviewNavigationGuard,'function');
  assert.equal(studio.installPreviewNavigationGuard,navigation.installPreviewNavigationGuard);
  assert.match(source,/import\s*\{[^}]*\binstallPreviewNavigationGuard\b[^}]*\}\s*from\s*["']\.\.\/applications\/studio\.mjs["']/);
  assert.doesNotMatch(source,/import[^\n]*preview-navigation/);
});

for(const withPanel of [false,true])test(`Team root guard only binds its control${withPanel?' and panel':''} WebContents`,()=>{
  const control=window(),panel=withPanel?window():null,managed=window();
  const loop=source.match(/for \(const window of \[control, panel\]\.filter\(Boolean\)\) \{[\s\S]*?\n      \}/)?.[0];
  assert.ok(loop,'the root initialization has an explicit finite window scope');
  vm.runInNewContext(loop,{control,panel,installPreviewNavigationGuard:studio.installPreviewNavigationGuard});
  for(const item of [control,panel].filter(Boolean)){
    const wc=item.webContents,requestHook=wc.session.webRequest.onBeforeRequest;
    assert.equal(wc.listenerCount('will-frame-navigate'),1);
    const attempt={url:'https://example.invalid/',isMainFrame:false,frame:{parent:wc.mainFrame},initiator:{},prevented:false,preventDefault(){this.prevented=true}};
    wc.emit('will-frame-navigate',attempt);assert.equal(attempt.prevented,true);
    const srcdoc={...attempt,url:'about:srcdoc',initiator:wc.mainFrame,prevented:false};
    wc.emit('will-frame-navigate',srcdoc);assert.equal(srcdoc.prevented,false);
    for(const name of ['will-navigate','will-redirect','will-attach-webview']){
      const top={prevented:false,preventDefault(){this.prevented=true}};wc.emit(name,top);assert.equal(top.prevented,true);
    }
    assert.equal(wc.open({url:'https://example.invalid/'}).action,'deny');
    assert.equal(wc.session.webRequest.onBeforeRequest,requestHook);
  }
  assert.equal(managed.webContents.listenerCount('will-frame-navigate'),0,'managed application windows are not intercepted');
  assert.equal(managed.webContents.open,undefined);
});
