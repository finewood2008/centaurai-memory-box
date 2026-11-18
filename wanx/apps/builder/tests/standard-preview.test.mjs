import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {previewDocument} from '../core/standard-frame.mjs';
import {compileStandardPreview} from '../core/standard-preview.mjs';
const encode=value=>Buffer.from(value).toString('base64');
const input=()=>({artifactHash:'a'.repeat(64),packageSha256:'b'.repeat(64),manifest:{applicationId:'dev.wanx.preview',protocolVersion:3,entrypoint:'shell/main.cjs'},files:{'app/host.html':encode('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src self"><link rel="stylesheet" href="style.css"></head><body><main id="status">Layout</main><script type="module" src="host.mjs"></script></body></html>'),'app/host.mjs':encode('import {label} from "./label.mjs";const answer=await window.wanx.expertContext();document.getElementById("status").textContent=label+answer.code;'),'app/label.mjs':encode('export const label="Preview:";'),'app/style.css':encode('main { color: #234; background-image: url("./pixel.png"); }'),'app/pixel.png':encode(Buffer.from([137,80,78,71]))}});

test('standard layout compiles the actual offline module graph and keeps top-level await without a legacy mount',async()=>{
 const source=input(),before=JSON.stringify(source),layout=await compileStandardPreview(source);
 assert.equal(JSON.stringify(source),before);assert.equal(layout.format,'wanx-standard-layout-v1');assert.equal(layout.artifactHash,source.artifactHash);assert.equal(layout.packageSha256,source.packageSha256);
 assert.match(layout.document,/connect-src 'none'/);assert.match(layout.document,/frame-src 'none'/);assert.match(layout.document,/form-action 'none'/);assert.match(layout.document,/script-src 'unsafe-inline'/);assert.doesNotMatch(layout.document,/nonce=|nonce-|unsafe-eval/);assert.match(layout.document,/data:image\/png;base64/);
 assert.doesNotMatch(layout.document,/WanxMiniapp|require\(.*electron|src="host.mjs"/);
 const classic=[...layout.document.matchAll(/<script(?: nonce="[^"]+")?>([\s\S]*?)<\/script>/g)][0][1];
 const module=[...layout.document.matchAll(/<script type="module"(?: nonce="[^"]+")?>([\s\S]*?)<\/script>/g)][0][1];
 const node={textContent:''},window={addEventListener(){}};const document={getElementById:()=>node,addEventListener(){}};
 vm.runInNewContext(classic,{window,document,parent:{},Promise,Object,Set});
 for(const method of ['context','expertContext','expertInvoke','listFiles'])assert.equal((await window.wanx[method]({operation:'expert.run',input:{}})).code,'EXPERT_DEPLOYMENT_REQUIRED');
 const previous={window:globalThis.window,document:globalThis.document};globalThis.window=window;globalThis.document=document;
 try{await import('data:text/javascript;base64,'+Buffer.from(module).toString('base64'));assert.equal(node.textContent,'Preview:EXPERT_DEPLOYMENT_REQUIRED')}finally{globalThis.window=previous.window;globalThis.document=previous.document}
});


test('unresolvable dynamic imports cannot become runtime network or filesystem loaders',async()=>{
 const source=input();source.files['app/host.mjs']=encode('const next=window.location.hash.slice(1);await import(next);');
 await assert.rejects(compileStandardPreview(source));
});


test('renderer module CSS imports stay inside the offline virtual asset graph',async()=>{
 const source=input();source.files['app/host.mjs']=encode('import "./style.css";document.getElementById("status").textContent="Layout";');
 const layout=await compileStandardPreview(source);assert.match(layout.document,/color: #234/);assert.match(layout.document,/data:image\/png;base64/);
});


test('preview rejects Node, bare, network, query and escaping imports before any external resolver',async t=>{
 for(const spec of ['node:fs','react','https://example.invalid/a.mjs','file:///etc/passwd','../../secret.mjs','./label.mjs?token=other'])await t.test(spec,async()=>{const source=input();source.files['app/host.mjs']=encode('import '+JSON.stringify(spec)+';');await assert.rejects(compileStandardPreview(source))});
 for(const html of ['<script type="module" src="https://example.invalid/app.mjs"></script>','<img src="https://example.invalid/track">','<base href="https://example.invalid/">','<iframe src="https://example.invalid/"></iframe>','<style>main{background:url(https://example.invalid/track)}</style>']){
  const source=input();source.files['app/host.html']=encode(html);await assert.rejects(compileStandardPreview(source));
 }
});

test('preview VFS rejects outside-app files, noncanonical base64 and bounded resource violations',async()=>{
 for(const mutate of [s=>{s.files['shell/main.cjs']=encode('throw Error("must never execute")')},s=>{s.files['app/../secret']=encode('private')},s=>{s.files['app/host.mjs']='not-base64!'},s=>{s.files['app/host.mjs']=encode('x'.repeat(2*1024*1024+1))},s=>{for(let i=0;i<257;i++)s.files['app/extra'+i]=encode('')},s=>{s.packageSha256='wrong'}]){
  const source=input();mutate(source);await assert.rejects(compileStandardPreview(source));
 }
});


test('runtime document selection binds standard layout to its exact artifact/package and never falls back to miniapp',async()=>{
 const source=input(),layout=await compileStandardPreview(source),response={standardLayout:layout,packageSha256:source.packageSha256};
 assert.equal(previewDocument(response,source.artifactHash).layoutOnly,true);
 for(const patch of [{artifactHash:'c'.repeat(64)},{packageSha256:'c'.repeat(64)},{format:'legacy'},{document:null}])assert.throws(()=>previewDocument({...response,standardLayout:{...layout,...patch}},source.artifactHash),/STANDARD_PREVIEW_INVALID/);
 assert.throws(()=>previewDocument({manifest:{protocolVersion:3},packageBase64:'unchanged-original-package'},source.artifactHash),/STANDARD_PREVIEW_REQUIRED/);
});

test('actual compiler CLI consumes only JSON stdin and emits the explicit standard layout wire',async()=>{
 const source=input(),child=spawn(process.execPath,[new URL('../tools/compile-standard-preview.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
 const stdout=[],stderr=[];child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code))});child.stdin.end(JSON.stringify(source));
 assert.equal(await exited,0);assert.equal(Buffer.concat(stderr).toString(),'');
 const output=JSON.parse(Buffer.concat(stdout));assert.deepEqual(Object.keys(output).sort(),['format','artifactHash','packageSha256','document'].sort());
 assert.equal(output.artifactHash,source.artifactHash);assert.equal(output.packageSha256,source.packageSha256);assert.equal(previewDocument({standardLayout:output,packageSha256:source.packageSha256},source.artifactHash).layoutOnly,true);
});


test('offline standard frame permits inline code without authorizing external nonce, hash or URL script sources',async()=>{
 const layout=await compileStandardPreview(input());
 const policy=layout.document.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
 const scriptSources=policy.match(/(?:^|;)\s*script-src\s+([^;]+)/)[1];
 assert.equal(scriptSources,"'unsafe-inline'");
 assert.doesNotMatch(scriptSources,/nonce-|sha(?:256|384|512)-|https?:|data:|blob:|unsafe-eval|strict-dynamic/);
 assert.match(policy,/style-src 'unsafe-inline'/);assert.match(policy,/connect-src 'none'/);assert.match(policy,/frame-src 'none'/);assert.match(policy,/form-action 'none'/);
});

// Layout bundling may accept forms that raw browser delivery cannot execute.
// The submission/build gate must enforce native module loading semantics.
test('delivery validation rejects bundler-only imports and accepts native JSON attributes',async()=>{
 const cases=[
  ['import "./style.css";','STANDARD_DELIVERY_LINK_CSS_REQUIRED'],
  ['import value from "./config.json";console.log(value);','STANDARD_DELIVERY_JSON_ATTRIBUTE_REQUIRED'],
  ['import image from "./pixel.png";console.log(image);','STANDARD_DELIVERY_ASSET_REFERENCE_REQUIRED'],
  ['const value=require("./label.mjs");console.log(value);','STANDARD_DELIVERY_ES_MODULE_REQUIRED'],
 ];
 for(const [code,expected] of cases){
  const source=input();source.files['app/config.json']=encode('{"title":"Native JSON"}');source.files['app/host.mjs']=encode(code);
  await assert.rejects(compileStandardPreview(source,{delivery:true}),{code:expected});
 }
 const source=input();source.files['app/config.json']=encode('{"title":"Native JSON"}');source.files['app/host.mjs']=encode('import config from "./config.json" with {type:"json"};document.getElementById("status").textContent=config.title;');
 assert.match((await compileStandardPreview(source,{delivery:true})).document,/Native JSON/);
});
