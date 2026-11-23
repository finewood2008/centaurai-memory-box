"""Build synthetic test candidates through the standard workspace and ZIP pipeline."""
from pathlib import Path
from uuid import uuid4

from test_discovery import standard_solution
from wanx_studio import devkit_build
from wanx_studio.prd import PRD_REVIEW_SECTIONS
from wanx_studio.versions import next_version


def workspace_files(svc, owner, project, task_id):
    task = next(item for item in project['tasks'] if item['id'] == task_id)
    workspace = devkit_build.create_iteration_workspace(
        project, svc.project_root, svc.store.root / 'tasks' / task_id,
        task, version=next_version(project),
    )
    stored = svc.store.get(owner, project['id'])
    live = next(item for item in stored['tasks'] if item['id'] == task_id)
    live.update(devKitWorkspace=workspace['root'], devKitSpecHash=workspace['specHash'])
    svc.store.save(stored)
    return devkit_build.mutable_files(Path(workspace['root']))


async def seeded(svc, owner='alice', *, name='台账', goal='跟进业务事项'):
    project = svc.create_project(owner, name, goal, uuid4().hex)
    project = svc.update_solution(owner, project['id'], {
        'operationId': uuid4().hex, 'expectedHash': project['solutionHash'], 'solution': standard_solution(),
    })
    svc.confirm(owner, project['id'], {
        'operationId': uuid4().hex, 'solutionHash': project['solutionHash'], 'reviewedSections': PRD_REVIEW_SECTIONS,
    })
    project = svc.store.get(owner, project['id'])
    solution_hash = project['confirmation']['hash']
    frozen = project['confirmation']['buildInput']
    task_id = uuid4().hex
    project['tasks'].append({
        'id': task_id, 'state': 'running', 'solutionHash': solution_hash,
        'buildInput': frozen, 'instruction': 'Synthetic first version', 'events': [], 'question': None,
    })
    svc.store.save(project)
    files = workspace_files(svc, owner, project, task_id)
    return await svc.add_artifact(owner, project['id'], task_id, files)


def historical_records(project, *, environment='preview', **fields):
    # Existing records can outlive an artifact format. Exercise their real store
    # without granting the standard layout preview a synthetic data capability.
    return {'owner': 'alice', 'app': project['appId'], 'environment': environment,
            'manifest': {'collections': {'items': {'title': 'string', **fields}}}}
