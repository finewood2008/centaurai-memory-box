import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {packTemplate} from '../templates/pack.mjs';
import {compileArtifact,frameDocument} from '../core/artifact.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
export async function buildZhikeTemplate(out=path.join(root,'dist/zhike-template')){
  const directory=path.join(root,'templates/zhike');
  const source=await packTemplate(directory,{applicationId:'centaurai.wanx.template.zhike',version:'0.12.1'});
  const artifact=await compileArtifact(source.files);
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'frame.html'),frameDocument(artifact.bundle,artifact.css));
  await writeFile(path.join(out,'compiled.json'),JSON.stringify(artifact));
  await writeFile(path.join(out,'wanx.editable.json'),JSON.stringify(source,null,2)+'\n');
  return {directory,out,sourceHash:source.sourceHash,files:Object.keys(source.files).length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildZhikeTemplate()));
