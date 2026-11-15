// Navigation locators carry no authorization; Starlink revalidates in the current account.
const views=new Set(['warehouses','conversation','materials','graph','search','tasks','sensitive','models','skills','reasoning','api','data']);
const resource=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function validStarlinkTarget(t){
  if(!t||typeof t!=='object'||Array.isArray(t)||t.kind!=='personal-data'||![1,2].includes(t.version)||
    !views.has(t.view)||t.warehouseId!==null&&(typeof t.warehouseId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(t.warehouseId)))return false;
  const keys=['kind','version','warehouseId','view',...(t.version===2?['documentId','conversationId','intentId']:[])];
  if(Object.keys(t).some(k=>!keys.includes(k)))return false;
  if(t.version===1)return true;
  return !!t.warehouseId&&['conversation','materials'].includes(t.view)&&resource(t.documentId)&&
    ((!Object.hasOwn(t,'conversationId')&&!Object.hasOwn(t,'intentId'))||(resource(t.conversationId)&&resource(t.intentId)));
}
