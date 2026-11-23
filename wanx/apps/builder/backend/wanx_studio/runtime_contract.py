"""Structured iteration intent, checked against platform-owned runtime declarations."""
from .contracts import StudioError, digest
from . import devkit


def execution_mode(project):
    backend = devkit.project_spec(project)['backend']
    if backend.get('connectionRef') == 'wanx.expert-app.v1':
        return 'managed-expert'
    return 'host' if backend.get('mode') == 'none' else 'service'


def review(project, intent):
    """UI constants and a natural-language summary never grant or remove capabilities."""
    if not isinstance(intent, dict) or set(intent) != {'solutionHash', 'capabilities', 'execution'}:
        raise StudioError('EDIT_RUNTIME_INTENT_REQUIRED', 409)
    if intent['solutionHash'] != digest(project['solution']):
        raise StudioError('SOLUTION_CHANGED', 409)
    caps = intent['capabilities']
    if (not isinstance(caps, list) or any(not isinstance(c, str) for c in caps)
            or len(caps) != len(set(caps)) or not isinstance(intent['execution'], str)
            or intent['execution'] not in {'host', 'managed-expert', 'service'}):
        raise StudioError('EDIT_RUNTIME_INTENT_INVALID', 422)
    if set(caps) != set(project['solution']['capabilities']):
        raise StudioError('EDIT_RUNTIME_PRD_MISMATCH', 409)
    if intent['execution'] != execution_mode(project):
        raise StudioError('STANDARD_RUNTIME_REPLAN_REQUIRED', 409)
    return dict(intent)
