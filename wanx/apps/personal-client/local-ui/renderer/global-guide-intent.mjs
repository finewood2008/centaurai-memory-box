import {concepts,pages} from '../starlink/shared/application-guide.mjs';

export function guideIntent(text) {
  const howTo=/^(?:请问)?(?:怎么|如何|怎样|在哪|哪里)/.test(text);
  const explicit=/^(?:请|帮我|直接|现在|麻烦)*(?:带我(?:去|到)|打开|跳(?:到|转到)|前往|进入|去看)/.test(text);
  if(explicit && /或者|还是|以及|或是|和|或/.test(text)){
    const choices=Object.entries(pages).filter(([,v])=>text.includes(v[0])).map(([page,[label,definition]])=>({page,label,definition}));
    if(choices.length>1)return {type:'choose',choices};
  }
  const matches=[...concepts.values()].filter(t=>text.includes(t.label)).sort((a,b)=>b.label.length-a.label.length);
  const term=matches[0] || (/授权范围|访问范围|任务授权/.test(text)?concepts.get('task-access'):null);
  const page=Object.keys(pages).sort((a,b)=>pages[b][0].length-pages[a][0].length).find(key=>text.replace(/\s/g,'').toLowerCase().includes(pages[key][0].replace(/\s/g,'').toLowerCase()));
  if(explicit){
    const target=text.replace(/^(?:请|帮我|直接|现在|麻烦)*(?:带我(?:去|到)|打开|跳(?:到|转到)|前往|进入|去看)(?:一下|看一下|看看|看)?/, '')
      .replace(/^(?:当前|这个|本)(?:星图|项目)(?:的)?/,'').replace(/(?:页面|页|板块|模块|入口)?[。！!]?$/,'').trim();
    if(term && target===term.label)return {type:'guide',term,go:true};
    if(page && target.replace(/\s/g,'').toLowerCase()===pages[page][0].replace(/\s/g,'').toLowerCase())return {type:'guide',term:{page},go:true};
    return {type:'answer'};
  }
  if (term && (explicit || !/我(?:的|这个)|本项目.*(?:哪些|几个)|结合.*项目/.test(text))) return {type:'guide',term,go:explicit};
  if (page && (explicit || howTo || /在哪|哪里|怎么用|是什么|怎么去/.test(text))) return {type:'guide',term:{page,label:pages[page][0],definition:pages[page][1]},go:explicit};
  return {type:'answer'};
}

// Explicit requests for real matches must resolve against the page before the model answers.
export function explicitGuideLookup(text,page) {
  if (/^(?:请问)?(?:怎样|怎么|如何|哪里可以)/.test(text))return null;
  const active=/(?:当前|这[个份条篇]|正在(?:阅读|预览)|已打开).{0,8}(?:资料|原文|材料|文章|文档|文件|预览|记忆|记录)/.test(text);
  const analyzing=/分析|概括|总结|依据|写了什么|讲了什么|提到|说了什么|摘录|原文里/.test(text);
  if(active && analyzing && ['space','memory','data'].includes(page))
    return {query:text.match(/[「“"]([^」”"]{1,100})[」”"]/)?.[1] || text.slice(0,100),area:page==='data'?'material':'selection'};
  if(page==='data' && /资料清单|资料列表|列出.{0,16}(?:项目|星图).{0,8}资料/.test(text))return {query:'项目资料',area:'summary'};
  const term=text.match(/[「“"]([^」”"]{1,100})[」”"]/);
  if(term && /查找|找到|找出|搜索|检索|定位|打开|列出|匹配/.test(text))
    return {query:term[1],area:page==='data' && /原文|资料里|材料中/.test(text)?'project':'page'};
  const file=text.match(/^(?:请|帮我|直接)*(?:打开|找一下|查找)\s*(.{1,100}\.[a-zA-Z0-9]{1,8})[。！!]?$/);
  return file?{query:file[1],area:'page'}:null;
}
