import{useEffect,useRef,useState}from'react';
import{previewDocument}from'../core/standard-frame.mjs';
import{api,errorText}from'./api';
import{createAnnotationChannel}from'./annotation-channel.mjs';
export type AnnotationMode='off'|'point'|'box';
export type AnnotationController={mode:(value:AnnotationMode)=>void;sync:(marks:{id:string;number:number}[])=>void;remove:(id:string)=>void;locate:(id:string)=>Promise<any>;capture:(id:string)=>Promise<{image:string;width:number;height:number;viewport:{width:number;height:number};region:{x:number;y:number;width:number;height:number}}>};
export type AnnotationSurface={onConnect:(controller:AnnotationController|null)=>void;onEvent:(event:any)=>void};
export function Runtime({projectId,artifactHash,environment='preview',readOnly=false,onDirtyChange,annotation}:{projectId:string;artifactHash:string;environment?:string;readOnly?:boolean;onDirtyChange?:(dirty:boolean)=>void;annotation?:AnnotationSurface}){
  const annotationRef=useRef(annotation),marking=useRef(false),readonlyRef=useRef(readOnly),annotationChannel=useRef<ReturnType<typeof createAnnotationChannel>|null>(null);annotationRef.current=annotation;readonlyRef.current=readOnly;
  const dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
  const[doc,setDoc]=useState('');
  const[loadError,setLoadError]=useState(''),[attempt,setAttempt]=useState(0);
  const[frameReady,setFrameReady]=useState(false),[layoutOnly,setLayoutOnly]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null),port=useRef<MessagePort|null>(null);
  useEffect(()=>{let active=true,token='';setDoc('');setLoadError('');setFrameReady(false);setLayoutOnly(false);
    dirtyCallback.current?.(false);
    api<{session:string;bundle?:string;css?:string;manifest?:{protocolVersion?:number};packageBase64?:string;packageSha256?:string;standardLayout?:unknown}>(`/projects/${projectId}/runtime`,'POST',{artifactHash,environment}).then(r=>{token=r.session;if(active){const rendered=previewDocument(r,artifactHash);setLayoutOnly(rendered.layoutOnly);setDoc(rendered.document)}else void api(`/runtime/${token}`,'DELETE').catch(()=>{})}).catch(e=>{if(active)setLoadError(errorText(e))});
    return()=>{active=false;annotationChannel.current?.dispose();annotationRef.current?.onConnect(null);port.current?.close();if(token)void api(`/runtime/${token}`,'DELETE').catch(()=>{})}
  },[projectId,artifactHash,environment,attempt]);
  function connect(){
    annotationChannel.current?.dispose();port.current?.close();const channel=new MessageChannel();port.current=channel.port1;
    const annotations=createAnnotationChannel(channel.port1,(event:any)=>{if(event.event==='mode')marking.current=event.mode!=='off';annotationRef.current?.onEvent(event)});annotationChannel.current=annotations;
    const controller:AnnotationController={mode:value=>{marking.current=value!=='off';annotations.command('mode',{mode:value})},sync:marks=>annotations.command('sync',{marks}),remove:id=>annotations.command('remove',{id}),locate:id=>annotations.request('locate',{id}),capture:async id=>{
      try{const prepared=await annotations.request('prepare',{id}) as {rect:{x:number;y:number;width:number;height:number};viewport:{width:number;height:number}};
       const node=frame.current;if(!node||!window.wanxStudio?.capturePreview)throw Error('PREVIEW_NOT_READY');
       const b=node.getBoundingClientRect(),x=Math.max(0,Math.ceil(b.left)),y=Math.max(0,Math.ceil(b.top)),width=Math.floor(Math.min(b.right,innerWidth))-x,height=Math.floor(Math.min(b.bottom,innerHeight))-y;
       const image=await window.wanxStudio.capturePreview({x,y,width,height});const valid=await annotations.request('validate',{id}) as {valid:boolean};if(!valid.valid)throw Error('VISUAL_REVIEW_STALE');
       const r=prepared.rect,sx=b.width/prepared.viewport.width,sy=b.height/prepared.viewport.height,left=Math.max(0,(b.left+r.x*sx-x)/width),top=Math.max(0,(b.top+r.y*sy-y)/height),right=Math.min(1,(b.left+(r.x+r.width)*sx-x)/width),bottom=Math.min(1,(b.top+(r.y+r.height)*sy-y)/height);
       if(right<=left||bottom<=top)throw Error('VISUAL_REVIEW_STALE');const rw=Math.max(.01,right-left),rh=Math.max(.01,bottom-top);
       return{...image,region:{x:Math.min(1-rw,left),y:Math.min(1-rh,top),width:rw,height:rh}};
      }finally{annotations.command('restore',{id})}
    }};
    channel.port1.onmessage=({data:message})=>{
      if(annotations.receive(message))return;
      if(message?.type==='wanx:dirty'&&message.dirty===true){dirtyCallback.current?.(true);return}
      if(Number.isSafeInteger(message?.id)&&typeof message.method==='string')channel.port1.postMessage({id:message.id,error:'EXPERT_DEPLOYMENT_REQUIRED'});
    };
    frame.current?.contentWindow?.postMessage({type:'wanx:init'},'*',[channel.port2]);
    annotationRef.current?.onConnect(controller);setFrameReady(true);
  }
  return <div className="runtime">{layoutOnly&&<div className="preview-test-notes" role="status"><strong>布局预览 · 不调用专家</strong><p>这里只展示当前版本的页面布局。页面内的 EXPERT_DEPLOYMENT_REQUIRED 或“初始化失败”提示可能来自预览限制，不代表盒子部署失败。</p><p>已部署：到“应用”打开对应的联调版或正式版验证。未部署：在“部署”中先部署到盒子。</p></div>}{doc?<iframe title="小应用预览" data-ready={frameReady} ref={frame} srcDoc={doc} sandbox="allow-scripts allow-forms" onLoad={connect}/>:<div className="preview-empty" role={loadError?'alert':'status'}>{loadError?<><h3>此版本暂时无法打开</h3><p>{loadError}</p><button className="primary" onClick={()=>setAttempt(n=>n+1)}>重新打开此版本</button><small>方案和版本记录仍然保留。</small></>:<>正在准备这个版本…<small>首次打开时正在建立独立试用环境。</small></>}</div>}</div>
}
