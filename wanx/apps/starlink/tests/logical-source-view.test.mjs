import test from 'node:test';
import assert from 'node:assert/strict';
import {logicalSourceGroups, logicalSourcesHTML, taskUnitLabel, extractionCountsHTML} from '../ui/logical-source-view.mjs';

const cell=(r,c,text,table=0)=>({id:`${table}-${r}-${c}`,kind:'table_cell',text,
  source_locator:{table_index:table,row_index:r,column_index:c,table_header:r===0}});

test('short-line groups keep all original IDs and respect headings/pages/truncation',()=>{
  const rows=Array.from({length:18},(_,i)=>({id:String(i),text:`短行${i}`,kind:'paragraph',source_locator:{page:1}}));
  const groups=logicalSourceGroups(rows);
  assert.equal(groups.length,3);
  assert.deepEqual(groups.flatMap(g=>g.segments),rows);
  assert.equal(logicalSourceGroups([rows[0],{...rows[1],kind:'heading'},rows[2],{...rows[3],source_locator:{page:2}}]).length,4);
  assert.equal(logicalSourceGroups([rows[0],{...rows[1],text_truncated:true},rows[2]]).length,3);
});

test('tables preserve columns, missing cells, separate tables and escaped contents',()=>{
  const rows=[cell(0,0,'名称'),cell(0,1,'内容'),cell(1,1,'<script>alert(1)</script>'),cell(0,0,'另表',1)];
  const html=logicalSourcesHTML(rows);
  assert.equal((html.match(/<table>/g)||[]).length,2);
  assert.match(html,/<th scope="col"/);
  assert.match(html,/data-source-row="1" data-source-column="0"[^>]+>—<\/td>/);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal((html.match(/<tr>/g)||[]).length,3);
});

test('sparse tables do not expand into a quadratic grid or imply unloaded cells are empty',()=>{
  const rows=Array.from({length:500},(_,i)=>cell(i,i,`cell-${i}`));
  const html=logicalSourcesHTML(rows);
  assert.ok((html.match(/<td/g)||[]).length<1500);
  for(const row of rows)assert.ok(html.includes(`<p>${row.text}</p>`));
  assert.ok(html.includes('尚未加载'));
  assert.ok(html.includes('当前已加载内容'));
  assert.ok(html.length<600000);
});

test('invalid cell coordinates retain text without creating malformed table geometry',()=>{
  const row=cell(-1,-1,'原文保留');
  const html=logicalSourcesHTML([row]);
  assert.ok(html.includes('原文保留'));
  assert.ok(!html.includes('<table>'));
});

test('source preview preserves escaped location labels for prose and table cells',()=>{
  const rows=[{id:'p',kind:'paragraph',text:'正文'},cell(1,0,'表格正文')];
  const html=logicalSourcesHTML(rows,{location:s=>s.id==='p'?'第 2 页':'行 2 <位置>'});
  assert.equal((html.match(/class="logical-source-location"/g)||[]).length,2);
  assert.ok(html.includes('第 2 页'));
  assert.ok(html.includes('行 2 &lt;位置&gt;'));
});

test('evidence anchor and truncated-text actions survive table and prose grouping',()=>{
  const rows=[cell(0,0,'first'),cell(0,1,'target')];
  const html=logicalSourcesHTML(rows,{attributes:s=>s.id===rows[1].id?'data-reader-match="7" tabindex="-1"':'',suffix:s=>s.id===rows[1].id?'<button>读取完整正文</button>':''});
  assert.equal((html.match(/data-reader-match/g)||[]).length,1);
  assert.match(html,/tabindex="-1"><p>target<\/p><button>读取完整正文/);
});

test('HTML legacy table rows keep literal pipe characters and complete text',()=>{
  const html=logicalSourcesHTML([{id:'r',kind:'table',text:'a | b | literal',source_locator:{table_index:0}}]);
  assert.ok(html.includes('a | b | literal'));
  assert.ok(!html.includes('<td'));
});

test('task counts distinguish raw segments, extraction batches and attempts',()=>{
  const job={kind:'knowledge_extract',metrics:{source_segments:486,llm_requests:2,extraction_batches_reused:1,model_calls:new Array(100)}};
  assert.equal(taskUnitLabel(job),'抽取批次');
  const html=extractionCountsHTML(job);
  assert.ok(html.includes('原文 486 个片段'));
  assert.ok(html.includes('本次模型请求 2 次（含重试）'));
  assert.ok(!html.includes('100'));
  assert.ok(!extractionCountsHTML({kind:'knowledge_extract',metrics:{model_calls:[{}]}}));
  assert.ok(!extractionCountsHTML({kind:'knowledge_extract',metrics:{source_segments:'<img>',llm_requests:-1}}));
});

test('legacy managed counters are unknown, while a measured cached attempt may be zero',()=>{
  const job={kind:'knowledge_extract',metrics:{llm_requests:0,model_calls:[{usage:{total_tokens:1000}}]}};
  assert.match(extractionCountsHTML(job),/次数未记录/);
  assert.doesNotMatch(extractionCountsHTML(job),/请求 0 次/);
  job.metrics.llm_request_count_version=2;
  assert.match(extractionCountsHTML(job),/请求 0 次/);
});
