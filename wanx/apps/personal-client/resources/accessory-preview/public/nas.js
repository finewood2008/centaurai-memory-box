const $ = id => document.getElementById(id);
const main=$('body'), notice=$('message');
let device, current, busy=false, keyword='', selected=new Map(), parent='', offset=0;
function el(tag,text,cls){
  const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n;
}
function action(text,fn,cls){
  const n=el('button',text,cls);
  n.onclick=()=>work(fn);
  return n;
}
async function work(fn){
  if(busy)return;
  busy=true; notice.textContent='';
  try{await fn();}catch(e){notice.textContent=e.message;}finally{busy=false;}
}
async function api(op,input={}){
  const r=await fetch('/api/nas/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const data=await r.json();
  if(!r.ok)throw Error(data.error || data.message || '请求失败');
  return data;
}
function card(title){const c=el('article');c.append(el('h2',title));main.append(c);return c;}
function modal(title){
  const d=el('dialog');d.append(el('h2',title));document.body.append(d);
  d.onclose=()=>d.remove(); d.showModal();return d;
}
async function refresh(){
  device=await api('status');
  $('device').textContent=device.name+' · '+(device.online?'设备已连接':'设备离线');
  $('scope').textContent=device.folder ? '已授权目录 · '+device.folder : '硬盘根目录';
}
async function openProject(id){
  current=await api('project',{id});selected=new Map(current.turns.at(-1).refs.map(r=>[r.path,r]));
  location.hash=id;renderProject();
}
async function listProjects(){
  await refresh();main.replaceChildren();const c=card('历史项目');
  for(const p of device.projects)c.append(action(p.title+'　'+new Date(p.updated*1000).toLocaleDateString(),()=>openProject(p.id),'item'));
  if(!device.projects.length)c.append(el('p','还没有问答项目。'));
}
async function ask(question){
  const q=question.trim();
  if(!q || !selected.size)throw Error('请先选择文件，再输入问题。');
  notice.textContent='盒子正在阅读所选资料…';
  const p=await api('ask',{question:q,refs:[...selected.values()],id:current?.id});
  current=p;location.hash=p.id;notice.textContent='';renderProject();
}
function compose(c){
  const q=el('textarea');q.placeholder=current?'继续问这几份文件…':'你想从这些文件中了解什么？';q.setAttribute('aria-label','问题');
  c.append(q,action(current?'继续提问':'提问',()=>ask(q.value),'primary'));
}
function saveToMemory(turn){
  const t=current.turns[turn], d=modal('确认存入记忆');
  const feedback=el('p');
  d.append(el('pre',t.answer),el('small','来源 · 配件 / 外接硬盘 / '+current.device+' · '+t.refs.map(r=>r.path).join('、')));
  const go=action('确认保存',async()=>{try{const receipt=await api('memory',{id:current.id,turn});if(!receipt.id)throw Error('未收到保存回执');d.close();notice.textContent='已存入记忆 · 配件 / 外接硬盘';}catch(e){feedback.textContent=e.message;}},'primary');
  d.append(feedback,action('取消',()=>d.close()),go);
}
function renderProject(){
  main.replaceChildren();main.append(action('‹ 硬盘文件',home,'item'));
  current.turns.forEach((t,i)=>{
    const c=card(t.question);c.append(el('pre',t.answer));
    t.refs.forEach((r,k)=>c.append(action('['+(k+1)+'] '+r.path,async()=>{const v=await api('preview',{ref:r});const d=modal(r.path);d.append(el('small',v.ref.size+' 字节'),el('pre',v.text),action('关闭',()=>d.close()));},'item sources')));
    const row=el('div',undefined,'row');row.append(action('存入记忆',()=>saveToMemory(i)));c.append(row);
  });compose(card('继续问'));
}

const fmtSize=n=>n>=10**12?(n/10**12).toFixed(1)+' TB':n>=1024**3?(n/1024**3).toFixed(1)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';
function refOf(entry){return {path:entry.path,version:entry.version};}
async function filePreview(entry){
  const ref=refOf(entry),image=/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(entry.path);
  const d=modal(entry.name || entry.path);
  const status=el('p','正在读取预览…');d.append(status,action('关闭',()=>d.close()));
  try {
    if(image){
      const value=await api('disk-image',{ref});
      const img=el('img');img.src='data:image/jpeg;base64,'+value.image;img.alt=entry.path;img.className='photo';
      status.replaceWith(img);d.append(el('small',value.width+' × '+value.height+' 像素 · '+fmtSize(entry.size)));
    } else {
      const v=await api('preview',{ref});status.replaceWith(el('pre',v.text));
    }
    d.append(action('下载文件',()=>api('download',{ref})));
  }catch(e){status.textContent=e.message;}
}
function promptEdit(title,initial,submit,fn){
  const d=modal(title), input=el('input');input.type='text';input.value=initial;input.setAttribute('aria-label',title);
  const error=el('p');const apply=action(submit,async()=>{try{await fn(input.value.trim());d.close();await showFiles();}catch(e){error.textContent=e.message;}},'primary');
  d.append(input,error,action('取消',()=>d.close()),apply);input.focus();input.select();
}
async function menu(entry){
  const d=modal(entry.name),ref=refOf(entry);
  const choose=(label,fn)=>d.append(action(label,async()=>{d.close();await fn();},'item'));
  if(entry.kind==='file')choose('下载',()=>api('download',{ref}));
  choose('重命名',()=>promptEdit('重命名',entry.name,'保存',name=>api('disk-rename',{ref,name})));
  choose('移动到…',async()=>{
    const picker=modal('选择目标文件夹'),crumb=el('p'),folders=el('div',undefined,'list'),error=el('p');let to='';
    async function refreshDest(page=0){
      const out=await api('disk-list',{parent:to,offset:page});
      crumb.textContent=[device.folder,to].filter(Boolean).join(' / ');folders.replaceChildren();
      if(to)folders.append(action('‹ 上级文件夹',async()=>{to=to.split('/').slice(0,-1).join('/');await refreshDest();},'item'));
      for(const f of out.items.filter(v=>v.kind==='folder' && v.path!==entry.path)) folders.append(action(f.name,async()=>{to=f.path;await refreshDest();},'item'));
      if(out.total>page+100)folders.append(action('下一页',()=>refreshDest(page+100),'item'));
    }
    picker.append(crumb,folders,error,action('取消',()=>picker.close()),action('移动到这里',async()=>{try{await api('disk-move',{ref,to});picker.close();await showFiles();}catch(e){error.textContent=e.message;}}));
    await refreshDest();
  });
  choose('移入回收站',()=>{
    const confirm=modal('移入回收站？');confirm.append(el('p',entry.path),action('取消',()=>confirm.close()),action('移入回收站',async()=>{await api('disk-trash',{ref});confirm.close();await showFiles();}));
  });
  d.append(action('关闭',()=>d.close()));
}
async function recycle(){
  const value=await api('disk-trash-list'), d=modal('硬盘回收站');
  if(!value.items.length)d.append(el('p','回收站为空'));
  for(const item of value.items){const line=el('div',undefined,'row');line.append(el('span',item.path),action('还原',async()=>{await api('disk-restore',{id:item.id});line.remove();await showFiles();}));d.append(line);}
  d.append(action('关闭',()=>d.close()));
}
async function go(folder){parent=folder;keyword='';offset=0;await showFiles();}
async function showFiles(){
  if(!device.online){
    main.replaceChildren();const panel=card('硬盘已断开');
    panel.append(el('p','把 '+device.name+' 接回盒子后，即可继续浏览文件。'),action('刷新',home));
    return;
  }
  const value=await api('disk-list',{parent,offset,query:keyword});
  main.replaceChildren();
  const c=card('文件'),bread=el('div',undefined,'row bread');c.append(bread);
  const rootLabel=device.folder || device.name;
  bread.append(action(rootLabel,()=>go(''),'item'));
  let path='';
  for(const part of parent.split('/').filter(Boolean)){path=path?path+'/'+part:part;const dest=path;bread.append(el('small','/'),action(part,()=>go(dest),'item'));}
  const bar=el('div',undefined,'row toolbar'), filter=el('input');filter.type='text';filter.value=keyword;filter.placeholder='筛选当前文件夹';filter.setAttribute('aria-label','筛选文件');
  async function find(){keyword=filter.value.trim();offset=0;await showFiles();}
  filter.onkeydown=e=>{if(e.key==='Enter')work(find);};
  const more=action('更多',()=>{
    const d=modal('文件操作');d.append(action('新建文件夹',()=>{d.close();promptEdit('文件夹名称','','创建',name=>api('disk-mkdir',{parent,name}));},'item'),action('回收站',async()=>{d.close();await recycle();},'item'),action('关闭',()=>d.close()));
  });
  bar.append(filter,action('筛选',find),action('上传',async()=>{const r=await api('upload',{parent});if(!r.cancelled)await showFiles();},'primary'),more);c.append(bar);
  const info=el('small',value.total+' 项 · 可用 '+fmtSize(value.free)+' / '+fmtSize(value.capacity));c.append(info);
  const list=el('div',undefined,'drive-list');
  const qa=action('问问所选文件',()=>{if(!selected.size)throw Error('请先勾选文件');current=null;main.replaceChildren();main.append(action('‹ 返回文件',showFiles,'item'));const panel=card('问问所选文件');panel.append(el('small',[...selected.keys()].join('、')));compose(panel);});
  function label(){qa.textContent=selected.size?'问问所选文件（'+selected.size+'）':'问问所选文件';qa.hidden=!selected.size;}
  for(const e of value.items){
    const line=el('div',undefined,'file-row'),check=el('input');check.type='checkbox';check.hidden=e.kind==='folder';check.checked=selected.has(e.path);check.setAttribute('aria-label','选择 '+e.name);
    check.onchange=()=>{if(check.checked && selected.size>=4){check.checked=false;notice.textContent='一次最多选择四个文件';return;}if(check.checked)selected.set(e.path,refOf(e));else selected.delete(e.path);label();};
    const open=action(e.name,()=>e.kind==='folder'?go(e.path):filePreview(e),'file-name');open.dataset.kind=e.kind;
    const tools=action('···',()=>menu(e));tools.setAttribute('aria-label',e.name+' 的操作');
    line.append(check,open,el('small',e.kind==='folder'?'文件夹':fmtSize(e.size)),tools);list.append(line);
  }
  if(!value.items.length)list.append(el('p',keyword?'没有匹配的文件':'这个文件夹是空的'));
  c.append(list,qa);label();
  const pages=el('div',undefined,'row');if(offset>0)pages.append(action('上一页',async()=>{offset-=100;await showFiles();}));if(offset+100<value.total)pages.append(action('下一页',async()=>{offset+=100;await showFiles();}));c.append(pages);
}
async function home(){history.replaceState(null,'',location.pathname);current=null;selected.clear();await refresh();await go('');}
function types(){
  document.title='外接存储 · 配件';
  $('home').hidden=$('history').hidden=$('types').hidden=true;
  $('device').textContent='配件';$('scope').textContent='选择要使用的存储设备。';
  const cards=el('div',undefined,'type-grid');main.append(cards);
  const disk=el('a',undefined,'type-card');disk.href='/accessories/storage/drive';disk.append(el('span','▤','type-icon'),el('h2','外接硬盘'),el('p','浏览连接到盒子的硬盘，预览和管理文件。'),el('strong','打开硬盘 →'));
  const nas=el('section',undefined,'type-card inactive');nas.setAttribute('aria-disabled','true');nas.append(el('span','▥','type-icon'),el('h2','外接 NAS'),el('p','通过网络连接品牌 NAS。'),el('small','暂不可用'));
  cards.append(disk,nas);
}
async function manageStorage() {
  let previous;
  document.title = '硬盘管理智能体 · 记忆盒子';
  document.querySelector('h1').textContent = '硬盘管理智能体';
  $('home').hidden = $('history').hidden = $('types').hidden = true;
  $('types').href = '/accessories/storage/drive';
  $('types').textContent = '文件与问答';
  const refreshButton = action('重新检测', () => detect());
  document.querySelector('nav').append(refreshButton);

  async function detect(quiet = false) {
    let inventory;
    try { inventory = await api('volume-status'); }
    catch (error) {
      $('device').textContent = '外接存储服务暂不可用';
      $('scope').textContent = error.message;
      $('types').hidden = true;
      main.replaceChildren();
      previous = undefined;
      return;
    }
    const {configured, volumes, waiting} = inventory;
    const state = JSON.stringify(inventory);
    if (quiet && state === previous) return;
    previous = state;
    if (!volumes.length) $('types').hidden = true;
    else void api('status').then(({online}) => {
      if (previous === state) $('types').hidden = !online;
    }).catch(() => { if (previous === state) $('types').hidden = true; });
    $('device').textContent = !configured ? '待配置硬盘访问' : volumes.length ? `已连接 · ${volumes.length} 个外接卷`
      : waiting.length ? '已检测到外接硬盘' : '未检测到外接硬盘';
    $('scope').textContent = !configured ? '完成当前盒子的外接存储服务配对后，可重新检测。'
      : volumes.length ? ''
      : waiting.length ? '在盒子系统中挂载硬盘后，空间会自动出现入口。'
      : '把硬盘通过 USB 接入盒子。';
    main.replaceChildren();
    for (const volume of volumes) {
      const panel = card(volume.name);
      const facts = [volume.label && volume.label !== volume.name ? `卷标 ${volume.label}` : '', volume.filesystem?.toUpperCase(),
        volume.readOnly === true ? '只读挂载' : volume.readOnly === false ? '已挂载' : '',
        Number.isFinite(volume.free) && Number.isFinite(volume.size)
          ? `可用 ${fmtSize(volume.free)} / ${fmtSize(volume.size)}` : ''].filter(Boolean);
      if (facts.length) panel.append(el('p', facts.join(' · '), 'drive-facts'));
      const actions = el('div', undefined, 'row');
      const link = el('a', '在空间中打开', 'drive-action');
      link.href = '/accessories/storage/space?' + new URLSearchParams({volume:volume.id});
      actions.append(link);
      if (volume.canRename) actions.append(action('设置显示名称', () => {
        const dialog = modal('设置显示名称');
        const input = el('input'), feedback = el('p');
        input.type = 'text';
        input.maxLength = 48;
        input.setAttribute('aria-label', '空间中的硬盘名称');
        input.value = volume.name === volume.label ? '' : volume.name;
        input.placeholder = volume.label;
        feedback.setAttribute('role', 'status');
        const save = action('保存', async () => {
          try {
            await api('volume-name', {volume:volume.id, name:input.value});
            dialog.close();
            await detect();
          } catch (error) { feedback.textContent = error.message; }
        }, 'primary');
        input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) save.click(); });
        dialog.append(el('p', '留空将使用硬盘卷标。'), input, feedback, action('取消', () => dialog.close()), save);
        input.focus();
      }));
      panel.append(actions);
    }
    for (const disk of waiting) {
      const panel = card(disk.name);
      panel.append(el('p', (Number.isFinite(disk.size) ? fmtSize(disk.size) + ' · ' : '') + '尚无可用的挂载卷', 'drive-facts'));
    }
  }

  await work(detect);
  setInterval(() => {
    if (!document.hidden && !document.querySelector('dialog')) void work(() => detect(true));
  }, 5000);
}
if(location.pathname==='/accessories/storage/drive'){
  document.title='外接硬盘 · 外接存储';document.querySelector('h1').textContent='外接硬盘';
  $('types').textContent='硬盘管理';
  $('home').onclick=()=>work(home);$('history').onclick=()=>work(listProjects);
  setInterval(()=>{if(!busy && !document.hidden && device && !device.online && !current && !document.querySelector('dialog'))work(home);},7000);
  window.addEventListener('hashchange',()=>{if(!busy && current?.id!==location.hash.slice(1))work(()=>location.hash?openProject(location.hash.slice(1)):home());});
  work(async()=>{await refresh();if(location.hash)await openProject(location.hash.slice(1));else await showFiles();}).then(()=>{if(!main.childElementCount){$('device').textContent='等待连接';main.append(action('重新连接',home,'primary'));}});
}else if(location.pathname==='/accessories/storage') void manageStorage();
else types();
