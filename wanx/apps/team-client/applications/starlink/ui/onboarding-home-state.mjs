import {OnboardingFlow} from './onboarding-state.mjs';
import {OnboardingDialogue} from './onboarding-dialogue-state.mjs';

// Read authoritative status before deciding to leave an unfinished dialogue.
// This probe never starts a session, generates an opening, or replays a write.
export async function shouldResumeDialogue(options){
  // Navigation reads must not overwrite a composer changed while GET is pending.
  const probe=new OnboardingDialogue({...options,storage:{getItem:key=>options.storage.getItem(key),setItem:()=>{}}});
  try{
    probe.restore();
    const s=probe.saved;
    if(s.pending||s.creation)return true;
    if(Array.isArray(options.warehouses)&&(!options.warehouses.some(w=>w.state==='active')||s.warehouse&&!options.warehouses.some(w=>w.id===s.warehouse.id&&w.state==='active')))return false;
    if(s.conversationId){await probe.snapshot();return probe.state.snapshot.status!=='published';}
    return !!(s.warehouse||s.name.trim()||s.input.trim());
  }catch{return true;}finally{probe.dispose();}
}

// The home page only lists warehouses and preserves outstanding creation
// receipts. Retired suggestion/context endpoints must not gate the new flow.
export class OnboardingHome extends OnboardingFlow {
  load(){return this.run(async()=>{
    this.state.loaded=false;this.restore();await this.readRoots();this.state.loaded=true;
  });}
  refresh(){if(!this.state.loaded)return this.load();return this.run(async()=>{
    this.state.loaded=false;await this.readRoots();this.state.loaded=true;
  });}
  async recoverContext(){}
  async create(){
    // Only recover a previously authorized creation; there is no new legacy flow.
    if(!this.state.creation||this.state.busy||!this.state.loaded)return;
    // An old needsReview flag must not prevent replaying the immutable request.
    this.state.needsReview=false;
    return super.create({generate:false});
  }
  async read(action,input={}){
    try{return await super.read(action,input);}catch(error){
      if(this.live&&['onboarding-save','onboarding-create'].includes(action)&&
        error.status===409&&['MODELING_REVISION_CHANGED','WAREHOUSE_NAME_CONFLICT'].includes(error.code)){
        // These are definite refusals before creation, unlike operation conflicts,
        // network failures or lost responses. Keep their envelope for diagnostics.
        try{this.storage.setItem(this.key+'.rejected-creation',JSON.stringify({creation:this.state.creation,pending:this.state.pending,code:error.code}));}
        catch{throw Object.assign(Error(),{code:'MODELING_LOCAL_SAVE_FAILED'});}
        this.state.creation=null;this.state.pending=null;
        this.state.notice='此前创建请求已被服务端拒绝，未执行本次创建。可通过新建仓对话重新命名并确认。';
      }
      throw error;
    }
  }
}
