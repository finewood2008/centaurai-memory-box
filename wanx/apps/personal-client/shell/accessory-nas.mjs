import path from 'node:path';
import { constants } from 'node:fs';
import { open, stat, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createApplicationSession } from '../app-host/session.mjs';
import sdk from '../host-sdk/index.cjs';
import { readMemoryConnection } from './local-memory-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const operations = new Set(['status','search','preview','ask','project','folders','space','memory','disk-list','disk-mkdir','disk-rename','disk-move','disk-trash','disk-trash-list','disk-restore','disk-image','download','upload']);
const projectId = /^[0-9a-f]{32}$/;

export async function nasRequest({app,client,memoryFile,dialog,window}, op, input) {
  if (!operations.has(op) || !input || typeof input !== 'object') throw Error('无效的硬盘操作');
  if (client.snapshot().phase !== 'ready') throw Error('请先在「盒子」连接设备。');
  const session = await createApplicationSession({
    applicationId:'centaurai.memobox.nas', hostApplicationId:'ai.centuarai.wanx.client',
    installPath:app.getAppPath(), capabilities:['identity.read','http.request'],
    createConnection:({applicationId,...options}) => client.applicationConnection(applicationId,options),
  });
  const abort = new AbortController();
  const unwatch = session.onInvalidated(() => abort.abort());
  const host = sdk.fromEnvironment(session.environment);
  try {
    const ctx = session.assertLive();
    const scope = hash(JSON.stringify([ctx.boxId,ctx.principalId || ctx.accountId,ctx.dataIdentity?.profileId]));
    const configFile = path.join(app.getPath('userData'),'nas-accessory',scope,'connection.json');
    const file = await open(configFile,constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(() => { throw Error('当前账号和盒子还没有接入授权目录。'); });
    let config;
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size>4096 || (process.platform!=='win32' && (st.uid!==process.getuid() || st.mode & 0o077))) throw Error('设备连接配置无效');
      config = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (config.box!==ctx.boxId || config.user!==String(ctx.user?.id) || !Number.isInteger(config.port) || config.port<1 || config.port>65535 || !/^[\w-]{40,128}$/.test(config.token)) throw Error('设备授权不匹配');
    const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(op==='ask'?260000:115000)]);
    async function box(action, data) {
      session.assertLive();
      const r = await fetch('http://127.0.0.1:'+config.port+'/'+action,{
        method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(data),
      }).catch(() => {throw Error('无法连接盒端外接存储服务。请检查设备连接。');});
      const result=await r.json();
      if (!r.ok) throw Error(result.error || '设备请求失败');
      session.assertLive();
      return result;
    }
    if (op==='upload' || op==='download') {
      const upload=op==='upload';
      const chosen=upload ? await dialog.showOpenDialog(window,{title:'上传到外接硬盘',properties:['openFile']})
        : await dialog.showSaveDialog(window,{title:'从硬盘下载',defaultPath:path.basename(input.ref.path)});
      if (chosen.canceled) return {cancelled:true};
      const target=upload ? chosen.filePaths[0] : chosen.filePath;
      const item=upload ? {parent:input.parent || '',name:path.basename(target)} : {ref:input.ref};
      const headers={Authorization:'Bearer '+config.token,'X-Disk-Item':Buffer.from(JSON.stringify(item)).toString('base64')};
      let stream;
      session.assertLive();
      try {
        if(upload){
          const st=await stat(target);
          if(!st.isFile() || st.size>200*1024*1024)throw Error('单文件最大 200 MB');
          headers['Content-Length']=String(st.size);
          if(st.size)stream=createReadStream(target);
        }
        const res=await fetch('http://127.0.0.1:'+config.port+'/'+op,{method:'POST',redirect:'error',headers,signal,
          ...(stream?{body:stream,duplex:'half'}:{})});
        if(!res.ok)throw Error((await res.json()).error || '文件传输失败');
        if(!upload){
          const tmp=target+'.'+randomUUID()+'.part';
          try{
            await pipeline(res.body,createWriteStream(tmp,{flags:'wx',mode:0o600}),{signal});
            session.assertLive();
            await rename(tmp,target);
          }finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
        }
        return {ok:true};
      } finally { stream?.destroy(); }
    }
    if (!['folders','space','memory'].includes(op)) return await box(op,input);
    const parent=input.parent || '';
    if (parent && !projectId.test(parent)) throw Error('空间目录无效');
    if (op==='folders') {
      const list=await host.drive.list({parent,signal});
      return {folders:list.items.filter(v=>v.kind==='folder').map(v=>({id:v.id,name:v.name}))};
    }
    if (!projectId.test(input.id)) throw Error('项目编号无效');
    const project=await box('project',{id:input.id});
    const turn=project.turns[input.turn];
    if (!Number.isInteger(input.turn) || !turn) throw Error('项目版本无效');
    const sources=turn.refs.map((v,i)=>'['+(i+1)+'] '+[project.device,project.folder,v.path].filter(Boolean).join('/')+' · '+v.version).join('\n');
    const content=turn.question+'\n\n'+turn.answer+'\n\n来源 · 配件 / 外接硬盘\n'+sources+'\n项目 '+project.id;
    const key=hash(JSON.stringify([scope,op,project.id,input.turn,parent]));
    session.assertLive();
    if (op==='space') {
      const name='硬盘问答 '+project.id.slice(0,10)+'-'+(input.turn+1)+'.md';
      const existing=(await host.drive.list({parent,signal})).items.find(v=>v.name===name);
      if (existing && existing.digest!==hash(content)) throw Error('目标目录已有同名文件，内容已变化。');
      const saved=existing || await host.drive.upload({name,parent,data:content,uploadId:key.slice(0,32),signal});
      return {id:saved.id};
    }
    const {base,token}=await readMemoryConnection(memoryFile());
    session.assertLive();
    const result=await fetch(new URL('/api/v1/memory/add',base),{method:'POST',signal,redirect:'error',
      headers:{'Content-Type':'application/json','x-memmy-local-token':token},
      body:JSON.stringify({requestId:key,turnId:key,title:turn.question,content,layer:'L1',source:'accessories',sourceAgentId:'accessories',adapterId:'agent-source:accessories',tags:['accessories','external-disk',project.id],deferProcessing:true})});
    if (!result.ok) throw Error('记忆保存失败，请重试。');
    const {id}=await result.json();
    if (!id) throw Error('记忆服务没有返回保存回执');
    return {id};
  } finally { unwatch?.(); host.close(); await session.close(); }
}
