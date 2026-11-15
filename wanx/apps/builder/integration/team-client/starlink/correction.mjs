export function validatedDeletion(input){
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
 if(!input||Object.keys(input).some(k=>!['warehouseId','id','versionId','operationId','confirmed'].includes(k))||!['warehouseId','id','operationId'].every(k=>uuid(input[k]))||input.versionId!==null&&!uuid(input.versionId)||input.confirmed!==true)throw Object.assign(Error('TEAM_DATA_TARGET_INVALID'),{code:'TEAM_DATA_TARGET_INVALID'});
 return input;
}
export function validatedCorrection(input){
 const fail=()=>{throw Object.assign(Error('TEAM_DATA_TARGET_INVALID'),{code:'TEAM_DATA_TARGET_INVALID'})};
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['warehouseId','id','versionId','operationId','segments'].includes(k))||!['warehouseId','id','versionId','operationId'].every(k=>uuid(input[k]))||!Array.isArray(input.segments)||!input.segments.length||input.segments.length>2000)fail();
 const ids=new Set();let bytes=0;
 for(const segment of input.segments){if(!segment||Object.keys(segment).some(k=>!['id','text'].includes(k))||!uuid(segment.id)||ids.has(segment.id)||typeof segment.text!=='string'||segment.text.includes('\0'))fail();ids.add(segment.id);bytes+=new TextEncoder().encode(segment.text).length;if(bytes>768*1024)fail()}
 return {...input,segments:input.segments.map(s=>({id:s.id,text:s.text}))};
}
