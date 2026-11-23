import test from 'node:test';
import assert from 'node:assert/strict';
import {starxiaotuIntentFailure} from '../ui/starxiaotu-intent-errors.mjs';
import {createPanelBridge} from '../ui/panel-bridge.mjs';
test('service failures are separated from genuine semantic clarification',()=>{
  for(const [code,label,content] of [
    ['MODELING_INTENT_DEPENDENCY_MISSING','服务未就绪',/缺少.*组件/],
    ['SEMANTICA_UPGRADE_REQUIRED','接口未就绪',/未.*提供.*接口/],
    ['SEMANTICA_CONNECTION_FAILED','连接失败',/检查盒子连接/],
    ['MODELING_INTENT_UNAVAILABLE','模型不可用',/模型配置和授权/],
    ['MODELING_INTENT_INVALID','识别结果无效',/格式不符合要求/],
    ['MODELING_INTENT_TIMEOUT','识别超时',/规定时间/],
    ['SEMANTICA_SERVICE_ERROR','识别服务异常',/服务发生错误/],
  ]){
    const result=starxiaotuIntentFailure({code,message:'private key',publicMessage:'private trace'});
    assert.equal(result.label,label);assert.match(result.answer,content);assert.equal(result.errorCode,code);
    assert.equal(result.retry,true);assert.doesNotMatch(result.answer,/无法识别你的需求|private/);
  }
  assert.equal(starxiaotuIntentFailure({code:'MODELING_INTENT_INVALID',status:422}).label,'请求格式不兼容');
  assert.equal(starxiaotuIntentFailure({code:'HOST_SESSION_EXPIRED'}).retry,false);
  assert.equal(starxiaotuIntentFailure({code:'unknown private error'}).errorCode,'');
});
test('panel bridge preserves public status and code for classifier error mapping',async()=>{
  const bridge=createPanelBridge({call:async()=>({ok:false,code:'MODELING_INTENT_INVALID',status:422,message:'请求格式无效'})},{});
  await assert.rejects(bridge.call('assistant-intent',{}),error=>error.code==='MODELING_INTENT_INVALID' && error.status===422);
});
