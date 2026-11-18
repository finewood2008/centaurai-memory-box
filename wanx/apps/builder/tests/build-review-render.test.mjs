import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const compiled=await build({entryPoints:[new URL('../ui/build-review.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',jsx:'automatic',loader:{'.css':'empty'},write:false,plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:import.meta.resolve(args.path),external:true}))}}]});
const {BuildReview}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const project={id:'a'.repeat(32),updatedAt:1,solutionHash:'b'.repeat(64),artifacts:[],readiness:{ready:true},solution:{prd:{}},preparation:{interview:{state:'completed',sync:'saved',turns:[]}}};

test('first PRD review shows the real blocking reason while keeping review and confirmation unavailable',()=>{
  const reason='Codex 开发环境尚未就绪，请返回万象检查配置';
  const html=renderToStaticMarkup(createElement(BuildReview,{project,active:false,reason,onBuilt(){throw Error('render cannot build')}}));
  assert.match(html,/继续共同完善 PRD/);assert.ok(html.includes(reason));assert.doesNotMatch(html,/<button|确认这份 PRD/);
});

test('first PRD loading state remains visible without opening the development gate',()=>{
  const html=renderToStaticMarkup(createElement(BuildReview,{project,active:false,reason:'',onBuilt(){throw Error('render cannot build')}}));
  assert.match(html,/正在核对当前方案/);assert.doesNotMatch(html,/<button|确认这份 PRD/);
});
