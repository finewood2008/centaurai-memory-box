// Keep a delayed warehouse-list response from navigating a newer account/view.
export async function enterOnboardingWarehouse({warehouseId, readWarehouses, snapshot, select, commit, isCurrent}) {
  const before=snapshot();
  const available=()=>isCurrent() && snapshot().ready && !snapshot().invalid;
  if(!available()) throw new Error('HOST_SESSION_EXPIRED');
  const list=await readWarehouses();
  const current=snapshot();
  if(!available() || before.identity!==current.identity || before.generation!==current.generation)
    throw new Error('HOST_SESSION_EXPIRED');
  if(!list?.items?.some(w=>w.id===warehouseId && w.state==='active')) throw new Error('WAREHOUSE_UNAVAILABLE');
  commit(list.items);
  const selecting=select(warehouseId,'conversation');
  const generation=snapshot().generation;
  await selecting;
  const after=snapshot();
  if(!available() || after.identity!==before.identity || after.generation!==generation ||
    after.warehouseId!==warehouseId || after.view!=='conversation') throw new Error('WAREHOUSE_UNAVAILABLE');
}
