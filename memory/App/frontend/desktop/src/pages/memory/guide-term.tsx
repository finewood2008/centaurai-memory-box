import {concepts, guideMark} from '../../../../../../../wanx/apps/starlink/shared/application-guide.mjs';

export function GuideTerm({name}: {name: string}) {
  const term = concepts.get(name);
  if (!term || typeof window === 'undefined' || window.location.protocol !== 'wanx-memory:' || window.parent === window) return null;
  return <button type="button" aria-label={'让 CentaurAI 解释'+term.label}
    style={{border:0,background:'transparent',color:'#906e49',padding:3,cursor:'pointer'}}
    onClick={()=>window.parent.postMessage({type:'wanx-guide-ask',key:name},'*')}><span aria-hidden="true">{guideMark}</span></button>;
}
