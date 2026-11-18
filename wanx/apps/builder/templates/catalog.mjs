// Bundled with the personal workshop; renderer receives metadata, never a source path.
import source from '../dist/knowledge-template/wanx.editable.json' with {type:'json'};
import zhike from '../dist/zhike-template/wanx.editable.json' with {type:'json'};
const templates = new Map([['template:knowledge-qa',source],['template:zhike',zhike]]);
export function workshopTemplates(){
  return [{id:'template:knowledge-qa',name:'好问',version:source.version,origin:'工坊模板',editable:true,
    description:'配置模型、本地盒子星图知识库、文件空间与标准通道，按通道授权提供问答和文件取用。支持独立使用与工坊定制。'},
    {id:'template:zhike',name:'知客',version:zhike.version,origin:'工坊模板',editable:true,
      description:'对话式 AI CRM 标准模板：记录、补充和查询客户信息，保留沟通来源与极简商机。自带四套界面及标准功能模块，Channel 在设置中连接；副本使用独立数据和授权。'}];
}
export function workshopTemplate(id){return structuredClone(templates.get(id)||null);}
export function workshopTemplateForApplication(applicationId){return structuredClone([...templates.values()].find(s=>s.applicationId===applicationId)||null);}
