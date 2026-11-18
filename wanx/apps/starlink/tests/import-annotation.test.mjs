import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingAnnotationHTML,relatedMaterialsHTML,materialAnnotationHTML} from '../ui/import-annotation.mjs';

test('import preview distinguishes absent, pending and review annotations and escapes saved content', () => {
  assert.match(pendingAnnotationHTML({}), /暂无标签和文件说明/);
  assert.match(pendingAnnotationHTML({annotationSelection:{status:'pending'}}), /可继续导入/);
  assert.match(pendingAnnotationHTML({annotationIndex:{status:'missing_snapshot'}}), /不会自动补入/);
  assert.match(pendingAnnotationHTML({sourceAnnotation:{needsReview:true,tags:['旧标签']}}), /待核对/);
  const html = pendingAnnotationHTML({sourceAnnotation:{tags:['<script>'],description:'"业务" & 内容'}});
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/); assert.match(html, /&amp;/);
});

test('annotation materials render separately without inventing evidence or quoting document starts', () => {
  assert.equal(relatedMaterialsHTML({items:[{id:'evidence'}]}), '');
  const html = relatedMaterialsHTML({annotationDocuments:[{documentId:'doc1',title:'资料',text:'不是问题证据',annotation:{tags:['项目']}},
    {documentId:'invalid/path',title:'不能打开'}]});
  assert.match(html, /相关材料/); assert.match(html, /data-source="doc1"/);
  assert.ok(!html.includes('不是问题证据')); assert.ok(!html.includes('invalid/path'));
});

test('material metadata reports server persistence separately from indexing and conflict states',()=>{
  assert.equal(materialAnnotationHTML({}),'');
  const source={sourceAnnotation:{snapshot:{tags:['<项目>'],description:'说明'}}};
  assert.match(materialAnnotationHTML({...source,annotationSync:{status:'saved'}}),/暂不参与标注检索/);
  assert.match(materialAnnotationHTML({...source,annotationSync:{status:'conflict'}}),/版本冲突/);
  assert.match(materialAnnotationHTML({...source,annotationSync:{status:'unsupported'}}),/当前服务暂不支持/);
  assert.match(materialAnnotationHTML({...source,annotationSync:{status:'missing_snapshot'}}),/正文检索仍可用/);
  assert.ok(!materialAnnotationHTML(source).includes('<项目>'));
});
