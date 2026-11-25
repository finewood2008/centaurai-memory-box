// Public failure categories; provider messages and exception text stay private.
export function starxiaotuIntentFailure(error) {
  const code=typeof error?.code==='string'?error.code:'';
  const link=(label,view)=>({label,target:{view}});
  const result=(label,answer,links=[],retry=true)=>({label,answer,links,retry,errorCode:code});
  if(code==='MODELING_INTENT_DEPENDENCY_MISSING')return result('服务未就绪','盒端缺少意图识别所需的组件，请更新共享协议包后重试。这不是提问方式的问题。');
  if(['SEMANTICA_UPGRADE_REQUIRED','SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_RESOURCE_NOT_FOUND'].includes(code))return result('接口未就绪','当前服务尚未提供意图识别接口，请更新客户端及盒端相关服务后重试。');
  if(['HOST_SESSION_EXPIRED','WAREHOUSE_CHANGED','SEMANTICA_RESOURCE_FORBIDDEN','MODELING_OWNER_REQUIRED'].includes(code))return result('授权已变化','账号、项目或访问授权已变化，请重新连接并选择项目后再提问。',[],false);
  if(['SEMANTICA_SERVICE_TIMEOUT','SEMANTICA_CONNECTION_FAILED','SEMANTICA_SERVICE_UNAVAILABLE','NETWORK_NOT_READY','NETWORK_UNAVAILABLE'].includes(code))return result('连接失败','意图识别请求未完成，请检查盒子连接后重试。');
  if(code==='MODELING_INTENT_TIMEOUT')return result('识别超时','模型未在规定时间内返回识别结果，请稍后重试。',[link('检查模型设置','models')]);
  if(code==='MODELING_INTENT_INVALID'&&error?.status===422)return result('请求格式不兼容','意图识别请求与服务端协议不一致，请同步更新客户端与盒端服务。');
  if(code==='MODELING_INTENT_INVALID'||code==='MODEL_INVALID_OUTPUT'||code==='SEMANTICA_INVALID_RESPONSE')return result('识别结果无效','意图识别返回的格式不符合要求，本次未执行操作。可以重新识别，持续失败时检查模型设置。',[link('检查模型设置','models')]);
  if(code==='MODELING_INTENT_INPUT_TOO_LONG')return result('问题过长','问题较长，请缩短到 2000 字以内再发送。',[],false);
  if(code==='MODELING_INTENT_UNAVAILABLE'||/^MODEL_[A-Z_]+$/.test(code)||code==='LLM_NOT_CONFIGURED')return result('模型不可用','意图识别模型暂不可用，请在「模型设置」检查CentaurAI 的模型配置和授权后重试。',[link('检查模型设置','models')]);
  // An unrecognized service error is not evidence of an ambiguous user request.
  return {label:'识别服务异常',answer:'意图识别服务发生错误，请重试或检查服务状态；本次未执行操作。',links:[],retry:true,errorCode:['SEMANTICA_SERVICE_ERROR','SEMANTICA_REQUEST_FAILED'].includes(code)?code:''};
}
