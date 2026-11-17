(() => {
  const panelMode=document.body.dataset.noteSurface==='panel';
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${({close:'<path d="m6 6 12 12M6 18 18 6"/>',image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',back:'<path d="m14 5-7 7 7 7"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'})[name]||''}</svg>`;
  const messages={CLIPBOARD_IMAGES_ONLY:'这里只接收文字和图片，普通文件请上传到空间。',CLIPBOARD_LIMIT:'一次最多20张图片，单张最大20 MB；本批内容未加入。',CLIPBOARD_NOTE_LIMIT:'便签文字和结构最多1 MB，请精简后继续。',CLIPBOARD_NOTE_BUSY:'请等待当前内容同步完成后再操作。',CLIPBOARD_VIRTUAL_FILE:'请粘贴截图或已保存到本机的图片。',CLIPBOARD_EMPTY:'没有可粘贴的文字或图片。',SPACE_CONTEXT_CHANGED:'账号或盒子已切换，本次操作已停止。',ACCOUNT_LOGIN_REQUIRED:'请先登录并选择盒子。',BOX_CONNECTION_REQUIRED:'请先选择要保存到的盒子。',CLIPBOARD_NOTE_CONFLICT:'其他设备已修改便签，本机草稿已保留。',CLIPBOARD_CACHE_FULL:'本机缓存已满，请先完成图片同步。',SECURE_STORAGE_WRITE_FAILED:'本机草稿保存失败，请保持窗口打开后重试。',CLIPBOARD_QUOTA:'盒子便签空间不足，本机草稿仍保留。'};
  let host=null,state={items:[],tasks:[]},container=null,opened=false,active=false,poll=null,closeTimer=null,writing=Promise.resolve(true),localEdits=0,renderedScope=null,rendered='',composing=null,selection=null,error='',returnFocus=null;
  let requestSidebar=null,sidebarHost=null,viewGeneration=0,resolveComposition=null,saveError='';
  const pendingInsertions=new Set();
  const urls=new Map(),imageLoads=new Set();let lastPersist='',modalAction=null,contextGeneration=0,imageDialog=null,imageMenu=null;
  const message=e=>messages[e.code||e.message]||'暂未同步到盒子，本机草稿会保留并自动重试。';
  const editor=()=>container?.querySelector('.clipboard-note-editor');
  const boxName=()=>host?.devices?.find(d=>d.deviceId===state.boxId)?.displayName||host?.connection?.name||'上次连接的盒子';
  async function call(method,input={}){const scope=state.scope,generation=contextGeneration,r=await window.wanxClient.action('clipboard.'+method,{...input,scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});if(scope!==state.scope||generation!==contextGeneration)throw Object.assign(Error('SPACE_CONTEXT_CHANGED'),{code:'SPACE_CONTEXT_CHANGED'});return r.value;}
  function blocks(){
    const output=[];let text='';
    const flush=()=>{if(text){output.push({type:'text',text});text='';}};
    const isLine=node=>node?.nodeType===1&&['DIV','P'].includes(node.tagName);
    const walk=node=>{
      const previous=node.previousSibling;
      if(previous&&(isLine(node)||isLine(previous))&&previous.nodeName!=='BR'&&previous.nodeName!=='FIGURE')text+='\n';
      if(node.nodeType===3){text+=node.textContent;return;}
      if(node.nodeType!==1)return;
      if(node.matches('figure[data-item]')){flush();output.push({type:'image',item:node.dataset.item});return;}
      if(node.tagName==='BR'){
        // Chromium adds a terminal BR as a caret placeholder, not another text line.
        if(!node.nextSibling&&(!previous||['BR','FIGURE'].includes(previous.nodeName)))return;
        text+='\n';return;
      }
      for(const child of node.childNodes)walk(child);
    };
    for(const child of editor().childNodes)walk(child);flush();
    // Chromium leaves a lone BR in an otherwise empty editor.
    if(output.length===1&&output[0].type==='text'&&output[0].text==='\n'&&editor().textContent==='')return [];
    return output;
  }
  function rememberSelection(){const s=window.getSelection();if(s?.rangeCount&&editor()?.contains(s.anchorNode))selection=s.getRangeAt(0).cloneRange();}
  function placeSelection(){const e=editor();e.focus({preventScroll:true});const s=window.getSelection();if(selection&&e.contains(selection.startContainer)){s.removeAllRanges();s.addRange(selection);}else{const r=document.createRange();r.selectNodeContents(e);r.collapse(false);s.removeAllRanges();s.addRange(r);}}
  function finishComposition(){resolveComposition?.();resolveComposition=null;composing=null;}
  function persistEditor(force=false){
    if(!editor()||!state.scope)return writing;
    const value=blocks(),tag=JSON.stringify(value),bound=state.scope,generation=contextGeneration;
    if(!force&&tag===lastPersist)return writing;lastPersist=tag;localEdits++;
    writing=writing.catch(()=>{}).then(async()=>{
      try{
        if(bound!==state.scope||generation!==contextGeneration)return true;
        state=await call('note-save',{blocks:value});saveError='';error='';return true;
      }catch(e){
        if(bound!==state.scope||generation!==contextGeneration)return true;
        saveError=panelMode?message(e):messages[e.code||e.message]||messages.SECURE_STORAGE_WRITE_FAILED;
        if(tag===lastPersist)lastPersist='';return false;
      }
      finally{localEdits--;paint(false);}
    });return writing;
  }
  async function imageAsset(id){
    if(urls.has(id))return urls.get(id);
    const r=await call('preview',{id});
    const asset={url:URL.createObjectURL(new Blob([Uint8Array.from(atob(r.data),c=>c.charCodeAt(0))],{type:r.item.mime})),name:r.item.name||'便签图片'};
    // A thumbnail request and an explicit open can finish together.
    if(urls.has(id))URL.revokeObjectURL(asset.url);else urls.set(id,asset);
    return urls.get(id);
  }
  async function loadImages(){
    for(const img of editor()?.querySelectorAll('img[data-item]')||[]){const id=img.dataset.item;if(imageLoads.has(id))continue;imageLoads.add(id);
      try{const asset=await imageAsset(id);img.src=asset.url;img.alt=asset.name;img.closest('figure').classList.add('is-ready');}catch{}finally{imageLoads.delete(id);}
    }
  }
  function closeImageMenu(){imageMenu?.remove();imageMenu=null;}
  function closeImagePreview(){imageDialog?.close();imageDialog?.remove();imageDialog=null;}
  function closeImageUI(){closeImageMenu();closeImagePreview();}
  function imageTarget(target){return target.closest?.('.clipboard-note-editor figure[data-item], .clipboard-image-preview img[data-item]');}
  async function showImage(id){
    const generation=viewGeneration,scope=state.scope,asset=await imageAsset(id);if(!opened||generation!==viewGeneration||scope!==state.scope)return;
    closeImagePreview();const d=document.createElement('dialog');imageDialog=d;d.className='clipboard-image-preview';d.setAttribute('aria-label','查看便签图片');
    d.innerHTML=`<header><strong>${esc(asset.name)}</strong><div><button class="button" data-clip="image-download" data-id="${id}">下载图片</button><button class="button" data-clip="image-copy" data-id="${id}">复制图片</button><button class="button" data-clip="image-close" aria-label="关闭图片预览">关闭</button></div></header><div class="clipboard-image-canvas"><img data-item="${id}" src="${esc(asset.url)}" alt="${esc(asset.name)}"></div><p class="clipboard-image-status" role="status"></p>`;
    d.addEventListener('cancel',event=>{event.preventDefault();closeImagePreview();});
    container.append(d);d.showModal();
  }
  function showImageMenu(event,id){
    closeImageMenu();const m=document.createElement('div');imageMenu=m;m.className='clipboard-image-menu';m.popover='manual';m.setAttribute('role','menu');m.setAttribute('aria-label','便签图片操作');
    m.innerHTML=`${[['image-view','查看图片'],['image-download','下载图片…'],['image-copy','复制图片']].map(([action,label])=>`<button role="menuitem" data-clip="${action}" data-id="${id}">${label}</button>`).join('')}`;
    // Keep the menu in the modal top layer while viewing a full-size image.
    (imageDialog||container).append(m);m.showPopover();const r=m.getBoundingClientRect();m.style.left=Math.max(8,Math.min(event.clientX,window.innerWidth-r.width-8))+'px';m.style.top=Math.max(8,Math.min(event.clientY,window.innerHeight-r.height-8))+'px';m.querySelector('button').focus({preventScroll:true});
  }
  function renderNote(){
    const e=editor(),note=state.note;if(!e||!note)return;
    const content=JSON.stringify(note.blocks||[]),sameScope=renderedScope===state.scope;
    if(sameScope&&(composing||localEdits||saveError))return;
    if(sameScope&&JSON.stringify(blocks())===content){rendered=content;void loadImages();return;}
    if(sameScope&&content===rendered)return;
    if(sameScope&&document.hasFocus()&&document.activeElement===e&&JSON.stringify(blocks())!==content&&note.phase!=='saved')return;
    const focused=document.activeElement===e;e.replaceChildren();
    for(const b of note.blocks||[]){if(b.type==='text')e.append(document.createTextNode(b.text));else{const f=document.createElement('figure');f.contentEditable='false';f.dataset.item=b.item;f.tabIndex=0;f.setAttribute('role','button');f.setAttribute('aria-label','查看便签图片');f.innerHTML=`<img data-item="${b.item}" alt="图片正在准备"><span>图片</span>`;e.append(f);}}
    if(e.lastChild?.nodeName==='FIGURE')e.append(document.createElement('br'));
    renderedScope=state.scope;rendered=content;lastPersist=content;selection=null;
    if(focused){const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);}
    void loadImages();
  }
  function update(next){
    if(host?.route==='auth'&&next.scope)return;
    if(host?.dataIdentity?.profileId&&(!host.dataOwnerId||next.dataOwnerId!==host.dataOwnerId||next.dataContextId!==host.dataContextId))return;
    if(!host?.dataIdentity?.profileId&&host?.activeDeviceId&&next.boxId&&next.boxId!==host.activeDeviceId)return;
    if(next.scope!==state.scope){
      closeImageUI();finishComposition();for(const u of urls.values())URL.revokeObjectURL(u.url);urls.clear();
      selection=null;renderedScope=null;lastPersist='';saveError='';error='';writing=Promise.resolve(true);editor()?.replaceChildren();
    }
    if(next.note?.phase==='saved'&&error===message({code:'ECONNREFUSED'}))error='';
    state=next;paint();
  }
  function paint(render=true){
    if(!container||!opened)return;
    if(render)renderNote();
    const n=state.note||{};
    container.querySelector('.clipboard-connection').textContent=boxName()+' · 共享便签';
    container.querySelector('.clipboard-connection').classList.toggle('is-online',!!state.online);
    const status=container.querySelector('.clipboard-note-status');
    status.textContent=localEdits?'正在保存到本机…':saveError?'本机保存失败，请重试':n.phase==='locked'?'请先登录并选择盒子':n.phase==='conflict'?'本机草稿已保留 · 有版本冲突':n.revision===null&&!n.dirty&&!n.pending?'等待读取盒子便签':n.phase==='offline'?'已保存到本机 · 等待连接':n.phase==='syncing'?n.error?'已保存到本机 · 正在重试同步':'已保存到本机 · 正在同步':state.online?'已同步到盒子':'已保存到本机';
    const notice=container.querySelector('.clipboard-note-error');notice.textContent=saveError||error||(n.error&&n.error!=='CLIPBOARD_NOTE_CONFLICT'?message({code:n.error}):'');
    container.querySelector('.clipboard-note-conflict').hidden=!n.conflict;
    container.querySelector('[data-clip="restore"]').hidden=!n.has_backup;
    container.querySelector('[data-clip="recover-local"]').hidden=!n.recovery;
    editor().contentEditable=state.scope?'true':'false';
    container.querySelector('.clipboard-note-transfers').innerHTML=(state.tasks||[]).filter(t=>t.kind==='image').map(t=>`<div class="clipboard-note-transfer"><span title="${esc(t.name)}">${esc(t.name)}</span><small>${t.phase==='paused'?'已暂停':t.phase==='failed'?'同步失败':Math.floor((t.offset||0)/Math.max(1,t.size)*100)+'%'}</small><button data-clip="${['paused','failed'].includes(t.phase)?'resume':'pause'}" data-id="${t.id}">${['paused','failed'].includes(t.phase)?'继续':'暂停'}</button><progress value="${t.offset||0}" max="${t.size||1}"></progress></div>`).join('');
    const hasText=blocks().some(b=>b.type==='text'&&b.text.length);editor().classList.toggle('is-empty',!hasText&&!editor().querySelector('figure'));
  }
  function insertText(text){placeSelection();document.execCommand('insertText',false,text);rememberSelection();void persistEditor();}
  function insertImages(run){
    const pending=applyInsertion(run);
    pendingInsertions.add(pending);
    return pending.finally(()=>pendingInsertions.delete(pending));
  }
  async function applyInsertion(run){
    rememberSelection();const bound=state.scope,generation=viewGeneration;
    const current=()=>opened&&bound===state.scope&&generation===viewGeneration;
    try{const r=await run();if(!current()||!r)return;state=r;
      if(typeof r.text==='string'){insertText(r.text);return;}
      const images=(r.captured||[]).filter(i=>i.kind==='image');if(!images.length)return;
      placeSelection();document.execCommand('insertHTML',false,images.map(i=>`<figure contenteditable="false" tabindex="0" role="button" aria-label="查看便签图片" data-item="${i.id}"><img data-item="${i.id}" alt="${esc(i.name)}"><span>图片</span></figure>`).join('')+'<br>');const last=editor().querySelector(`figure[data-item="${images.at(-1).id}"]`);if(last){const paragraph=document.createElement('div');paragraph.append(document.createElement('br'));if(last.nextSibling?.nodeName==='BR')last.nextSibling.replaceWith(paragraph);else last.after(paragraph);const range=document.createRange();range.setStart(paragraph,0);range.collapse(true);const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);}rememberSelection();await persistEditor();
      if(current()){void loadImages();error='';}
    }catch(e){if(current())error=message(e);}if(current())paint(false);
  }
  async function paste(event){
    if(event){event.preventDefault();event.stopPropagation();const files=Array.from(event.clipboardData?.files||[]);
      if(files.length)return insertImages(async()=>{const r=await window.wanxClient.clipboardFiles(files,{scope:state.scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});return r.value;});
      const text=event.clipboardData?.getData('text/plain');if(text&&!Array.from(event.clipboardData?.types||[]).includes('text/uri-list'))return insertText(text);
    }
    // OS-native paste is needed for copied Finder/Explorer images and screenshots.
    return insertImages(()=>call('note-paste'));
  }
  function confirmAction(action,text){modalAction=action;container.querySelector('.clipboard-note-modal').innerHTML=`<div class="clipboard-modal-shade"><section role="dialog" aria-modal="true"><h3>${text}</h3><p>当前内容会保留，可在更多菜单中恢复。</p><button class="button primary" data-clip="confirm">确定</button><button class="text-button" data-clip="cancel-dialog">取消</button></section></div>`;}
  async function action(action,button){
    error='';container.querySelector('details').open=false;closeImageMenu();
    if(action==='image-close'){closeImagePreview();return;}
    if(action==='image-view')return showImage(button.dataset.id);
    if(action==='image-download'||action==='image-copy'){
      const r=await call(action==='image-download'?'download':'copy',{id:button.dataset.id});
      if(imageDialog)imageDialog.querySelector('.clipboard-image-status').textContent=r.canceled?'':action==='image-copy'?'图片已复制':'图片已下载';
      return;
    }
    if(action==='close')return requestView(false);
    if(action==='choose')return insertImages(()=>call('choose'));
    if(action==='pause'||action==='resume'){update(await call('transfer',{id:button.dataset.id,action}));return;}
    if(action==='clear')return confirmAction('clear','清空这张共享便签？');
    if(action==='local')return confirmAction('local','用本机草稿替换盒子内容？');
    if(action==='cancel-dialog'){container.querySelector('.clipboard-note-modal').replaceChildren();modalAction=null;return;}
    if(action==='confirm'){action=modalAction;modalAction=null;container.querySelector('.clipboard-note-modal').replaceChildren();}
    if(['clear','restore','remote','local','recover-local'].includes(action)){
      await persistEditor();update(await call('note-command',{action}));renderedScope=null;renderNote();
    }

  }
  async function refresh(){
    if(!opened||composing||localEdits||saveError||editor()?.contains(document.activeElement))return;
    const generation=viewGeneration,previousWrite=writing;
    try{
      const next=await call('note-refresh');
      if(generation===viewGeneration&&previousWrite===writing){update(next);error='';paint(false);}
    }catch(e){if(generation===viewGeneration&&previousWrite===writing){error=message(e);paint(false);}}
  }
  function reflect(){
    if(panelMode)window.dispatchEvent(new CustomEvent('wanx-note-view',{detail:{opened}}));
    else if(!sidebarHost)document.body.classList.toggle('space-note-open',active&&opened);
    if(!container)return;
    for(const b of document.querySelectorAll('[data-action="clipboard-toggle"]')){b.setAttribute('aria-expanded',String(opened));b.setAttribute('aria-controls','super-clipboard');b.classList.toggle('clipboard-trigger-active',opened);}
  }
  function position(){if(container&&opened&&!panelMode&&!sidebarHost)container.style.setProperty('--space-note-top',`${Math.max(0,document.querySelector('.topbar')?.getBoundingClientRect().bottom||0)}px`);}
  function mount(){
    if(container)return;container=document.createElement('aside');container.id='super-clipboard';container.className='clipboard-drawer clipboard-notepad'+(panelMode?' clipboard-panel-note':'');container.hidden=true;container.inert=true;container.setAttribute('aria-label','共享图文便签');
    container.innerHTML=`<header class="clipboard-header"><div class="clipboard-title">${panelMode?'<button class="note-back" data-clip="close" aria-label="返回快捷面板">'+icon('back')+'<span>返回</span></button>':''}<div><h2>便签</h2><p class="clipboard-connection"></p></div></div><div class="clipboard-header-actions"><button class="clipboard-icon-button" data-clip="choose" title="插入图片" aria-label="插入图片">${icon('image')}</button><details class="clipboard-note-menu"><summary class="clipboard-icon-button" aria-label="更多便签操作">${icon('more')}</summary><div><button data-clip="clear">清空便签…</button><button data-clip="restore" hidden>恢复清空前内容</button><button data-clip="recover-local" hidden>恢复本机保留稿</button></div></details><button class="clipboard-icon-button" data-clip="close" title="收起 · Esc" aria-label="关闭便签">${icon('close')}</button></div></header><div class="clipboard-note-conflict" hidden><p>其他设备已修改便签。本机草稿已保留，请选择要继续编辑的版本。</p><button data-clip="remote">使用盒子内容</button><button data-clip="local">使用本机草稿…</button></div><div class="clipboard-note-scroll"><div class="clipboard-note-editor is-empty" role="textbox" aria-label="共享图文便签内容" aria-multiline="true" contenteditable="true" spellcheck="false" data-placeholder="在这里写点什么，或粘贴文字、图片…"></div></div><footer class="clipboard-note-footer"><div class="clipboard-note-transfers"></div><p class="clipboard-note-error" role="status"></p><div><span class="clipboard-note-status" aria-live="polite"></span><span title="同账号、同盒子的已审批 Agent 可读取这张共享便签">Agent 可读</span></div></footer><div class="clipboard-note-modal"></div>`;
    (panelMode?document.querySelector('#panel'):sidebarHost||document.body).append(container);const e=editor();
    e.addEventListener('input',()=>{rememberSelection();if(!composing||panelMode)void persistEditor();paint(false);});
    e.addEventListener('compositionstart',()=>{if(!composing)composing=new Promise(resolve=>{resolveComposition=resolve;});});
    e.addEventListener('compositionend',()=>{if(!composing)return;finishComposition();void persistEditor(true);});
    e.addEventListener('keyup',rememberSelection);e.addEventListener('mouseup',rememberSelection);e.addEventListener('blur',()=>{rememberSelection();if(!composing||panelMode)void persistEditor();});
    e.addEventListener('keydown',event=>{const image=imageTarget(event.target);if(image&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();void showImage(image.dataset.item).catch(e=>{error=messages[e.code]||'图片暂时无法打开，请重试。';paint(false);});}});
    e.addEventListener('paste',event=>void paste(event));
    container.addEventListener('mousedown',event=>{if(event.target.closest('.clipboard-header-actions'))rememberSelection();});
    container.addEventListener('click',event=>{
      const b=event.target.closest('[data-clip]'),image=imageTarget(event.target);if(!b&&!image)return;
      event.preventDefault();event.stopPropagation();
      void (b?action(b.dataset.clip,b):showImage(image.dataset.item)).catch(e=>{error=b?.dataset.clip?.startsWith('image-')||image?messages[e.code]||'图片操作未完成，请重试。':message(e);paint(false);if(imageDialog)imageDialog.querySelector('.clipboard-image-status').textContent=error;});
    });
    container.addEventListener('contextmenu',event=>{const image=imageTarget(event.target);if(!image)return;event.preventDefault();event.stopPropagation();rememberSelection();showImageMenu(event,image.dataset.item);});
    e.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();});
    e.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();const range=document.caretRangeFromPoint?.(event.clientX,event.clientY);if(range&&e.contains(range.startContainer))selection=range;
      const files=Array.from(event.dataTransfer?.files||[]);if(files.length)void insertImages(async()=>{const r=await window.wanxClient.clipboardFiles(files,{scope:state.scope});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});return r.value;});else{const text=event.dataTransfer?.getData('text/plain');if(text)insertText(text);}
    });
  }
  async function loadNote(generation,focus){
    const current=()=>generation===viewGeneration;
    const focusEditor=()=>{
      if(!focus||(document.activeElement!==returnFocus&&document.activeElement!==document.body))return;
      editor().focus({preventScroll:true});if(selection)placeSelection();
    };
    try{
      const beforeSnapshot=writing,next=await call('snapshot');
      if(!current())return;
      if(beforeSnapshot===writing)update(next);
      if(!panelMode)focusEditor();
      const beforeRefresh=writing,refreshed=await call('note-refresh');
      if(!current())return;
      if(beforeRefresh===writing)update(refreshed);
    }catch(e){if(!current())return;error=message(e);paint();}
    focusEditor();
    poll=setInterval(()=>void refresh(),3000);
  }
  function open({focus=true}={}){
    if(opened)return true;
    if(!panelMode&&!active)return false;
    mount();clearTimeout(closeTimer);
    const generation=++viewGeneration;
    opened=true;returnFocus=document.activeElement;
    container.hidden=false;container.inert=false;position();paint();reflect();
    container.getBoundingClientRect();
    requestAnimationFrame(()=>{if(generation===viewGeneration)container.classList.add('is-open');});
    void loadNote(generation,focus);
    return true;
  }
  function hide(immediate){
    viewGeneration++;opened=false;
    clearInterval(poll);clearTimeout(closeTimer);closeImageUI();
    if(!container)return;
    modalAction=null;container.querySelector('.clipboard-note-modal').replaceChildren();
    container.inert=true;container.classList.remove('is-open');
    if(immediate||panelMode)container.hidden=true;
    else closeTimer=setTimeout(()=>{if(!opened)container.hidden=true;},220);
  }
  async function close({restoreFocus=true,immediate=false,shouldClose=()=>true}={}){
    if(!shouldClose())return false;
    if(!opened){if(immediate&&container&&!container.hidden)hide(true);return true;}
    const generation=viewGeneration;
    for(;;){
      if(!panelMode&&composing)await composing;
      if(!panelMode&&pendingInsertions.size)await Promise.allSettled(pendingInsertions);
      if(generation!==viewGeneration)return false;
      if(!shouldClose())return false;
      const write=persistEditor(),saved=await write;
      if(generation!==viewGeneration)return false;
      if(!shouldClose())return false;
      if(panelMode)break;
      if(composing||pendingInsertions.size||write!==writing)continue;
      if(!saved&&active)return false;
      break;
    }
    const focused=container.contains(document.activeElement)||document.activeElement===document.body;
    hide(immediate||!active);reflect();
    if(restoreFocus&&focused){
      const target=returnFocus?.isConnected&&returnFocus!==document.body?returnFocus:document.querySelector('[data-action="clipboard-toggle"]');
      target?.focus({preventScroll:true});
    }
    return true;
  }
  async function requestView(value,options){
    try{
      if(requestSidebar)return await requestSidebar(value,options);
      return (value??!opened)?open(options):await close(options);
    }catch(e){error=message(e);paint(false);return false;}
  }
  document.addEventListener('click',event=>{
    if(event.target.closest('[data-action="clipboard-toggle"]')){event.preventDefault();event.stopPropagation();void requestView();}
    else if(opened&&!panelMode&&!sidebarHost&&!container.contains(event.target)&&!event.target.closest('#academy-edge-handle,[data-action="show-ai-dialogue"]')&&!composing){
      void requestView(false,{restoreFocus:false});
    }
  },true);
  document.addEventListener('pointerdown',event=>{if(imageMenu&&!imageMenu.contains(event.target))closeImageMenu();},true);
  document.addEventListener('keydown',event=>{
    if(!opened||event.key!=='Escape'||event.isComposing||composing||event.defaultPrevented)return;
    const dialog=document.querySelector('dialog[open], [aria-modal="true"]');
    if(!panelMode&&dialog&&!container.contains(dialog))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(imageMenu)closeImageMenu();else if(imageDialog)closeImagePreview();else if(container.querySelector('.clipboard-note-modal').hasChildNodes()){modalAction=null;container.querySelector('.clipboard-note-modal').replaceChildren();}else void requestView(false);
  },true);
  window.addEventListener?.('resize',()=>{position();closeImageMenu();});window.wanxClient.onClipboardState?.(update);
  window.wanxClipboard={
    hostState(next){
      const changed=host&&(next.dataIdentity?.profileId||host.dataIdentity?.profileId?next.dataContextId!==host.dataContextId:next.account?.accountId!==host.account?.accountId||Boolean(next.activeDeviceId&&state.boxId&&next.activeDeviceId!==state.boxId));
      if(changed||next.route==='auth'){
        contextGeneration++;hide(true);finishComposition();selection=null;returnFocus=null;
        for(const url of urls.values())URL.revokeObjectURL(url.url);
        urls.clear();pendingInsertions.clear();state={items:[],tasks:[],scope:null};renderedScope=null;rendered='';lastPersist='';saveError='';error='';writing=Promise.resolve(true);
        editor()?.replaceChildren();
      }
      host=next;reflect();
    },
    setActive(value){
      if(active===value)return;
      active=value;reflect();
      if(!active&&opened)void requestView(false,{restoreFocus:false});
    },
    bindSidebar(request, target){if(!panelMode){requestSidebar=request;sidebarHost=target;}},
    isOpen:()=>opened,
    open,close,toggle:requestView,
  };
})();
