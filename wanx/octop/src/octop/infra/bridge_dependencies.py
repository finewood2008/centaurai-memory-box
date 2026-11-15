"""Wire existing host services into independent bridge extensions."""

from types import SimpleNamespace


def memory_model_host() -> dict:
    from octop_harness.llm.factory import build_chat_model
    from octop_harness.llm.session_header import aclose_session_http_clients

    from octop.infra.agents.providers.store import ProviderStore
    from octop.infra.utils.llm_text import llm_text_content

    return {
        "providers": ProviderStore,
        "build_chat_model": build_chat_model,
        "close_clients": aclose_session_http_clients,
        "text_content": llm_text_content,
    }


def semantica_model_host() -> SimpleNamespace:
    from octop_harness.llm.session_header import aclose_session_http_clients

    from octop.infra.agents.providers.application_defaults import (
        managed_provider,
        read_application_defaults,
    )
    from octop.infra.agents.providers.probe import build_probe_chat_model
    from octop.infra.agents.providers.reasoning import reasoning_request_parameters
    from octop.infra.agents.providers.resolved import list_resolved_models
    from octop.infra.users.permissions import user_has_permission
    from octop.infra.utils.llm_text import llm_text_content

    return SimpleNamespace(
        managed_provider=managed_provider,
        read_application_defaults=read_application_defaults,
        build_probe_chat_model=build_probe_chat_model,
        reasoning_request_parameters=reasoning_request_parameters,
        list_resolved_models=list_resolved_models,
        user_has_permission=user_has_permission,
        llm_text_content=llm_text_content,
        aclose_session_http_clients=aclose_session_http_clients,
    )
