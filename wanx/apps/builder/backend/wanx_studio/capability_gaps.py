"""Project-local technical evidence; never a user scope decision or grant."""
from .contracts import StudioError, digest


def expert_gap_resolutions(project):
    # Delay the import: versions -> iterative also consumes this projection.
    from .deployment.project_expert import selected, validate_verification, CLIENT_FORMAT, RUNTIME_CONTRACT
    from .deployment.expert_runtime import validate_backend

    from .public_capabilities import EXPERT
    key = EXPERT if project.get('devKit') else 'foundation'
    prep = project.get('preparation', {})
    contract = selected(project)
    report = prep.get('report') or {}
    probe = prep.get('currentProbe') or {}
    if not contract or type(contract.get('revision')) is not int:
        return {}
    revision = contract['revision']
    if (type(project.get('_deploymentExpertRevision')) is not int
            or project['_deploymentExpertRevision'] != revision
            or type(report.get('preparationRevision')) is not int
            or report.get('preparationRevision') != prep.get('revision')
            or report.get('expertContractDigest') != digest(contract)
            or probe.get('state') != 'completed'
            or not probe.get('operationId')
            or probe['operationId'] != report.get('operationId')
            or key not in report.get('required', [])
            or report.get('codex', {}).get('available') is not True):
        return {}
    if project.get('devKit') and (contract.get('clientFormat') != CLIENT_FORMAT
                                 or contract.get('runtimeContract') != RUNTIME_CONTRACT):
        return {}
    try:
        validate_backend({'schemaVersion': 1, 'format': 'wanx-expert-backend-v1',
                          'template': contract['template'], 'mode': 'ask'})
        validate_verification(contract['verification'])
    except (KeyError, TypeError, StudioError):
        return {}
    evidence = report.get('results', {}).get(key, {})
    if evidence.get('status') != 'passed' or evidence.get('expertTemplate') != contract['template']:
        return {}
    events = prep.get('events', [])
    if any(not isinstance(e, dict) or type(e.get('seq')) is not int or e['seq'] != i + 1
           for i, e in enumerate(events)):
        return {}
    selections = [i for i, e in enumerate(events) if e.get('type') == 'expert.contract.selected']
    if not selections:
        return {}
    selection = selections[-1]
    event = events[selection]
    if (event.get('profile') != contract['profile'] or type(event.get('revision')) is not int
            or event['revision'] != revision):
        return {}
    resolved = {}
    for i, event in enumerate(events[:selection]):
        if event.get('type') != 'capability.required' or event.get('capability') != 'foundation':
            continue
        reason = event.get('reason')
        if not isinstance(reason, str) or not reason.strip():
            continue
        gap = 'foundation：' + reason
        if gap not in prep.get('gaps', []):
            continue
        # A successful, strict handoff establishes that no unresolved intake
        # gap preceded this PM request. Do not infer provenance from free text.
        anchors = [j for j in range(i) if events[j].get('type') == 'intake.handed-off']
        if not anchors or event.get('gapIntroduced') is False:
            continue
        anchor = anchors[-1]
        ambiguous = False
        for other in events[anchor + 1:]:
            if other.get('type') == 'platform.gap-recorded':
                key = other.get('requirementHash')
                if key is None or key == digest(gap):
                    ambiguous = True
            elif other.get('type') == 'intake.updated':
                keys = other.get('gapHashes')
                if keys is None or digest(gap) in keys:
                    ambiguous = True
        if ambiguous:
            continue
        resolved[gap] = {'status': 'satisfied', 'source': 'current-expert-probe',
                         'capability': 'foundation', 'operationId': report['operationId'],
                         'expertContractDigest': report['expertContractDigest'],
                         'preparationRevision': report['preparationRevision']}
    return resolved


def unresolved_capability_gaps(project):
    prep = project.get('preparation', {})
    resolutions = expert_gap_resolutions(project)
    decisions = prep.get('gapDecisions', {})
    return [g for g in prep.get('gaps', []) if digest(g) not in decisions and g not in resolutions]
