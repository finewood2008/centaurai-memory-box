import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, open, stat, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createApplicationSession } from '../app-host/session.mjs';
import { readMemoryConnection } from './local-memory-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const operations = new Set(['volume-status','volume-name','status','search','preview','ask','project','memory','disk-list','disk-mkdir','disk-rename','disk-move','disk-trash','disk-trash-list','disk-restore','disk-image','download','upload']);
const projectId = /^[0-9a-f]{32}$/;

function driveName(value) {
  return typeof value === 'string' && value.length <= 48 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value.trim() : null;
}

async function volumeName(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!handle) return '';
  try {
    const stats = await handle.stat();
    return stats.isFile() && stats.size <= 192 ? driveName(await handle.readFile('utf8')) : '';
  } finally { await handle.close(); }
}

export function nasRequest(context, op, input) {
  if (!operations.has(op) || !input || typeof input !== 'object') throw Error('无效的硬盘操作');
  return request(context, op, input, false);
}

export function spaceVolumeRequest(context, {op, ...input}) {
  if (!['volumes', 'folder', 'preview', 'text-open', 'text-save'].includes(op)) throw Error('无效的硬盘读取操作');
  return request(context, 'space/' + op, input, true);
}

export async function isAttachedVolume(context, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}@\d+-\d+$/.test(id)) return false;
  const volumes = await spaceVolumeRequest(context, {op:'volumes'});
  return volumes.some(volume => volume.id === id);
}

export function mountedSpaceCandidates(context) {
  return request(context, 'volume-bindings', {}, true);
}

export function readMountedSpaceSource(context, op, input) {
  if (op !== 'folder' && op !== 'file') throw Error('无效的硬盘读取操作');
  return request(context, 'space/' + op, input, true);
}

async function request({app,client,memoryFile,dialog,window}, op, input, spaceRead) {
  if (client.snapshot().phase !== 'ready') throw Error('请先在「盒子」连接设备。');
  const inventory = ['space/volumes','volume-status','volume-name','volume-bindings'].includes(op);
  function unconfigured() {
    if (op === 'space/volumes' || op === 'volume-bindings') return [];
    if (op === 'volume-status') return {configured:false, volumes:[], waiting:[]};
    throw Error('当前盒子还未配置空间硬盘访问。');
  }
  const session = await createApplicationSession({
    applicationId:'centaurai.memobox.nas', hostApplicationId:'ai.centuarai.wanx.client',
    installPath:app.getAppPath(), capabilities:['identity.read'],
    createConnection:({applicationId,...options}) => client.applicationConnection(applicationId,options),
  });
  const abort = new AbortController();
  const unwatch = session.onInvalidated(() => abort.abort());
  try {
    const ctx = session.assertLive();
    const scope = hash(JSON.stringify([ctx.boxId,ctx.principalId || ctx.accountId,ctx.dataIdentity?.profileId]));
    const configFile = path.join(app.getPath('userData'),'nas-accessory',scope,'connection.json');
    const file = await open(configFile,constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!file) {
      if (inventory) return unconfigured();
      throw Error('当前账号和盒子还没有接入授权目录。');
    }
    let config;
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size>4096 || (process.platform!=='win32' && (st.uid!==process.getuid() || st.mode & 0o077))) throw Error('设备连接配置无效');
      config = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (config.box!==ctx.boxId || config.user!==String(ctx.user?.id) || !Number.isInteger(config.port) || config.port<1 || config.port>65535 || !/^[\w-]{40,128}$/.test(config.token)) throw Error('设备授权不匹配');
    if (inventory && !config.spaceReadToken) return unconfigured();
    const edit = op === 'space/text-save' || op === 'space/text-open';
    const diskToken = edit ? config.spaceEditToken : (spaceRead || inventory) ? config.spaceReadToken : config.token;
    if (!/^[\w-]{40,128}$/.test(diskToken || '')) throw Error(edit ? 'SPACE_TEXT_EDIT_UNAVAILABLE' : '空间硬盘浏览尚未配置');
    const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(inventory ? 9000 : op==='ask' ? 260000 : 115000)]);
    async function box(action, data) {
      session.assertLive();
      const r = await fetch('http://127.0.0.1:'+config.port+'/'+action,{
        method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+diskToken,'Content-Type':'application/json'},body:JSON.stringify(data),
      }).catch(() => {throw Error('无法连接盒端外接存储服务。请检查设备连接。');});
      const result=await r.json().catch(() => {throw Error('外接存储服务响应异常，请检查盒子连接。');});
      if (!r.ok) throw Error(result.error || '设备请求失败');
      session.assertLive();
      return result;
    }
    if (inventory) {
      const result = await box('space/volumes', op === 'volume-bindings' ? {inventory:true, includeMount:true} : {inventory:true});
      // Older boxes return the original list even when inventory is requested.
      const {volumes, waiting} = Array.isArray(result) ? {volumes:result, waiting:[]} : result;
      const names = path.join(path.dirname(configFile), 'volume-names');
      const nameFile = volume => volume?.uuid && volumes.filter(v => v.uuid === volume.uuid).length === 1
        ? path.join(names, hash(volume.uuid)) : null;
      if (op === 'volume-name') {
        const file = nameFile(volumes.find(v => v.id === input.volume));
        const name = driveName(input.name);
        if (!file || name === null) throw Error('请选择支持改名的在线硬盘，名称最多 48 个字符。');
        await mkdir(names, {recursive:true, mode:0o700});
        const tmp = path.join(names, randomUUID());
        try {
          await writeFile(tmp, name, {mode:0o600, flag:'wx'});
          session.assertLive();
          await rename(tmp, file);
        } finally { await unlink(tmp).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
        return {ok:true};
      }
      const items = await Promise.all(volumes.map(async ({uuid, ...volume}) => {
        const file = nameFile({uuid});
        const nick = file ? await volumeName(file).catch(() => '') : '';
        return {...volume, label:volume.name, name:nick || volume.name, canRename:Boolean(file)};
      }));
      session.assertLive();
      if (op === 'volume-bindings') {
        return items.filter(item => item.canRename && !item.readOnly && typeof item.mount === 'string')
          .map(({id, name, mount}) => ({id, volume:id.slice(0, id.lastIndexOf('@')), name, mount}));
      }
      return op === 'space/volumes'
        ? items.map(({id,name}) => ({id,name}))
        : {configured:true, volumes:items.map(({mount, ...item}) => item), waiting};
    }
    if (op === 'space/text-open') return {...await box(op,input), transferScope:scope};
    if (op === 'space/text-save') {
      if (input.transferScope !== scope) throw Error('SPACE_CONTEXT_CHANGED');
      return await box(op,input);
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
    if (op!=='memory') return await box(op,input);
    if (!projectId.test(input.id)) throw Error('项目编号无效');
    const project=await box('project',{id:input.id});
    const turn=project.turns[input.turn];
    if (!Number.isInteger(input.turn) || !turn) throw Error('项目版本无效');
    const sources=turn.refs.map((v,i)=>'['+(i+1)+'] '+[project.device,project.folder,v.path].filter(Boolean).join('/')+' · '+v.version).join('\n');
    const content=turn.question+'\n\n'+turn.answer+'\n\n来源 · 配件 / 外接硬盘\n'+sources+'\n项目 '+project.id;
    const key=hash(JSON.stringify([scope,op,project.id,input.turn,'']));
    session.assertLive();
    const {base,token}=await readMemoryConnection(memoryFile());
    session.assertLive();
    const result=await fetch(new URL('/api/v1/memory/add',base),{method:'POST',signal,redirect:'error',
      headers:{'Content-Type':'application/json','x-memmy-local-token':token},
      body:JSON.stringify({requestId:key,turnId:key,title:turn.question,content,layer:'L1',source:'accessories',sourceAgentId:'accessories',adapterId:'agent-source:accessories',tags:['accessories','external-disk',project.id],deferProcessing:true})});
    if (!result.ok) throw Error('记忆保存失败，请重试。');
    const {id}=await result.json();
    if (!id) throw Error('记忆服务没有返回保存回执');
    return {id};
  } finally { unwatch?.(); await session.close(); }
}
