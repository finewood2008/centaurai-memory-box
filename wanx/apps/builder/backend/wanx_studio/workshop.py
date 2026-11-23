"""Personal editable copies. No company authority, data or credentials are inherited."""

from __future__ import annotations

import re
from contextvars import ContextVar

from fastapi import Depends, Request

from .contracts import StudioError
from .service import StudioService
from .workshop_runtime import PersonalKnowledge, PersonalRuntime

PREFIX = "/api/_client/workshop"
FORMAT = "wanx-miniapp-source-v1"
_actor = ContextVar("workshop_actor", default=None)


class PersonalWorkshop(PersonalRuntime, StudioService):
    workshop = True

    def __init__(self, root, project_root, model=None, files=None):
        from .workshop_model import (
            ModelEdits,
            ModelEngines,
            ModelPreparation,
            ModelRunner,
            WorkshopModels,
        )

        super().__init__(root, project_root, WorkshopModels(model), files)
        self.engines = ModelEngines(self)
        self.preparation = ModelPreparation(self)
        self.edits = ModelEdits(self)
        self.runner = ModelRunner(self)

    async def invoke(self, owner, token, method, params):
        if method == "dialogue.invoke":
            current = self.runtime(owner, token)
            if (
                "dialogue" not in current["manifest"]["capabilities"]
                or not isinstance(params, dict)
                or set(params) != {"operation", "input"}
                or not isinstance(params["operation"], str)
                or not isinstance(params["input"], dict)
            ):
                raise StudioError("CAPABILITY_DENIED", 403)
            if not hasattr(self, "haowen"):
                from .haowen import HaoWen

                self.haowen = HaoWen(self)
            result = await self.haowen.invoke(current, params["operation"], params["input"])
            self.runtime(owner, token)
            return result
        if method == "foundation.invoke":
            from .foundation_runtime import native_operation

            self.authorize_management(owner)
            current=self.runtime(owner,token)
            if current.get('deploymentProfile')=='wanx-expert-app-v1':
                return await super().invoke(owner,token,method,params)
            return native_operation(self, owner, token, params)
        return await super().invoke(owner, token, method, params)

    def authorize_management(self, owner):
        if getattr(self, "actor_check", None):
            actor = _actor.get()
            if actor is None or actor[0] != owner:
                raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
            authority = getattr(self, "local_authority", None)
            self.actor_check(owner, authority.context(owner) if authority else actor[1])

    def runtime(self, owner, token, *, allow_layout=False):
        self.authorize_management(owner)
        return super().runtime(owner, token, allow_layout=allow_layout)

    async def generate(self, owner, *args, **kwargs):
        self.authorize_management(owner)
        result = await super().generate(owner, *args, **kwargs)
        self.authorize_management(owner)
        return result


def mount_workshop(app, server, root, source_service):
    from centuarai_local_data_gate import get_context

    from octop.api.deps import current_user

    from .api import create_router
    from .wanx import WanxModels

    models = WanxModels(server.services)
    service = getattr(server, "_wanx_workshop_service", None)
    if service is None or getattr(service, "closing", False):
        service = PersonalWorkshop(server.paths.root / ".wanx-workshop", root, models)
        server._wanx_workshop_service = service

    def check(owner, context):
        user = server.services.user_repo.get(int(owner.split(":")[1]))
        if user is None or user.disabled:
            raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
        if context is not None:
            try:
                context.check_cached()
            except Exception:
                raise StudioError("WORKSHOP_SESSION_EXPIRED", 403) from None

    service.actor_check = check

    from .local_authority import Actor, LocalStudioAuthority
    from .local_authority import _actor as local_actor

    class PersonalAuthority(LocalStudioAuthority):
        def enter_personal(self, user, context):
            if not self.required():
                return local_actor.set(None)
            if (
                context is None
                or context.claims["resourceId"] != "wanx"
                or context.claims.get("team")
            ):
                raise StudioError("WORKSHOP_PERSONAL_ONLY", 403)
            return local_actor.set(Actor(self, user, context))

        def can_manage(self, owner):
            actor = self.identity(owner)
            return actor is not None and actor.context.claims["resourceId"] == "wanx"

        async def resources(self, owner, grants):
            if any(g["resourceId"].startswith("team:") for g in grants):
                raise StudioError("WORKSHOP_PERSONAL_ONLY", 403)
            return await super().resources(owner, grants)

    service.local_authority = PersonalAuthority(
        server.services, lambda: bool(getattr(app.state, "local_data_required", False))
    )
    from .deployment.miniapp_profile import configure
    configure(service,server.services,server.paths.root / "deployment-target.json",server=server,source='workshop')

    from octop.infra.personal_space.service import PersonalSpace

    from .context_sources import WanxContextSources
    from .local_authority import to_thread

    def space(owner):
        return PersonalSpace(server.paths.root / ".wanx-personal-space", int(owner.split(":")[1]))

    async def files(owner, ids):
        service.authorize_management(owner)

        def read():
            storage = space(owner)
            result = []
            for key in ids:
                meta = storage.metadata(key)
                if meta["kind"] != "file" or meta["size"] > 262144:
                    raise StudioError("FILE_TYPE_UNSUPPORTED", 409)
                data, _ = storage.read_chunk(key, 0, max(meta["size"], 1))
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeError:
                    raise StudioError("FILE_NOT_UTF8", 409) from None
                result.append({"id": key, "name": meta["name"], "text": text})
            return result

        return await to_thread(read)

    class PersonalSources(WanxContextSources):
        async def request(self, owner, method, path, *, team=False, **kwargs):
            service.authorize_management(owner)
            if team:
                raise StudioError("WORKSHOP_PERSONAL_ONLY", 403)
            context = service.local_authority.context(owner)
            if context is not None:
                from wanx_bridge.semantica.local_team_client import LocalSemanticaClient

                await service.local_authority.resources(
                    owner, [{"resourceId": "semantica", "actions": ["read"]}]
                )
                client = LocalSemanticaClient.from_file(
                    context, server.paths.root / "semantica.json"
                )
                return await client.request(method, path, **kwargs)
            return await super().request(owner, method, path, **kwargs)

    service.files = files
    service.context_provider = PersonalSources(server, space, files, service.local_authority)
    service.knowledge_provider = PersonalKnowledge(service.context_provider)
    from .haowen import HaoWen
    from .haowen_channels import dispatch as haowen_dispatch

    service.haowen = HaoWen(
        service, server, lambda owner: service.context_provider.workspaces(owner)
    )

    async def handle_haowen(message, agent):
        async for event in haowen_dispatch(service.haowen, message, agent):
            yield event

    if getattr(server, "app_runtime", None) is not None:
        server.app_runtime.agent_registry.haowen_handler = handle_haowen

    async def identity(request: Request, user=Depends(current_user)):  # noqa: B008
        if getattr(user, "local_team", None) is not None:
            raise StudioError("WORKSHOP_PERSONAL_ONLY", 403)
        context = get_context(request.scope)
        if getattr(app.state, "local_data_required", False) and (
            context is None or context.claims["resourceId"] != "wanx"
        ):
            raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
        path = request.url.path.removeprefix(PREFIX)
        application = context.claims["applicationId"] if context else user.application_id
        runtime_app = re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", application or "")
        if application not in {"wanx", "wanx-host"} and not runtime_app:
            raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
        if runtime_app and not (
            request.method == "POST"
            and path in {"/apps/" + application + "/runtime", "/deployment/apps/" + application + "/runtime"}
            or re.fullmatch(
                r"/runtime/[A-Za-z0-9_-]+(?:/invoke)?", path
            )
        ):
            raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
        # This private surface exposes iteration, never first-build discovery.
        if (
            path in {"/projects"}
            and request.method == "POST"
            or re.search(
                r"/(?:chat|solution|confirm|build|intake|interview|decisions|feedback|iterations)(?:/|$)",
                path,
            )
        ):
            raise StudioError("WORKSHOP_ITERATION_ONLY", 403)
        owner = "wanx:" + str(user.id)
        if runtime_app and path.startswith("/runtime/"):
            session = service.runtime_sessions.get(path.split("/")[2])
            if not session or session["owner"] != owner or session.get("deploymentSlot",session["app"]) != application:
                raise StudioError("WORKSHOP_IDENTITY_REQUIRED", 403)
        target = re.match(r"/(?:_builder/)?projects/([a-f0-9]{32})(?:/|$)", path)
        if target and service.store.get(owner, target[1], True).get("_workshopArchivedAt"):
            raise StudioError("PROJECT_DELETED", 404)
        authority_token = service.local_authority.enter_personal(user, context)
        token = _actor.set((owner, context))
        try:
            service.authorize_management(owner)
            from .upgrade_guard import request_admission
            async with request_admission(service, request.method):
                yield owner
        finally:
            service.local_authority.reset(authority_token)
            _actor.reset(token)

    router = create_router(service, identity, prefix=PREFIX)
    router.include_in_schema = False

    from .workshop_management import mount as mount_management

    mount_management(router, service, identity)
    app.include_router(router, include_in_schema=False)
    server.add_shutdown_callback(service.close)
    server._wanx_workshop_service = service
    return service
