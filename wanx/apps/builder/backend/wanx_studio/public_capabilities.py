"""Public contract catalog for standard Builder projects.

Contract IDs/status come from the Host SDK, never the miniapp runtime. Adapter
support is a separate fact: a documented permission is not an executable bridge.
"""
from copy import deepcopy
import json
import hashlib
from pathlib import Path

from .contracts import StudioError, digest

VERSION = 'wanx-public-contracts/2'
EXPERT = 'wanx.expert-app.v1'
LEGACY = frozenset({'data', 'model', 'files', 'knowledge', 'reports', 'foundation', 'dialogue'})
LABELS = {
    'host.session': 'Host 身份与会话', EXPERT: '已部署专家 Agent 与应用状态',
    'resource.expert': '专家模板', 'agent.thread': 'Agent 对话线程',
    'space.drive': '空间文件', 'starlink.evidence': '星图资料与证据',
    'knowledge.retrieval': '知识库检索', 'memory': 'Agent 记忆',
    'dialogue.session': '多模型对话会话', 'models': '可选模型目录（非生成接口）',
}
BACKGROUND = {
    'background.space': {'label': '产品经理空间背景资料', 'methods': ['context.metadata', 'context.read'], 'planningOnly': True},
    'background.xingtu': {'label': '产品经理星图背景资料', 'methods': ['context.metadata', 'context.search', 'context.read'], 'planningOnly': True},
}
INSTRUCTION = '''标准应用 capabilities 使用 availableContracts 的公共合同 ID，禁止使用旧 miniapp 的 data/model/files/knowledge/reports/foundation/dialogue 分类。AI 业务执行使用 wanx.expert-app.v1 专家 Agent；模型目录只用于选项读取，不是 model.generate。专家必须绑定已选择的版本化模板；未配置时保留 AI 需求并提示配置专家，不要求用户删需求或等待 model 适配器恢复。该专家合同同时提供固定 state 集合的应用状态操作，不支持任意业务集合。空间文件对应 space.drive，星图对应 starlink.evidence；背景资料选择不授予应用运行权限。每项合同分别检查 status、adapterAvailable 和项目配置。open 不等于模板已有适配器；ready-for-acceptance 只允许已实现适配器的开发，不能声称真实部署验收通过；contract-only 不可构建。缺口保留原需求，不能自行降低范围或伪造接口。'''


def contract_root(project_root=None):
    from .devkit import verified_contract_root
    return verified_contract_root(project_root)


def catalog(project_root=None):
    try:
        root = contract_root(project_root)
        document = json.loads((root / 'contract-status.v1.json').read_text())
        result = {}
        for row in document['apis']:
            key = row['id']
            if not isinstance(key,str) or key in result or row['status'] not in {'open','ready-for-acceptance','contract-only','blocked','closed'}:
                raise ValueError('invalid public contract entry')
            hashes={}
            for name in row.get('contractFiles',[]):
                path=Path(name)
                if path.is_absolute() or '..' in path.parts:raise ValueError('invalid contract file')
                hashes[name]=hashlib.sha256((root/path).read_bytes()).hexdigest()
            result[key] = {**deepcopy(row), 'label': LABELS.get(key, key),
                           'adapterAvailable': key in {'host.session', EXPERT},
                           'catalogVersion': document['version'], 'contractDigest': digest(hashes)}
            if key=='host.session':result[key]['methods']=['window.wanx.context']
            elif key==EXPERT:result[key]['methods']=['window.wanx.expertContext','window.wanx.expertInvoke']
        return result
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise StudioError('PUBLIC_CONTRACT_INVALID', 503) from error


def validate_declaration(capabilities, project_root=None):
    if not isinstance(capabilities, list) or any(not isinstance(c, str) for c in capabilities):
        raise StudioError('CAPABILITY_INPUT_INVALID', 422)
    if set(capabilities) & LEGACY:
        raise StudioError('LEGACY_CAPABILITY_REPLAN_REQUIRED', 409)
    if not set(capabilities) <= catalog(project_root).keys():
        raise StudioError('CAPABILITY_UNSUPPORTED', 422)


def gaps(capabilities, *, backend=None, project_root=None):
    available = catalog(project_root)
    managed = bool(backend and backend.get('mode') == 'existing' and backend.get('connectionRef') == EXPERT)
    result = []
    for cap in dict.fromkeys(capabilities):
        entry = available.get(cap)
        code = None
        if cap in LEGACY:
            code = 'LEGACY_CAPABILITY_REPLAN_REQUIRED'
        elif entry is None:
            code = 'NO_PUBLIC_HOST_CONTRACT'
        elif entry['status'] not in {'open', 'ready-for-acceptance'}:
            code = 'PUBLIC_CONTRACT_NOT_IMPLEMENTED'
        elif not entry['adapterAvailable']:
            code = 'PUBLIC_CONTRACT_ADAPTER_UNAVAILABLE'
        elif cap == EXPERT and not managed:
            code = 'EXPERT_CONTRACT_REQUIRED'
        if code:
            result.append({'id': cap, 'reason': code})
    return result


def fingerprint(project_root=None):
    return digest({'version': VERSION, 'catalog': catalog(project_root)})


def expert_contract(contracts):
    """Read new snapshots and immutable historical expert snapshots."""
    return contracts.get(EXPERT, contracts.get('foundation', {}))


def planning_instruction():
    return INSTRUCTION + " 每个 must 功能在 features[].implementation 明确 source（frontend 或 contract）、contractIds、conditions、caseRefs；caseRefs 对应 tests[].ref 稳定的小写英文标识，重命名不改变标识。只使用当前公共合同和受信 Host 身份；不新增账号体系、凭据、任意网络代理或底层服务。权限和数据隔离以具体合同为准，不从前端角色或筛选推导授权。标准专家应用状态固定为 state:{json:string}，按可信用户、应用和环境隔离。业务字段编码在 json 内，不创建其他集合；不把部署前的配置检查表述为专家执行成功。propose_contract 使用固定 state 结构；无持久化合同则使用空结构。"
