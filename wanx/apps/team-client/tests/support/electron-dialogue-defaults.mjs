import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
let control;
async function verify() {
try {
  await app.whenReady();
  control = new BrowserWindow({ show:false, width:900, height:760, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false } });
  const html=app.getPath('userData')+'/model-defaults.html';
  await writeFile(html,'<html><body><main id="host"></main></body></html>');
  await control.loadFile(html);
  control.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
  await control.webContents.executeJavaScript((await readFile(new URL('../../local-ui/renderer/ai-dialogue.js',import.meta.url),'utf8'))+'\n;void 0;');
  await control.webContents.executeJavaScript(`(async()=>{
    const check=(value,message)=>{if(!value)throw Error(message)};
    const until=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout: '+condition)};
    const models=[{id:'fixture/one',name:'One',provider:'fixture'},{id:'fixture/two',name:'Two',provider:'fixture'}];
    let defaultModel='fixture/one',holdRefresh=false,releaseRefresh,refreshEntered=false;
    const calls=[];
    const selection=()=>({modelMode:'auto',managedDefaults:true,defaultModel,models});
    const view=createAIDialogueView({request:async(action,input)=>{
      calls.push({action,input});let value={scope:'synthetic-scope'};
      if(action==='dialogue.load')value={...value,...selection(),sessions:[],legacySessions:[],capabilities:{space:false,knowledge:false,channels:false,attachments:false}};
      if(action==='dialogue.model'){
        if(input.refresh&&holdRefresh){refreshEntered=true;await new Promise(r=>{releaseRefresh=r;});}
        value={...value,...selection(),...(input.modelMode==='manual'?{modelMode:'manual',defaultModel:input.model}:{})};
      }
      if(action==='dialogue.release-context')value={...value,...selection(),context:{}};
      return {ok:true,value};
    }});
    view.hostState({phase:'ready',account:{phase:'authenticated',accountId:'synthetic-owner',clientId:'test'},connection:{deviceId:'synthetic-box',gatewayURL:'http://127.0.0.1'}});
    view.visible(true);view.mount(document.getElementById('host'));
    await until(()=>view.snapshot().model==='fixture/one');
    const input=document.querySelector('[data-chat-input]');input.value='Draft survives';input.dispatchEvent(new Event('input',{bubbles:true}));
    holdRefresh=true;
    document.querySelector('[data-chat-action="models"]').click();
    await until(()=>refreshEntered);
    document.querySelector('[data-chat-action="model"][data-id="fixture/two"]').click();
    await until(()=>view.snapshot().modelMode==='manual'&&view.snapshot().model==='fixture/two');
    releaseRefresh();holdRefresh=false;await new Promise(r=>setTimeout(r,30));
    check(view.snapshot().modelMode==='manual'&&view.snapshot().model==='fixture/two','late default refresh overwrote manual choice');
    check(view.snapshot().draft==='Draft survives','model choice discarded draft');
    document.querySelector('[data-chat-action="model-auto"]').click();
    await until(()=>view.snapshot().modelMode==='auto'&&view.snapshot().model==='fixture/one');
    check(document.querySelector('[data-chat-models]').textContent.includes('跟随默认'),'automatic mode missing from picker');
    defaultModel='fixture/two';await view.newConversation();
    check(view.snapshot().model==='fixture/two','new conversation retained old default');
    defaultModel=null;await view.newConversation();
    check(view.snapshot().model===null&&document.querySelector('[data-chat-send]').disabled,'unconfigured default permits sending');
    check(document.querySelector('[data-chat-models]').textContent.includes('等待管理员配置'),'waiting default is not shown');
    check(!calls.some(c=>c.action==='dialogue.send'),'changing defaults dispatched a turn');
    view.visible(false);
  })().catch(error=>{console.error(error.stack);throw error})`);
  console.log('DIALOGUE_DEFAULTS_UI_PASS');
  control.destroy(); app.exit(0);
} catch(error) { console.error(error);control?.destroy();app.exit(1); }

}
void verify();
