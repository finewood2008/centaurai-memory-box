// Read-only recovery: never resubmit a generation or publication from a timer.
export function createProgressPoller({current, active, schedule=setTimeout, cancel=clearTimeout}) {
  let timer=null, owner=null;
  const waiting=f=>f?.state.proposal?.status==='generating'||f?.state.pending?.action==='onboarding-generate';
  function stop(){if(timer!==null)cancel(timer);timer=null;owner=null;}
  function sync(){
    const f=current();
    if(!active()||!f?.live||!f.state.loaded||f.state.busy||f.state.error||!waiting(f)){stop();return;}
    if(timer!==null&&owner===f)return;
    stop();owner=f;
    timer=schedule(async()=>{
      timer=null;owner=null;
      if(current()!==f||!active()||!f.live||f.state.busy||!waiting(f))return;
      await f.refresh();
      if(current()===f)sync();
    },5000);
  }
  return {sync,stop};
}
