// Transport-only synthetic receipts; no production account, backend or writes.
import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {fileURLToPath} from 'node:url';

const methods=['document-text','evidence','authorization-summary','governance-summary','governance-reviews','governance-detail','governance-resolve','governance-flag','governance-propose','governance-apply','governance-unflag'];
const input={warehouseId:'12345678-1234-1234-1234-123456789abc',operationId:'12345678-1234-1234-1234-123456789def',expectedRevision:3};
let win,edition;
const calls=[];
app.on('window-all-closed',()=>{});
async function verify(){
  try{
    await app.whenReady();
    ipcMain.handle('wanx-client:get-state',()=>({phase:'ready',account:{phase:'authenticated',accountId:'synthetic-ipc-only'},connection:{deviceId:'synthetic-box',mode:'local'}}));
    ipcMain.handle('wanx-client:data',(_event,{action,input})=>{
      calls.push({edition,action,input});
      if(input.fail){const code='WAREHOUSE_GOVERNANCE_REVISION_CONFLICT';if(edition==='team')return {ok:false,code};throw Error(code);}
      const value={transport:'synthetic-native-ipc',edition,action,input};
      return edition==='team'?{ok:true,value}:value;
    });
    for(edition of ['personal','team']){
      const preload=fileURLToPath(new URL(edition==='personal'?'../../local-ui/remote-preload.cjs':'../../../team-client/local-ui/remote-preload.cjs',import.meta.url));
      win=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      await win.loadURL('data:text/html,<title>Starlink synthetic IPC transport acceptance</title>');
      const results=await win.webContents.executeJavaScript(`(async()=>{const out=[];for(const method of ${JSON.stringify(methods)})out.push(await window.wanxClient.action('data.'+method,${JSON.stringify(input)}));return out;})()`);
      assert.equal(results.length,11);
      for(let i=0;i<methods.length;i++){
        assert.equal(results[i].ok,true);assert.deepEqual(results[i].value,{transport:'synthetic-native-ipc',edition,action:methods[i],input});
      }
      const before=calls.length;
      for(const action of ['data.workbench-request','data.governance-arbitrary','data.delete-warehouse']){
        const denied=await win.webContents.executeJavaScript(`window.wanxClient.action(${JSON.stringify(action)},{url:'/api/governance'})`);
        assert.equal(denied.ok,false);assert.equal(denied.code,'UNKNOWN_CLIENT_ACTION');
      }
      assert.equal(calls.length,before,'unknown actions never reach native data IPC');
      const failure=await win.webContents.executeJavaScript(`window.wanxClient.action('data.governance-apply',{fail:true})`);
      assert.equal(failure.ok,false);assert.equal(failure.code,'WAREHOUSE_GOVERNANCE_REVISION_CONFLICT');assert.equal(failure.value,undefined);
      win.destroy();win=null;
    }
    assert.equal(calls.length,24);
    console.log('STARLINK_PRELOAD_ELECTRON_PASS '+JSON.stringify({editions:2,typedActions:22,rejectedUnknown:6,retainedFailures:2}));
  }catch(error){console.error(error);process.exitCode=1;}
  finally{win?.destroy();app.exit(process.exitCode||0);}
}
void verify();
