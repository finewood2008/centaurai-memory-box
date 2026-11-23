// Image qualification only. Uses temporary state and sends no model requests.
import {execFile,spawn} from 'node:child_process';
import {access,mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {ClientSideConnection,ndJsonStream} from '@agentclientprotocol/sdk';
import {NativeSession} from '../codex/native-session.mjs';
import {stopGroup} from '../dsh/sandbox.mjs';

const run=promisify(execFile);
const studioRoot=fileURLToPath(new URL('..',import.meta.url));

async function qualifyAcp(root,binary,directory,env,settings,provider){
  const acp=createRequire(path.join(root,'package.json')).resolve('@agentclientprotocol/codex-acp');
  const acpCodex=createRequire(acp).resolve('@openai/codex/bin/codex.js');
  if(acpCodex!==await realpath(binary))throw new Error('CODEX_ACP_BUNDLE_DUPLICATE');

  const state=path.join(directory,'acp-state');
  await mkdir(state,{mode:0o700});
  // ACP checks account state before creating a session. Set its startup provider
  // in the temporary Codex config so it can open a session without signing in.
  const entries=values=>Object.entries(values).map(([key,value])=>`${key}=${JSON.stringify(value)}`);
  await writeFile(path.join(state,'config.toml'),[
    ...entries(settings),`[model_providers.${settings.model_provider}]`,...entries(provider),'',
  ].join('\n'),{mode:0o600});
  const child=spawn(process.execPath,[acp],{
    cwd:directory,env:{...env,CODEX_HOME:state,NO_BROWSER:'1'},
    stdio:['pipe','pipe','ignore'],detached:true,
  });
  let timer;
  try{
    const unavailable=new Promise((_,reject)=>{
      child.once('error',reject);
      timer=setTimeout(()=>reject(new Error('CODEX_ACP_TIMEOUT')),20000);
    });
    const stream=ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout));
    const connection=new ClientSideConnection(()=>({async sessionUpdate(){}}),stream);
    await Promise.race([unavailable,(async()=>{
      const init=await connection.initialize({protocolVersion:1,clientCapabilities:{}});
      if(init.protocolVersion!==1)throw new Error('CODEX_ACP_PROTOCOL_INVALID');
      const session=await connection.newSession({cwd:directory,mcpServers:[]});
      if(!session.sessionId)throw new Error('CODEX_ACP_PROTOCOL_INVALID');
      await connection.closeSession({sessionId:session.sessionId});
    })()]);
  }finally{
    clearTimeout(timer);
    await stopGroup(child);
  }
}

export async function verifyBundledCodex(root=studioRoot){
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const version=manifest.dependencies?.['@openai/codex'];
  if(!/^\d+\.\d+\.\d+$/.test(version||''))throw new Error('CODEX_BUNDLE_VERSION_NOT_PINNED');
  const binary=path.join(root,'node_modules','.bin','codex');
  try{await access(binary,constants.X_OK)}catch{throw new Error('CODEX_BUNDLE_MISSING')}
  const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-codex-bundle-'));
  let native;
  try{
    const state=path.join(directory,'state');
    await mkdir(state,{mode:0o700});
    // Do not inherit host credentials, login state, plugins or proxy settings.
    const env={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:directory,CODEX_HOME:state};
    const result=await run(binary,['--version'],{env,cwd:directory,timeout:10000});
    if(result.stdout.trim()!==`codex-cli ${version}`)throw new Error('CODEX_BUNDLE_VERSION_MISMATCH');
    const settings={
      model_provider:'wanx_offline_check',check_for_update_on_startup:false,
      web_search:'disabled',
    };
    const provider={
      name:'WANX offline check',base_url:'http://127.0.0.1:9/v1',
      wire_api:'responses',requires_openai_auth:false,supports_websockets:false,
    };
    const config={...settings,mcp_servers:{},model_providers:{[settings.model_provider]:provider}};
    native=new NativeSession({binary,config,env});
    await native.connect(directory);
    if(typeof native.initialization?.userAgent!=='string')throw new Error('CODEX_BUNDLE_PROTOCOL_INVALID');
    await qualifyAcp(root,binary,directory,env,settings,provider);
    return {available:true,version,transport:'app-server',modelCalls:0};
  }finally{
    try{await native?.close()}
    finally{await rm(directory,{recursive:true,force:true})}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{process.stdout.write(JSON.stringify(await verifyBundledCodex())+'\n')}
  catch(error){
    process.stdout.write(JSON.stringify({available:false,modelCalls:0,
      code:/^CODEX_[A-Z_]+$/.test(error.message)?error.message:'CODEX_BUNDLE_FAILED'})+'\n');
    process.exitCode=1;
  }
}
