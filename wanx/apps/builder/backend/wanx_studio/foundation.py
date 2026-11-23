"""Read-only Builder policy; generated projects cannot alter WANX authority."""
from copy import deepcopy
from importlib.resources import files
import json

_POLICY = json.loads(files(__package__).joinpath('wanx-foundation.json').read_text(encoding='utf-8'))
FOUNDATION_PROMPT = _POLICY['instruction']


def foundation_policy(project=None):
    result = deepcopy({k: v for k, v in _POLICY.items() if k != 'instruction'})
    if project and project.get('devKit'):
        from .public_capabilities import catalog
        # Legacy reports/data policies are not authority for standard apps.
        return {key:result[key] for key in ('existingInterfacesOnly', 'backendInterfaceChangesAllowed', 'forbiddenCredentialFields')} | {
            'version':'wanx-public-contract-policy/2', 'runtimeCapabilities':list(catalog()),
            'authority':'Host SDK public contracts; resource grants and deployment acceptance required'}
    return result


def has_auth_storage(collections):
    forbidden = set(_POLICY['forbiddenCredentialFields'])
    return any(key.replace('_', '').replace('-', '').lower() in forbidden for fields in collections.values() for key in fields)
