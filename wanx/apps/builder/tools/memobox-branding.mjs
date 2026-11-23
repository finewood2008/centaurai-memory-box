// Product copy only: shared WanX sources stay unchanged. Used by personal builds.
import ts from 'typescript';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';

const copy = [
 ['半人马AI 私人记忆盒子','半人马AI记忆盒子'], ['半人马AI-记忆盒子','半人马AI记忆盒子'],
 ['半人马·万象·星图','知识星图'], ['半人马AI-万象','半人马AI记忆盒子'],
 ['CentaurAI-WANX','CentaurAI MemoBox'], ['CentaurAI-MemoBox','CentaurAI MemoBox'], ['CentaurAI-WanX','CentaurAI MemoBox'],
 ['万象·星图','知识星图'], ['万象星图','知识星图'], ['万象·对话','AI 对话'],
 ['万象小助理','AI 助手'], ['万象工坊','应用工坊'], ['万象·开物','应用工坊'],
 ['万象AI浏览器','AI 浏览器'], ['万象空间','文件空间'], ['万象盒子','盒子'],
 ['万象盒端模型','盒子模型'], ['万象盒端','盒子'], ['万象默认','默认'],
 ['万象平台账号','云账号'], ['万象账号','云账号'], ['万象平台','云账号服务'],
 ['万象用户','用户'], ['万象积分','账户积分'], ['万象与盒子','账号与设备'],
 ['本机万象','这台电脑'], ['万象网络','盒子连接'], ['万象占用','应用与服务占用'],
 ['万象客户端','记忆盒子'], ['万象底座','记忆盒子服务'], ['万象主机','设备'],
 ['万象模型','模型'], ['万象连接','记忆盒子连接'], ['万象运维','设备维护'],
 ['万象 · 本地安全','本地身份与设备权限'], ['万象应用','AI 应用'],
 ['WanX·Starlink','Starlink'], ['WanX Workshop','App Workshop'],
 ['WanX Space','Files'], ['WanX Apps','Apps'], ['WanX Box','Devices'],
 ['WanX Builder','App Workshop'], ['WANX HELP','帮助中心'],
 ['WANX Weekly Report local trial','MemoBox Weekly Report local trial'], ['WANX 默认模型','默认模型'], ['WANX 模型','模型'], ['WANX default','default'],
 ['Powered by WANX',''], ['Powered by WanX',''], ['powered by wanx',''],
 ['native WANX instance','native box service'], ['Native WANX capabilities','Box capabilities'],
 ['Minimum WANX version','Minimum box service version'], ['WANX account identity','cloud account identity'], ['WANX user ID','User ID'], ['connection in WANX','connection in MemoBox'],
];
// These are existing filesystem/registry identities, not display copy.
const legacyIdentities = new Set(['万象.app','半人马AI-万象.app','万象记忆库']);
export function memoboxCopy(text) {
 text=text.replace(/\\u([0-9a-f]{4})/gi,(escape,hex)=>{const char=String.fromCharCode(parseInt(hex,16));return /[\u3400-\u9fff]/.test(char)?char:escape;});
 for (const [from,to] of copy) text=text.replaceAll(from,to);
 if (/[\u3400-\u9fff]/.test(text)) text=text.replace(/\b(?:WANX|WanX)\b/g,'记忆盒子');
 return text.replaceAll('万象','记忆盒子').replaceAll('萬象','记忆盒子');
}
const templateText = value => value.replaceAll('\\','\\\\').replaceAll('`','\\`').replaceAll('${','\\${');
export function memoboxSource(source, filename='source.js') {
 if (!/\.[cm]?[jt]sx?$|\.json$/i.test(filename)) return memoboxCopy(source);
 const kind=filename.endsWith('.tsx')?ts.ScriptKind.TSX:filename.endsWith('.json')?ts.ScriptKind.JSON:ts.ScriptKind.JS;
 const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,kind),edits=[];
 function visit(node) {
  const literal=ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node);
  if(literal||ts.isJsxText(node)) {
   const parent=node.parent;
   const key=parent&&((ts.isPropertyAssignment(parent)&&parent.name===node)||ts.isImportDeclaration(parent)||ts.isExportDeclaration(parent));
   const identity=legacyIdentities.has(node.text)||parent&&ts.isVariableDeclaration(parent)&&['loginName','legacyLoginName'].includes(parent.name.getText(file));
   if(!key&&!identity) {
    const value=memoboxCopy(node.text);
    if(value!==node.text) {
     const replacement=ts.isStringLiteral(node)?JSON.stringify(value):ts.isNoSubstitutionTemplateLiteral(node)?'`'+templateText(value)+'`':ts.isTemplateHead(node)?'`'+templateText(value)+'${':ts.isTemplateMiddle(node)?'}'+templateText(value)+'${':ts.isTemplateTail(node)?'}'+templateText(value)+'`':value;
     edits.push({start:node.getStart(file),end:node.getEnd(),replacement});
    }
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(file);
 for(const edit of edits.sort((a,b)=>b.start-a.start)) source=source.slice(0,edit.start)+edit.replacement+source.slice(edit.end);
 return source;
}
export async function brandMemoboxTree(directory) {
 for(const entry of await readdir(directory,{withFileTypes:true})) {
  if(['node_modules','vendor','wanx-app-kit'].includes(entry.name))continue;
  const file=path.join(directory,entry.name);
  if(entry.isDirectory())await brandMemoboxTree(file);
  else if(entry.isFile()&&/\.(?:[cm]?js|html|json)$/i.test(file)&&!/(?:lock|source|receipt|hash|kit)\.json$/.test(file)) {
   const source=await readFile(file,'utf8'),branded=memoboxSource(source,file);
   if(source!==branded)await writeFile(file,branded);
  }
 }
}
export const memoboxBuildPlugin = () => ({
 name:'memobox-product-copy',
 setup(build) {
 build.onLoad({filter:/\.[cm]?[jt]sx?$/},async ({path:filename})=>{
  if(/[\\/]node_modules[\\/]/.test(filename))return;
  const source=await readFile(filename,'utf8'),contents=memoboxSource(source,filename);
  if(contents!==source)return {contents,loader:filename.endsWith('.tsx')?'tsx':filename.endsWith('.ts')?'ts':'js'};
 });},
});
