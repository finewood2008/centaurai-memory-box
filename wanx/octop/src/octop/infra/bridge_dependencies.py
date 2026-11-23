"""Wire existing host services into independent bridge extensions."""

from types import SimpleNamespace


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
    from octop.infra.voice.manager import VoiceManager

    def model_inventory(server) -> dict:
        voice = VoiceManager(
            settings_repo=server.services.settings_repo,
            voice_provider_repo=server.services.voice_provider_repo,
        )
        media = server.app_runtime.agent_registry.media_generation.load()
        images = []
        default_image = None
        if media.enabled:
            for provider in media.providers:
                if not (provider.configured and provider.image_enabled and provider.image_model):
                    continue
                images.append({
                    "provider_name": provider.id,
                    "model": provider.image_model,
                    "name": provider.image_model,
                })
                if provider.id == media.default_image_provider:
                    default_image = f"{provider.id}/{provider.image_model}"
        return {
            "asr": voice.stt_model_catalog(),
            "image_generation": {"models": images, "defaultRef": default_image},
        }


    return SimpleNamespace(
        memory_model_inventory=model_inventory,
        managed_provider=managed_provider,
        read_application_defaults=read_application_defaults,
        build_probe_chat_model=build_probe_chat_model,
        reasoning_request_parameters=reasoning_request_parameters,
        list_resolved_models=list_resolved_models,
        user_has_permission=user_has_permission,
        llm_text_content=llm_text_content,
        aclose_session_http_clients=aclose_session_http_clients,
    )
