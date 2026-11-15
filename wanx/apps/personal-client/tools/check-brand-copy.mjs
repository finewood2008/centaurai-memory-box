// Product copy only. Protocol identifiers and existing data paths remain stable.
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const ts=createRequire(new URL('../../builder/package.json',import.meta.url))('typescript');
const root=fileURLToPath(new URL('../',import.meta.url));
const legacy={
 'shell/main.mjs':new Set(['万象记忆库']),
 'shell/space-local-memory.mjs':new Set(['万象记忆库']),
 'shell/startup.mjs':new Set(['万象.app','万象']),
 'shell/package-win.mjs':new Set(['WANX','WANX.exe']),
};
const issues=[];let files=0;
const oldBrand=/万象|萬象|\b(?:WanX|WANX)(?![a-zA-Z0-9_-])/;
async function scan(relative) {
 for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
  if(['node_modules','vendor','wanx-app-kit'].includes(entry.name))continue;
  const file=path.posix.join(relative,entry.name);
  if(file.startsWith('local-ui/renderer/assets/') && entry.name==='prompts.json')continue;
  if(entry.isDirectory())await scan(file);
  else if(entry.isFile()&&/\.(?:[cm]?js|html|json|nsh)$/.test(file)) {
   files++;
   const source=await readFile(path.join(root,file),'utf8');
   if(/\.(?:html|nsh)$/.test(file)){source.split('\n').forEach((text,index)=>{if(oldBrand.test(text))issues.push(`${file}:${index+1}`)});continue;}
   const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.json')?ts.ScriptKind.JSON:ts.ScriptKind.JS);
   function visit(node) {
    if((ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node))&&oldBrand.test(node.text)&&!legacy[file]?.has(node.text))issues.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1}`);
    ts.forEachChild(node,visit);
   }
   visit(ast);
  }
 }
}
for(const folder of ['local-ui','shell','account','device-trust','applications','updates'])await scan(folder);
console.log(JSON.stringify({files,violations:[...new Set(issues)]},null,2));
if(issues.length)process.exitCode=1;
