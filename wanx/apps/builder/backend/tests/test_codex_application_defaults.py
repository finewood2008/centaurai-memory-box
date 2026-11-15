"""Real Octop projection and domain defaults at the Builder boundary."""
import json
from types import SimpleNamespace

import pytest

from wanx_studio.codex_config import snapshot_model
from wanx_studio.wanx import WanxModels


async def test_real_application_defaults_preserve_chat_and_queued_model(tmp_path, monkeypatch):
    pytest.importorskip('octop', reason='Run with the root Octop environment for domain integration')
    from octop.config import OctopConfig
    from octop.infra.agents.providers.application_defaults import write_application_defaults
    from octop.infra.agents.providers.device_projection import DeviceProviderProjection
    from octop.infra.db.migrate import run_migrations
    from octop.infra.db.pool import SqlitePool
    from octop.infra.db.services import build_shared_services
    from octop.infra.utils.paths import PathLayout

    monkeypatch.setenv('WANX_MODEL_PROVIDERS_ENABLED', '1')
    monkeypatch.setenv('OCTOP_HOME', str(tmp_path / 'octop'))
    paths = PathLayout(tmp_path / 'octop')
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    try:
        services = build_shared_services(db=db, paths=paths, config=OctopConfig())
        projection = DeviceProviderProjection(services)
        models = WanxModels(services)
        await projection.create_provider({
            'name': 'admin-managed-qeetoken', 'kind': 'openai',
            'base_url': 'http://127.0.0.1:8123/model-providers/qeetoken/v1',
            'api_key': 'synthetic-qeetoken-proxy',
            'note': 'wanx-admin-model-provider-v1:device-1',
            'models': [{'id': 'gpt-chat'}],
        })
        await projection.set_active_model({'provider_name': 'admin-managed-qeetoken', 'model': 'gpt-chat'})
        custom = await projection.create_provider({
            'name': 'admin-managed-custom', 'kind': 'openai',
            'base_url': 'http://127.0.0.1:8123/model-providers/custom/v1',
            'api_key': 'synthetic-custom-proxy',
            'note': 'wanx-admin-model-provider-v1:device-1',
            'models': [{'id': 'coding-alias'}, {'id': 'next-coding-alias'}],
        })
        assert models.codex_provider()['model'] == 'gpt-chat'
        policy = {'managed': True, 'revision': '1', 'defaults': {}}
        write_application_defaults(services, policy)
        assert models.codex_provider() is None
        policy['defaults']['kaiwu'] = {'provider_name': 'admin-managed-custom', 'model': 'coding-alias'}
        write_application_defaults(services, policy)
        assert models.codex_provider()['model'] == 'coding-alias'
        frozen = snapshot_model(SimpleNamespace(model=models))
        policy.update(revision='2')
        policy['defaults']['kaiwu']['model'] = 'next-coding-alias'
        write_application_defaults(services, policy)
        await projection.update_provider(custom['id'], {'api_key': 'rotated-custom-proxy'})
        assert models.codex_provider()['model'] == 'next-coding-alias'
        queued = models.codex_provider(model_ref=frozen)
        assert queued['model'] == 'coding-alias'
        assert queued['api_key'] == 'rotated-custom-proxy'
        assert services.settings_repo.get_active_model() == ('admin-managed-qeetoken', 'gpt-chat')
        assert 'proxy' not in json.dumps(policy)
        await projection.update_provider(custom['id'], {'enabled': False})
        assert models.codex_provider() is None
        assert models.codex_provider(model_ref=frozen) is None
    finally:
        db.close()
