// One finite metadata mutation shared by personal and team service adapters.
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fail=code=>Object.assign(Error(code),{code});
export function validatedWarehouseRename(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).some(key=>!['warehouseId','name','operationId'].includes(key))||
      typeof input.warehouseId!=='string'||!UUID.test(input.warehouseId)||
      typeof input.operationId!=='string'||!UUID.test(input.operationId))throw fail('TEAM_DATA_TARGET_INVALID');
  if(typeof input.name!=='string')throw fail('WAREHOUSE_INVALID_NAME');
  const name=input.name.trim();
  if(!name||[...name].length>60||/[\u0000-\u001f\u007f-\u009f]/u.test(input.name))throw fail('WAREHOUSE_INVALID_NAME');
  return {warehouseId:input.warehouseId,name,operationId:input.operationId};
}
