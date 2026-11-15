"""Personal editable copies. No company authority, data or credentials are inherited."""

from __future__ import annotations

import asyncio
import json
import re
import time
from contextvars import ContextVar
from copy import deepcopy
from uuid import uuid4

from fastapi import Depends, Request
from pydantic import Field

from .contracts import Operation, StudioError, check_manifest, digest, has_credentials
from .prd import ProductRequirement
from .service import StudioService
from .store import public
from .versions import frozen, next_version, verify
from .workshop_runtime import PersonalKnowledge, PersonalRuntime

PREFIX = "/api/_client/workshop"
FORMAT = "wanx-miniapp-source-v1"
_actor = ContextVar("workshop_actor", default=None)


def validate_source(value):
    if not isinstance(value, dict) or value.get("allowed") is not True:
        raise StudioError("WORKSHOP_MODIFICATION_NOT_ALLOWED", 409)
    if set(value) - {
        "allowed",
        "format",
        "files",
        "sourceHash",
        "applicationId",
        "version",
        "origin",
    } or value.get("origin") not in {"local", "market", "kaiwu", None}:
        raise StudioError("WORKSHOP_SOURCE_INVALID", 422)
    if value.get("format") != FORMAT:
        raise StudioError("WORKSHOP_FORMAT_UNSUPPORTED", 409)
    files = value.get("files")
    if not isinstance(files, dict) or not 1 <= len(files) <= 64:
        raise StudioError("WORKSHOP_SOURCE_REQUIRED", 409)
    total = 0
    for name, text in files.items():
        if (
            not isinstance(name, str)
            or len(name) > 180
            or not re.fullmatch(
                r"miniapp\.manifest\.json|src/[A-Za-z0-9_/-]+\.(?:js|css|json)", name
            )
            or any(p in {"", ".", ".."} for p in name.split("/"))
        ):
            raise StudioError("WORKSHOP_SOURCE_INVALID", 422)
        if not isinstance(text, str) or len(text.encode()) > 512 * 1024:
            raise StudioError("WORKSHOP_SOURCE_INVALID", 422)
        total += len(text.encode())
    if total > 2 * 1024 * 1024 or "src/app.js" not in files or "miniapp.manifest.json" not in files:
        raise StudioError("WORKSHOP_SOURCE_INVALID", 422)
    if value.get("sourceHash") != digest(files):
        raise StudioError("WORKSHOP_SOURCE_CHANGED", 409)
    if has_credentials(json.dumps(files, ensure_ascii=False)):
        raise StudioError("INPUT_CREDENTIAL_DETECTED", 422)
    if not re.fullmatch(
        r"[a-z][a-z0-9.-]{0,127}", value.get("applicationId", "")
    ) or not re.fullmatch(r"\d+\.\d+\.\d+", value.get("version", "")):
        raise StudioError("WORKSHOP_SOURCE_INVALID", 422)
    try:
        manifest = check_manifest(json.loads(files["miniapp.manifest.json"]))
    except (ValueError, TypeError, KeyError):
        raise StudioError("WORKSHOP_SOURCE_INVALID", 422) from None
    if set(manifest["capabilities"]) - {
        "data",
        "model",
        "files",
        "knowledge",
        "foundation",
        "dialogue",
    }:
        raise StudioError("WORKSHOP_CAPABILITY_UNSUPPORTED", 409)
    return files, manifest


class Copy(Operation):
    name: str = Field(min_length=1, max_length=128)
    source: dict


class SourceUpdate(Operation):
    expectedArtifactHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source: dict


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

    def runtime(self, owner, token):
        self.authorize_management(owner)
        return super().runtime(owner, token)

    async def generate(self, owner, *args, **kwargs):
        self.authorize_management(owner)
        result = await super().generate(owner, *args, **kwargs)
        self.authorize_management(owner)
        return result

    def install_payload(self, owner, project_id, artifact_hash):
        payload = super().install_payload(owner, project_id, artifact_hash)
        p = self.store.get(owner, project_id)
        a = next(a for a in p["artifacts"] if a["hash"] == artifact_hash)
        return {
            **payload,
            "runtimeNamespace": "workshop",
            "editable": {
                "allowed": True,
                "format": FORMAT,
                "applicationId": p["appId"],
                "version": a["version"],
                "sourceHash": digest(a["files"]),
                "files": a["files"],
                "origin": "local",
            },
        }

    async def update_source(self, owner, project_id, body):
        """Stage a source upgrade on the same identity; adoption remains explicit."""
        from .contracts import compatible
        from .versions import idle

        self.authorize_management(owner)
        files, manifest = validate_source(body["source"])
        signature = digest({"project": project_id, **body})
        with self.store.lock:
            old = self.store.db.execute(
                "SELECT hash,result FROM operations WHERE owner=? AND key=?",
                (owner, body["operationId"]),
            ).fetchone()
            if old:
                if old[0] != signature:
                    raise StudioError("OPERATION_CONFLICT", 409)
                return public(self.store.get(owner, project_id))
        p = self.store.get(owner, project_id)
        files = deepcopy(files)
        manifest = deepcopy(manifest)
        previous_name = p["name"]
        # Rename the stock Q&A application as part of its source migration;
        # custom application names remain user-owned.
        name = (
            "好问"
            if (
                body["source"]["applicationId"] == "centaurai.wanx.template.knowledge-qa"
                and previous_name == "智能问答系统"
                and manifest["name"] == "好问"
            )
            else previous_name
        )
        manifest["name"] = name
        files["miniapp.manifest.json"] = json.dumps(manifest, ensure_ascii=False)
        proc = await asyncio.create_subprocess_exec(
            "node",
            str(self.project_root / "tools/compile-artifact.mjs"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.project_root,
            start_new_session=True,
        )
        try:
            output, _ = await asyncio.wait_for(
                proc.communicate(json.dumps({"files": files}).encode()), 30
            )
        finally:
            await self.native_codex.stop(proc)
        if proc.returncode:
            raise StudioError("ARTIFACT_VALIDATION_FAILED", 422)
        compiled = json.loads(output)
        self.authorize_management(owner)
        with self.store.transaction():
            old = self.store.db.execute(
                "SELECT hash,result FROM operations WHERE owner=? AND key=?",
                (owner, body["operationId"]),
            ).fetchone()
            if old:
                if old[0] != signature:
                    raise StudioError("OPERATION_CONFLICT", 409)
                return public(self.store.get(owner, project_id))
            p = self.store.get(owner, project_id)
            idle(p)
            if p.get("_workshopArchivedAt"):
                raise StudioError("PROJECT_DELETED", 404)
            base = p["artifacts"][-1]
            if base["hash"] != body["expectedArtifactHash"]:
                raise StudioError("VERSION_CHANGED", 409)
            if p["name"] != previous_name:
                raise StudioError("VERSION_CHANGED", 409)
            if not compatible(base["manifest"], manifest):
                raise StudioError("VERSION_DATA_INCOMPATIBLE", 409)
            p["solution"]["capabilities"] = manifest["capabilities"]
            p["name"] = name
            p["confirmation"] = {"hash": digest(p["solution"])}
            p["preparation"]["required"] = manifest["capabilities"]
            task = {
                "id": uuid4().hex,
                "state": "completed",
                "executor": "source-update",
                "solutionHash": digest(p["solution"]),
                "createdAt": time.time(),
                "events": [],
            }
            artifact = {
                "version": next_version(p),
                "taskId": task["id"],
                "createdAt": time.time(),
                "files": files,
                "manifest": manifest,
                "bundle": compiled["bundle"],
                "css": compiled["css"],
                "solutionHash": digest(p["solution"]),
                "confirmation": p["confirmation"],
                "baseHash": base["hash"],
                "summary": "轻量问答与万象能力接入 · 模板 " + body["source"]["version"],
                "snapshot": frozen(p),
            }
            artifact["hash"] = digest(
                {k: artifact[k] for k in ["files", "manifest", "solutionHash", "taskId"]}
            )
            artifact["contentHash"] = digest(
                {k: artifact[k] for k in ["files", "manifest", "bundle", "css"]}
            )
            verify(artifact)
            p["tasks"].append(task)
            p["artifacts"].append(artifact)
            p["stage"] = "preview"
            self.versions.bump(p)
            p["workshop"].update(
                {
                    k: body["source"].get(k)
                    for k in ["applicationId", "version", "sourceHash", "origin"]
                }
            )
            self.store.save(p)
            result = public(p)
            self.store.db.execute(
                "INSERT INTO operations VALUES(?,?,?,?)",
                (owner, body["operationId"], signature, json.dumps(result, ensure_ascii=False)),
            )
            return result

    async def copy_source(self, owner, body):
        self.authorize_management(owner)
        if has_credentials(body["name"]):
            raise StudioError("INPUT_CREDENTIAL_DETECTED", 422)
        if not body["name"].strip():
            raise StudioError("WORKSHOP_NAME_REQUIRED", 422)
        files, manifest = validate_source(body["source"])
        fingerprint = digest(body)

        def previous():
            with self.store.lock:
                row = self.store.db.execute(
                    "SELECT hash,result FROM operations WHERE owner=? AND key=?",
                    (owner, body["operationId"]),
                ).fetchone()
                if row:
                    if row["hash"] != fingerprint:
                        raise StudioError("OPERATION_CONFLICT", 409)
                    return self.store.get(owner, json.loads(row["result"])["id"])

        old = previous()
        if old:
            return public(old)
        # Recompile source through the same compiler; never trust a supplied bundle.
        proc = await asyncio.create_subprocess_exec(
            "node",
            str(self.project_root / "tools/compile-artifact.mjs"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.project_root,
            start_new_session=True,
        )
        try:
            output, _ = await asyncio.wait_for(
                proc.communicate(json.dumps({"files": files}).encode()), 30
            )
        finally:
            await self.native_codex.stop(proc)
        if proc.returncode:
            raise StudioError("ARTIFACT_VALIDATION_FAILED", 422)
        compiled = json.loads(output)
        self.authorize_management(owner)
        with self.store.transaction():
            old = previous()
            if old:
                return public(old)
            now, pid, task = time.time(), uuid4().hex, uuid4().hex
            name = body["name"].strip()
            source_name = manifest["name"]
            manifest = deepcopy(manifest)
            manifest["name"] = name
            files = deepcopy(files)
            files["miniapp.manifest.json"] = json.dumps(manifest, ensure_ascii=False)
            solution = {
                "audience": "当前个人账号",
                "workflow": "沿用来源应用，按本轮要求持续修改",
                "inputs": "用户主动提供的内容",
                "outputs": "独立定制应用",
                "fields": list(
                    dict.fromkeys(k for c in manifest["collections"].values() for k in c)
                ),
                "acceptance": ["原有功能保持可用；本轮修改可试用并可恢复"],
                "capabilities": manifest["capabilities"],
                "dependencies": [],
                "prd": ProductRequirement(
                    problem="定制 " + name,
                    successOutcome="保留原应用并提供独立修改版本",
                    dataFields=[
                        {"name": key}
                        for key in dict.fromkeys(
                            k for c in manifest["collections"].values() for k in c
                        )
                    ],
                    tests=[
                        {
                            "title": "验证定制版本",
                            "given": "已打开来源副本",
                            "when": "按原应用流程试用并执行本轮修改",
                            "then": "原有功能保持可用；本轮修改可试用并可恢复",
                        }
                    ],
                ).model_dump(),
            }
            p = {
                "id": pid,
                "owner": owner,
                "appId": "ai.wanx.selfmade." + uuid4().hex,
                "name": name,
                "nameMode": "manual",
                "originalGoal": "基于已有应用持续修改：" + name,
                "stage": "preview",
                "createdAt": now,
                "updatedAt": now,
                "solution": solution,
                "messages": [],
                "revisions": [],
                "decisions": {},
                "confirmation": {"hash": digest(solution)},
                "acceptance": None,
                "installed": None,
                "tasks": [
                    {
                        "id": task,
                        "state": "completed",
                        "executor": "source-copy",
                        "solutionHash": digest(solution),
                        "createdAt": now,
                        "events": [],
                        "question": None,
                    }
                ],
                "artifacts": [],
                "_edits": {"enabled": True, "items": []},
                "workshop": {
                    k: body["source"].get(k)
                    for k in ["applicationId", "version", "sourceHash", "origin"]
                },
            }
            p["workshop"]["name"] = source_name
            # No old engine, PRD, materials, authorization, bindings, model or records.
            if self.engines.list(owner)["defaultId"]:
                self.engines.bind(owner, p)
            from .preparation import initial

            p["preparation"] = initial(p)
            p["preparation"].update({"phase": "acp", "required": manifest["capabilities"]})
            p["preparation"]["interview"].update({"state": "completed", "sync": "saved"})
            artifact = {
                "version": "0.1.0",
                "taskId": task,
                "createdAt": now,
                "files": files,
                "manifest": manifest,
                "bundle": compiled["bundle"],
                "css": compiled["css"],
                "solutionHash": digest(solution),
                "confirmation": p["confirmation"],
                "snapshot": frozen(p),
                "summary": "从来源版本创建独立副本",
            }
            artifact["hash"] = digest(
                {k: artifact[k] for k in ["files", "manifest", "solutionHash", "taskId"]}
            )
            artifact["contentHash"] = digest(
                {k: artifact[k] for k in ["files", "manifest", "bundle", "css"]}
            )
            verify(artifact)
            p["artifacts"] = [artifact]
            self.store.save(p)
            result = public(p)
            self.store.db.execute(
                "INSERT INTO operations VALUES(?,?,?,?)",
                (owner, body["operationId"], fingerprint, json.dumps(result, ensure_ascii=False)),
            )
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
                r"/runtime/[A-Za-z0-9_-]+(?:/(?:invoke|files|knowledge|haowen-native))?", path
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
            yield owner
        finally:
            service.local_authority.reset(authority_token)
            _actor.reset(token)

    router = create_router(service, identity, prefix=PREFIX)
    router.include_in_schema = False

    @router.get("/sources", include_in_schema=False)
    async def sources(owner=Depends(identity)):  # noqa: B008
        result = []
        # Only the current owner's project sources; company publications grant
        # use rights, never implicit permission to edit another author's source.
        for p in source_service.store.list(owner):
            a = next(
                (a for a in reversed(p["artifacts"]) if a.get("files") and a.get("snapshot")), None
            )
            if not a:
                continue
            verify(a)
            reason = (
                "WORKSHOP_CAPABILITY_UNSUPPORTED"
                if set(a["manifest"]["capabilities"])
                - {"data", "model", "files", "knowledge", "foundation", "dialogue"}
                else None
            )
            result.append(
                {
                    "id": p["id"],
                    "name": p["name"],
                    "reason": reason,
                    "source": {
                        "format": FORMAT,
                        "allowed": True,
                        "applicationId": p["appId"],
                        "version": a["version"],
                        "sourceHash": digest(a["files"]),
                        "origin": "kaiwu",
                    },
                }
            )
        return {"items": result}

    @router.get("/sources/{project_id}", include_in_schema=False)
    async def source(project_id: str, sourceHash: str, version: str, owner=Depends(identity)):  # noqa: B008
        p = source_service.store.get(owner, project_id)
        a = next(
            (
                a
                for a in p["artifacts"]
                if a.get("files") and a["version"] == version and digest(a["files"]) == sourceHash
            ),
            None,
        )
        if a is None:
            raise StudioError("WORKSHOP_SOURCE_CHANGED", 409)
        verify(a)
        value = {
            "format": FORMAT,
            "allowed": True,
            "applicationId": p["appId"],
            "version": a["version"],
            "files": a["files"],
            "sourceHash": sourceHash,
            "origin": "kaiwu",
        }
        validate_source(value)
        return value

    @router.get("/runtime/{session}/knowledge", include_in_schema=False)
    async def runtime_knowledge(session: str, owner=Depends(identity)):  # noqa: B008
        return await service.knowledge_catalog(owner, session)

    @router.post("/runtime/{session}/knowledge", include_in_schema=False)
    async def select_runtime_knowledge(session: str, body: dict, owner=Depends(identity)):  # noqa: B008
        if set(body) != {"ids"} or not isinstance(body["ids"], list):
            raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
        return await service.select_knowledge(owner, session, body["ids"])

    @router.get("/runtime/{session}/files", include_in_schema=False)
    async def runtime_files(session: str, parent: str = "", owner=Depends(identity)):  # noqa: B008
        current = service.runtime(owner, session)
        if "files" not in current["manifest"]["capabilities"]:
            raise StudioError("CAPABILITY_DENIED", 403)
        result = await service.context_provider.list(owner, "space", parent)
        return {**result, "items": [{**r, "kind": r["itemKind"]} for r in result["items"]]}

    @router.post("/projects/{project_id}/source-update", include_in_schema=False)
    async def source_update(project_id: str, body: SourceUpdate, owner=Depends(identity)):  # noqa: B008
        return await service.update_source(owner, project_id, body.model_dump())

    @router.post("/runtime/{session}/haowen-native", include_in_schema=False)
    async def haowen_native(session: str, body: dict, owner=Depends(identity)):  # noqa: B008
        from .haowen_channels import native

        current = service.runtime(owner, session)
        if "dialogue" not in current["manifest"]["capabilities"]:
            raise StudioError("CAPABILITY_DENIED", 403)
        if str(body.get("action", "")).startswith("channel"):
            from octop.infra.users.permissions import user_has_permission

            user = await to_thread(server.user_manager.get_by_id, int(owner.removeprefix("wanx:")))
            if user is None or not user_has_permission(user, "channels"):
                raise StudioError("HAOWEN_CHANNEL_FORBIDDEN", 403)
        result = await native(service.haowen, current, body)
        service.runtime(owner, session)
        return result

    @router.post("/copies", include_in_schema=False)
    async def copy(body: Copy, owner=Depends(identity)):  # noqa: B008
        return await service.copy_source(owner, body.model_dump())

    from .workshop_management import mount as mount_management

    mount_management(router, service, identity)
    app.include_router(router, include_in_schema=False)
    server.add_shutdown_callback(service.close)
    server._wanx_workshop_service = service
    return service
