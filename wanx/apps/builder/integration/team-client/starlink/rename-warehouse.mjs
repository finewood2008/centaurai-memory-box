import {warehouseInput} from './quick-warehouse.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

// A lost rename receipt must retry its original target, name and operation.
export function createWarehouseRenameJournal(getStorage){
  const key=(scope,id)=>{
    if(!scope||!uuid(id))throw Error('WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE');
    return 'wanx.warehouse-rename:'+scope+':'+id;
  };
  const storage=()=>typeof getStorage==='function'?getStorage():getStorage;
  const validate=(value,id)=>{
    if(value===null)return null;
    if(!value||Object.keys(value).some(k=>!['input','saved'].includes(k))||typeof value.saved!=='boolean'
      ||!value.input||Object.keys(value.input).sort().join(',')!=='name,operationId,warehouseId'
      ||value.input.warehouseId!==id||!uuid(value.input.operationId)
      ||typeof value.input.name!=='string'||warehouseInput(value.input.name,'').name!==value.input.name)throw Error();
    return value;
  };
  return {
    read(scope,id){
      try{return validate(JSON.parse(storage().getItem(key(scope,id))||'null'),id)}
      catch{throw Error('WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE')}
    },
    write(scope,id,value){
      try{validate(value,id);storage().setItem(key(scope,id),JSON.stringify(value))}
      catch{throw Error('WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE')}
    },
    clear(scope,id){
      try{storage().removeItem(key(scope,id))}
      catch{throw Error('WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE')}
    },
  };
}
