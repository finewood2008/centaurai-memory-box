import {compileStandardPreview} from '../core/standard-preview.mjs';
let text='';
try{
 for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>16*1024*1024)throw Object.assign(Error('STANDARD_PREVIEW_LIMIT'),{code:'STANDARD_PREVIEW_LIMIT'})}
 const result=await compileStandardPreview(JSON.parse(text),{delivery:process.argv.includes('--validate-delivery')});process.stdout.write(JSON.stringify(result));
}catch(error){process.stderr.write(/^[A-Z][A-Z0-9_]+$/.test(error?.code||'')?error.code:'STANDARD_PREVIEW_COMPILE_FAILED');process.exitCode=1}
