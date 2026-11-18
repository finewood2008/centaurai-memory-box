import path from 'node:path';
import {build} from 'esbuild';
import {installPreviewAnnotations} from './preview-annotations.mjs';
import {STANDARD_LAYOUT_FORMAT,STANDARD_LAYOUT_MAX_BYTES} from './standard-frame.mjs';

const FILE_LIMIT=2*1024*1024,TOTAL_LIMIT=8*1024*1024;
const fail=code=>Object.assign(new Error(code),{code});
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const text=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
function entities(value){return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|amp|quot|apos|lt|gt);/gi,(whole,n)=>n?String.fromCodePoint(parseInt(n.replace(/^x/i,''),/^x/i.test(n)?16:10)):({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'}[whole.toLowerCase()]||whole))}
function attributes(source){
 const result=new Map();
 for(const match of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)){
  const name=match[1].toLowerCase();if(result.has(name))throw fail('STANDARD_PREVIEW_HTML_INVALID');
  result.set(name,entities(match[2]??match[3]??match[4]??''));
 }
 return result;
}
const renderAttributes=attrs=>[...attrs].map(([name,value])=>' '+name+'="'+escape(value)+'"').join('');
const closeScript=value=>value.replace(/<\/script/gi,'<\\/script');
const closeStyle=value=>value.replace(/<\/style/gi,'<\\/style');
const dataAllowed=value=>/^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon)|font\/(?:woff2?|ttf|otf));base64,[A-Za-z0-9+/]*={0,2}$/.test(value);

export async function compileStandardPreview(input,{delivery=false}={}){
 if(!input||Object.keys(input).sort().join()!==['files','manifest','artifactHash','packageSha256'].sort().join()||
  typeof input.artifactHash!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactHash)||typeof input.packageSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.packageSha256)||
  input.manifest?.protocolVersion!==3||input.manifest.entrypoint!=='shell/main.cjs'||!input.files||Array.isArray(input.files))throw fail('STANDARD_PREVIEW_INPUT_INVALID');
 const files=new Map(),entries=Object.entries(input.files);let total=0;
 if(!entries.length||entries.length>256)throw fail('STANDARD_PREVIEW_LIMIT');
 for(const [name,value]of entries){
  if(typeof name!=='string'||name.length>4096||!name.startsWith('app/')||/[\\%\x00-\x1f]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||typeof value!=='string'||value.length>4*Math.ceil(FILE_LIMIT/3))throw fail('STANDARD_PREVIEW_PATH_DENIED');
  const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||bytes.length>FILE_LIMIT||(total+=bytes.length)>TOTAL_LIMIT)throw fail('STANDARD_PREVIEW_LIMIT');
  files.set(name,bytes);
 }
 if(!files.has('app/host.html')||!files.has('app/host.mjs'))throw fail('STANDARD_PREVIEW_INPUT_INVALID');
 function resolve(from,spec,{module=false}={}){
  if(typeof spec!=='string'||!spec||/[\\%?#\x00-\x1f]/.test(spec)||spec.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(spec)||module&&!spec.startsWith('.'))throw fail('STANDARD_PREVIEW_IMPORT_DENIED');
  const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
  if(!resolved.startsWith('app/')||!files.has(resolved))throw fail('STANDARD_PREVIEW_IMPORT_DENIED');
  return resolved;
 }
 function asset(from,spec){
  if(dataAllowed(spec))return spec;
  const resolved=resolve(from,spec),type=mime[path.posix.extname(resolved).toLowerCase()];
  if(!type)throw fail('STANDARD_PREVIEW_ASSET_DENIED');
  return 'data:'+type+';base64,'+files.get(resolved).toString('base64');
 }
 const importedStyles=[];
 async function compile(entry,loader,inline){
  const virtual=inline===undefined?null:{path:entry,contents:inline,loader};
  const plugin={name:'standard-preview-memory-only',setup(builder){
   builder.onResolve({filter:/.*/},args=>{
    if(args.kind==='entry-point'){if(!files.has(args.path)&&virtual?.path!==args.path)throw fail('STANDARD_PREVIEW_IMPORT_DENIED');return{path:args.path,namespace:'standard-app'}}
    if(args.kind==='url-token'&&dataAllowed(args.path))return{path:args.path,external:true};
    const resolved=resolve(args.importer,args.path,{module:!['url-token','import-rule'].includes(args.kind)});
    if(delivery){
     if(['require-call','require-resolve'].includes(args.kind))throw fail('STANDARD_DELIVERY_ES_MODULE_REQUIRED');
     if(['import-statement','dynamic-import'].includes(args.kind)){
      const extension=path.posix.extname(resolved).toLowerCase();
      if(extension==='.css')throw fail('STANDARD_DELIVERY_LINK_CSS_REQUIRED');
      if(extension==='.json'&&args.with?.type!=='json')throw fail('STANDARD_DELIVERY_JSON_ATTRIBUTE_REQUIRED');
      if(!['.js','.mjs','.json'].includes(extension))throw fail('STANDARD_DELIVERY_ASSET_REFERENCE_REQUIRED');
     }
    }
    return{path:resolved,namespace:'standard-app'};
   });
   builder.onLoad({filter:/.*/,namespace:'standard-app'},args=>{
    if(args.path===virtual?.path)return{contents:virtual.contents,loader:virtual.loader};
    const ext=path.posix.extname(args.path).toLowerCase(),bytes=files.get(args.path);
    if(!bytes)throw fail('STANDARD_PREVIEW_IMPORT_DENIED');
    if(mime[ext])return{contents:bytes,loader:'dataurl'};
    if(!['.mjs','.js','.json','.css'].includes(ext))throw fail('STANDARD_PREVIEW_IMPORT_DENIED');
    return{contents:text(bytes),loader:ext==='.css'?'css':ext==='.json'?'json':'js'};
   });
  }};
  try{
   const result=await build({entryPoints:[entry],bundle:true,platform:'browser',format:'esm',target:'es2022',write:false,logLevel:'silent',logOverride:{'unsupported-dynamic-import':'error','unsupported-require-call':'error','empty-glob':'error'},outdir:'memory-output',plugins:[plugin],metafile:true});
   const wanted=loader==='css'?'.css':'.js';
   if(result.outputFiles.some(output=>!output.path.endsWith(wanted)&&!(loader==='js'&&output.path.endsWith('.css'))))throw fail('STANDARD_PREVIEW_IMPORT_DENIED');
   if(loader==='js')for(const output of result.outputFiles.filter(output=>output.path.endsWith('.css')))importedStyles.push(output.text);
   const output=result.outputFiles.find(output=>output.path.endsWith(wanted));if(!output)throw fail('STANDARD_PREVIEW_COMPILE_FAILED');return output.text;
  }catch(error){if(error.code)throw error;const cause=error.errors?.find(entry=>/^STANDARD_/.test(entry.detail?.code||''))?.detail;if(cause)throw cause;throw fail('STANDARD_PREVIEW_COMPILE_FAILED')}
 }
 const blocks=[];
 const store=value=>{const index=blocks.push(value)-1;return '<!--wanx-standard-block-'+index+'-->'};
 let html=text(files.get('app/host.html')).replace(/<!--[\s\S]*?-->/g,'');
 // Script and style bodies are never parsed as markup or executed by Node.
 const scriptPattern=/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi;
 const scripts=[...html.matchAll(scriptPattern)];
 for(let index=scripts.length-1;index>=0;index--){
  const match=scripts[index],attrs=attributes(match[1]),type=(attrs.get('type')||'').toLowerCase();
  if(type&&!['module','text/javascript','application/javascript'].includes(type))throw fail('STANDARD_PREVIEW_HTML_INVALID');
  const source=attrs.has('src')?resolve('app/host.html',attrs.get('src')):'app/__preview_inline_'+index+'.mjs';
  const code=await compile(source,'js',attrs.has('src')?undefined:match[2]);
  html=html.slice(0,match.index)+store('<script type="module">'+closeScript(code)+'</script>')+html.slice(match.index+match[0].length);
 }
 const styles=[...html.matchAll(/<style\b(?:"[^"]*"|'[^']*'|[^'">])*?>([\s\S]*?)<\/style\s*>/gi)];
 for(let index=styles.length-1;index>=0;index--){const match=styles[index],css=await compile('app/__preview_inline_'+index+'.css','css',match[1]);html=html.slice(0,match.index)+store('<style>'+closeStyle(css)+'</style>')+html.slice(match.index+match[0].length)}
 const tags=[...html.matchAll(/<([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)];
 let bodyAttributes='';
 for(let index=tags.length-1;index>=0;index--){
  const match=tags[index],name=match[1].toLowerCase(),attrs=attributes(match[2]);let replacement;
  if(['script','iframe','frame','object','embed','base'].includes(name))throw fail('STANDARD_PREVIEW_HTML_INVALID');
  for(const key of [...attrs.keys()]){
   if(key.startsWith('on')||['nonce','srcdoc'].includes(key)){attrs.delete(key);continue}
   if(key==='style')attrs.set(key,attrs.get(key).replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,(_m,a,b,c)=>'url("'+asset('app/host.html',a??b??c)+'")'));
   if(['src','href','poster','data','action','formaction','xlink:href','background','manifest'].includes(key)&&!(name==='link'&&key==='href')){
    const value=attrs.get(key);if(value.startsWith('#')&&['href','xlink:href'].includes(key))continue;
    attrs.set(key,asset('app/host.html',value));
   }
   if(key==='srcset')attrs.set(key,attrs.get(key).split(',').map(item=>{const [source,...size]=item.trim().split(/\s+/);if(size.some(value=>!/^\d+(?:\.\d+)?[wx]$/.test(value)))throw fail('STANDARD_PREVIEW_ASSET_DENIED');return asset('app/host.html',source)+(size.length?' '+size.join(' '):'')}).join(', '));
  }
  if(name==='meta'||name==='html'||name==='head'||name==='body'){
   if(name==='body')bodyAttributes=renderAttributes(attrs);
   replacement='';
  }else if(name==='link'&&attrs.get('rel')?.toLowerCase()==='stylesheet'){
   const css=await compile(resolve('app/host.html',attrs.get('href')),'css');replacement='<style>'+closeStyle(css)+'</style>';
  }else{
   if(name==='link'&&attrs.has('href'))attrs.set('href',asset('app/host.html',attrs.get('href')));
   replacement='<'+name+renderAttributes(attrs)+'>';
  }
  html=html.slice(0,match.index)+replacement+html.slice(match.index+match[0].length);
 }
 html=html.replace(/<!doctype[^>]*>|<\/(?:html|head|body)\s*>/gi,'').replace(/<!--wanx-standard-block-(\d+)-->/g,(_m,index)=>blocks[Number(index)]);
 const boot=`const unavailable=()=>Promise.resolve({ok:false,code:'EXPERT_DEPLOYMENT_REQUIRED'});const callbacks=new Set();Object.defineProperty(window,'wanx',{value:Object.freeze({context:unavailable,expertContext:unavailable,expertInvoke:unavailable,listFiles:unavailable,onInvalidated:callback=>{if(typeof callback==='function'&&callbacks.size<32)callbacks.add(callback);return()=>callbacks.delete(callback)}}),writable:false,configurable:false});let connected=false;window.addEventListener('message',event=>{if(connected||event.source!==parent||event.data?.type!=='wanx:init'||!event.ports?.[0])return;connected=true;const port=event.ports[0],annotations=(${installPreviewAnnotations.toString()})(port);port.onmessage=({data})=>{annotations.receive(data)};for(const type of ['input','change'])document.addEventListener(type,()=>port.postMessage({type:'wanx:dirty',dirty:true}),true)});window.addEventListener('pagehide',()=>{for(const callback of callbacks)try{callback()}catch{}callbacks.clear()});`;
 const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
 const document='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><script>'+closeScript(boot)+'</script>'+importedStyles.map(css=>'<style>'+closeStyle(css)+'</style>').join('')+'</head><body'+bodyAttributes+'>'+html+'</body></html>';
 const output={format:STANDARD_LAYOUT_FORMAT,artifactHash:input.artifactHash,packageSha256:input.packageSha256,document};
 if(Buffer.byteLength(JSON.stringify(output))>STANDARD_LAYOUT_MAX_BYTES)throw fail('STANDARD_PREVIEW_LIMIT');
 return output;
}
