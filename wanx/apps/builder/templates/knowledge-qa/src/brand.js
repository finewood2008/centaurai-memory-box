const SVG_NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={},...children){const node=document.createElementNS(SVG_NS,tag);for(const[key,value]of Object.entries(attrs)){if(value!==undefined&&value!==null)node.setAttribute(key,String(value));}for(const child of children.flat()){if(child)node.append(child);}return node;}
export function brandMark(){
  const stops=[['0','#4338ca'],['.55','#2f52d0'],['1','#0f9ec9']].map(([offset,color])=>svg('stop',{offset,'stop-color':color}));
  const defs=svg('defs',{},
    svg('linearGradient',{id:'brand-mark-gradient',x1:'0',y1:'0',x2:'1',y2:'1'},stops),
    svg('mask',{id:'brand-mark-notch',maskUnits:'userSpaceOnUse',x:'0',y:'0',width:'52',height:'52'},
      svg('rect',{x:'0',y:'0',width:'52',height:'52',fill:'#ffffff'}),
      svg('circle',{cx:'46.5',cy:'46.5',r:'7.5',fill:'#000000'})
    )
  );
  const badge=svg('g',{mask:'url(#brand-mark-notch)'},
    svg('rect',{x:'1',y:'1',width:'50',height:'50',rx:'13',fill:'url(#brand-mark-gradient)'}),
    svg('rect',{x:'1.7',y:'1.7',width:'48.6',height:'48.6',rx:'12.3',fill:'none',stroke:'#ffffff','stroke-width':'1.2','stroke-opacity':'.26'})
  );
  const glyph=svg('g',{fill:'none',stroke:'#ffffff','stroke-width':'3','stroke-linecap':'round','stroke-linejoin':'round'},
    svg('path',{d:'M18.5 13 L12.5 19.5'}),
    svg('path',{d:'M9.5 22 L23.5 22'}),
    svg('path',{d:'M17.5 25.5 L12 36'}),
    svg('path',{d:'M17.5 25.5 L21.5 33'}),
    svg('rect',{x:'26',y:'22',width:'14',height:'15.5',rx:'2.4','stroke-width':'2.8'})
  );
  const icon=svg('svg',{viewBox:'0 0 52 52',width:'52',height:'52',role:'img','aria-label':'知 · 智能问答品牌徽标',focusable:'false'},defs,badge,glyph);
  const mark=document.createElement('span');mark.className='brand-mark brand-logo';mark.append(icon);return mark;
}
