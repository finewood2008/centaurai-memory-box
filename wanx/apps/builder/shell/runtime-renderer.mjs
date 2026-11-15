import{haowenPicker}from'../core/haowen-picker.mjs';
const host=window.miniappHost,frame=document.querySelector('iframe'),error=document.getElementById('error');
async function picker(knowledge=false){
  return new Promise((resolve,reject)=>{
    const shade=document.createElement('div');shade.className='shade';const panel=document.createElement('div');panel.className='picker';shade.append(panel);document.body.append(shade);const selected=new Set();
    const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node};
    async function render(parent=''){
      panel.replaceChildren(text('h2',knowledge?'选择星图知识库':'选择参考资料'),text('p','仅允许当前应用读取你明确选择的来源；复制应用不会复制授权。'));
      try{const list=knowledge?await host.knowledgeList():await host.list(parent);if(parent){const back=text('button','返回根目录');back.onclick=()=>render('');panel.append(back)}
        for(const file of list.items){const row=document.createElement('label');if(file.kind==='folder'){const button=text('button','▱ '+file.name);button.onclick=()=>render(file.id);row.append(button)}else{const box=document.createElement('input');box.type='checkbox';box.disabled=!knowledge&&!/\.(txt|md|csv|json)$/i.test(file.name);box.checked=selected.has(file.id);box.onchange=()=>box.checked?selected.add(file.id):selected.delete(file.id);row.append(box,text('span',file.name))}panel.append(row)}
        const actions=document.createElement('div');actions.className='actions';const cancel=text('button','取消');cancel.onclick=()=>{shade.remove();resolve([])};const ok=text('button','选择资料');ok.className='primary';ok.onclick=async()=>{try{const result=knowledge?await host.knowledgeSelect([...selected]):await host.select([...selected]);shade.remove();resolve(result)}catch(e){panel.append(text('p','选择未完成：'+e.message))}};actions.append(cancel,ok);panel.append(actions)
      }catch(e){shade.remove();reject(e)}
    }void render();
  });
}
host.load().then(()=>{frame.onload=()=>{const channel=new MessageChannel();let pending=0;channel.port1.onmessage=async({data:m})=>{if(!m||!Number.isSafeInteger(m.id)||pending>=4)return;pending++;try{const result=m.method==='haowen.select'?await haowenPicker(host.haowenNative,m.params?.kind):m.method==='haowen.channels'?await haowenPicker(host.haowenNative,'channels'):m.method==='files.select'?await picker():m.method==='knowledge.select'?await picker(true):await host.invoke(m.method,m.params||{});channel.port1.postMessage({id:m.id,result})}catch(e){channel.port1.postMessage({id:m.id,error:e.message})}finally{pending--}};frame.contentWindow.postMessage({type:'wanx:init'},'*',[channel.port2])};frame.src='miniapp-frame.html'}).catch(()=>{frame.remove();error.textContent='当前应用会话不可用，请返回万象重新打开。'});
