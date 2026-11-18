import {frameDocument} from './frame.mjs';
export const STANDARD_LAYOUT_FORMAT='wanx-standard-layout-v1';
export const STANDARD_LAYOUT_MAX_BYTES=12*1024*1024;
const fail=code=>Object.assign(new Error(code),{code});
export function previewDocument(response,artifactHash){
 if(response?.standardLayout!==undefined){
  const layout=response.standardLayout;
  if(!layout||Object.keys(layout).sort().join()!==['format','artifactHash','packageSha256','document'].sort().join()||layout.format!==STANDARD_LAYOUT_FORMAT||
   !/^[a-f0-9]{64}$/.test(layout.artifactHash)||layout.artifactHash!==artifactHash||!/^[a-f0-9]{64}$/.test(layout.packageSha256)||layout.packageSha256!==response.packageSha256||
   typeof layout.document!=='string'||!layout.document||new TextEncoder().encode(layout.document).length>STANDARD_LAYOUT_MAX_BYTES)throw fail('STANDARD_PREVIEW_INVALID');
  return {document:layout.document,layoutOnly:true};
 }
 if(response?.packageBase64||response?.manifest?.protocolVersion===3)throw fail('STANDARD_PREVIEW_REQUIRED');
 return {document:frameDocument(response.bundle,response.css),layoutOnly:false};
}
