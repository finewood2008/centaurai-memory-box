"""Personal miniapp runtime extensions. Grants never live in editable app data."""

import re
from copy import deepcopy

from .contracts import StudioError
from .local_authority import to_thread


class PersonalRuntime:
    def source_grants(self, session):
        p = self.store.get(session["owner"], session["project"])
        return deepcopy(p.get("_runtimeSources", {}).get(session["environment"], {}))

    def remember_sources(self, session, kind, ids, *, guard=None):
        with self.store.transaction():
            if guard is not None:
                guard()
            p = self.store.get(session["owner"], session["project"])
            grants = p.setdefault("_runtimeSources", {}).setdefault(session["environment"], {})
            grants[kind] = list(dict.fromkeys(grants.get(kind, []) + ids))
            self.store.save(p)

    async def select_files(self, owner, token, ids):
        result = await super().select_files(owner, token, ids)
        current = self.runtime(owner, token)
        if "_probeFiles" not in current:
            await to_thread(
                self.remember_sources, current, "files", [r["id"] for r in result],
                guard=lambda: self.runtime(owner, token),
            )
        self.runtime(owner, token)
        return result

    async def knowledge_catalog(self, owner, token):
        s = self.runtime(owner, token)
        if "knowledge" not in s["manifest"]["capabilities"]:
            raise StudioError("CAPABILITY_DENIED", 403)
        provider = getattr(self, "knowledge_provider", None)
        if provider is None:
            raise StudioError("KNOWLEDGE_UNAVAILABLE", 409)
        result = await provider.catalog(owner)
        self.runtime(owner, token)
        return {"items": result}

    async def select_knowledge(self, owner, token, ids):
        if len(ids) > 10 or any(not isinstance(i, str) for i in ids):
            raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
        available = {r["id"]: r for r in (await self.knowledge_catalog(owner, token))["items"]}
        if any(i not in available for i in ids):
            raise StudioError("KNOWLEDGE_NOT_SELECTED", 403)
        await to_thread(
            self.remember_sources, self.runtime(owner, token), "knowledge", ids,
            guard=lambda: self.runtime(owner, token),
        )
        self.runtime(owner, token)
        return [available[i] for i in dict.fromkeys(ids)]

    async def invoke(self, owner, token, method, params):
        s = self.runtime(owner, token)
        if method in {"model.list", "model.select"}:
            if "model" not in s["manifest"]["capabilities"]:
                raise StudioError("CAPABILITY_DENIED", 403)
            from .delivery import RuntimeModel, read, save

            if method == "model.list" and not params:
                result = await to_thread(read, self, owner, s["project"], environment=s["environment"])
                self.runtime(owner, token)
                return result
            if method == "model.select":
                try:
                    body = RuntimeModel.model_validate(params).model_dump()
                except ValueError:
                    raise StudioError("MODEL_INPUT_INVALID", 422) from None
                result = await to_thread(
                    save, self, owner, s["project"], body, environment=s["environment"],
                    guard=lambda: self.runtime(owner, token),
                )
                self.runtime(owner, token)
                return result
            raise StudioError("MODEL_INPUT_INVALID", 422)
        if method == "files.read":
            if "_probeFiles" in s:
                return await super().invoke(owner, token, method, params)
            if "files" not in s["manifest"]["capabilities"]:
                raise StudioError("CAPABILITY_DENIED", 403)
            if set(params) != {"id"} or params["id"] not in (
                await to_thread(self.source_grants, s)
            ).get("files", []):
                # Keep nonpersistent probe sessions compatible.
                return await super().invoke(owner, token, method, params)
            result = await self.files(owner, [params["id"]])
            self.runtime(owner, token)
            if len(result) != 1 or result[0]["id"] != params["id"]:
                raise StudioError("FILE_NOT_SELECTED", 403)
            return result[0]
        if method.startswith("knowledge."):
            if "knowledge" not in s["manifest"]["capabilities"]:
                raise StudioError("CAPABILITY_DENIED", 403)
            action = method.split(".")[1]
            if action not in {"search", "documents", "evidence", "graph"}:
                raise StudioError("METHOD_NOT_ALLOWED", 403)
            if set(params) - {"warehouseId", "query", "id", "limit"}:
                raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
            warehouse = params.get("warehouseId")
            if warehouse not in (await to_thread(self.source_grants, s)).get("knowledge", []):
                raise StudioError("KNOWLEDGE_NOT_SELECTED", 403)
            available = await self.knowledge_catalog(owner, token)
            if not any(r["id"] == warehouse for r in available["items"]):
                raise StudioError("KNOWLEDGE_ACCESS_REVOKED", 403)
            result = await self.knowledge_provider.read(owner, action, params)
            self.runtime(owner, token)
            # Check ownership/permission again before delivering an in-flight result.
            available = await self.knowledge_catalog(owner, token)
            if not any(r["id"] == warehouse for r in available["items"]):
                raise StudioError("KNOWLEDGE_ACCESS_REVOKED", 403)
            return result
        return await super().invoke(owner, token, method, params)


class PersonalKnowledge:
    """Read only the live actor's private Starlink scope; no team bearer/bindings."""

    def __init__(self, sources):
        self.sources = sources

    async def catalog(self, owner):
        try:
            if self.sources.context(owner) is not None:
                await self.sources.request(owner, "GET", "/status")
                return [{"id": "personal", "name": "我的星图知识库"}]
            listing = await self.sources.request(owner, "GET", "/warehouses")
            return [
                {"id": r["id"], "name": r.get("name") or r["id"]}
                for r in listing.get("items", [])
                if r.get("state", "active") == "active"
            ]
        except Exception as exc:
            raise StudioError(
                getattr(exc, "code", "KNOWLEDGE_UNAVAILABLE"), getattr(exc, "status", 409)
            ) from None

    async def read(self, owner, action, params):
        wid = params["warehouseId"]
        local = self.sources.context(owner) is not None
        if (local and wid != "personal") or (not local and not re.fullmatch(r"[a-f0-9-]{36}", wid)):
            raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
        prefix = "" if local else "/warehouses/" + wid
        try:
            if action == "search":
                query = params.get("query")
                limit = params.get("limit", 6)
                if (
                    not isinstance(query, str)
                    or not 1 <= len(query) <= 2000
                    or not isinstance(limit, int)
                    or not 1 <= limit <= 10
                ):
                    raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
                return await self.sources.request(
                    owner, "POST", prefix + "/search", payload={"query": query, "limit": limit}
                )
            if action == "evidence":
                eid = params.get("id", "")
                if not isinstance(eid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", eid):
                    raise StudioError("KNOWLEDGE_INPUT_INVALID", 422)
                return await self.sources.request(owner, "GET", prefix + "/evidence/" + eid)
            return await self.sources.request(owner, "GET", prefix + "/" + action)
        except StudioError:
            raise
        except Exception as exc:
            raise StudioError(
                getattr(exc, "code", "KNOWLEDGE_UNAVAILABLE"), getattr(exc, "status", 409)
            ) from None
