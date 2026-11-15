"""Private client configuration for a finished application's runtime model."""

from copy import deepcopy

from fastapi import Depends
from pydantic import Field

from .contracts import Operation, StudioError


class RuntimeModel(Operation):
    expectedRevision: int = Field(ge=0)
    modelId: str | None = Field(default=None, min_length=1, max_length=128)


def catalog(svc):
    reader = getattr(svc.model, "runtime_catalog", None)
    if not reader:
        raise StudioError("RUNTIME_MODEL_UPDATE_REQUIRED", 409)
    return reader()


def setting(project, environment=None):
    if isinstance(environment, str) and environment.startswith("deployment:"):
        if environment not in {"deployment:dev", "deployment:prod"}:
            raise StudioError("DEPLOYMENT_ENVIRONMENT_INVALID", 422)
        return project.get("_runtimeModels", {}).get(environment, {})
    return project.get("_runtimeModel", {})


def read(svc, owner, pid, *, environment=None):
    svc.authorize_management(owner)
    p = svc.store.get(owner, pid)
    values = catalog(svc)
    current = setting(p, environment)
    chosen = next((m for m in values["models"] if m["id"] == current.get("modelId")), None)
    return {
        **values,
        "revision": current.get("revision", 0),
        "modelId": current.get("modelId"),
        "selected": chosen,
        "available": not current.get("modelId") or chosen is not None,
        "previousLabel": current.get("label"),
        "usesModel": any("model" in a["manifest"]["capabilities"] for a in p["artifacts"]),
    }


def save(svc, owner, pid, body, *, environment=None, guard=None):
    svc.authorize_management(owner)
    values = catalog(svc)
    chosen = next((m for m in values["models"] if m["id"] == body["modelId"]), None)
    if body["modelId"] and chosen is None:
        raise StudioError("RUNTIME_MODEL_UNAVAILABLE", 409)

    def change(p):
        # Runtime writes may have waited behind deployment activation. Check the
        # original session while holding the same lock as that activation.
        if guard is not None:
            guard()
        if not p["artifacts"]:
            raise StudioError("ARTIFACT_NOT_FOUND", 404)
        if not any("model" in a["manifest"]["capabilities"] for a in p["artifacts"]):
            raise StudioError("RUNTIME_MODEL_NOT_USED", 409)
        current = setting(p, environment)
        if current.get("revision", 0) != body["expectedRevision"]:
            raise StudioError("RUNTIME_MODEL_CHANGED", 409)
        value = {
            "revision": current.get("revision", 0) + 1,
            "modelId": body["modelId"],
            "label": f"{chosen['provider']} · {chosen['name']}" if chosen else None,
        }
        if environment in {"deployment:dev", "deployment:prod"}:
            p.setdefault("_runtimeModels", {})[environment] = value
        else:
            p["_runtimeModel"] = value

    payload = {"action": "runtime-model", **body}
    if environment in {"deployment:dev", "deployment:prod"}:
        payload["environment"] = environment
    svc.store.mutate(owner, pid, body["operationId"], payload, change)
    return read(svc, owner, pid, environment=environment)


def selection(svc, session):
    publisher = session["owner"]
    if "publicationDigest" in session:
        publisher = svc.team.resolve(
            session["owner"], app_id=session["app"], artifact_hash=session["artifact"]
        )["owner"]
    project = svc.store.get(publisher, session["project"], allow_deleted=True)
    return deepcopy(setting(project, session.get("environment"))).get("modelId")


def mount(router, svc, identity):
    from .local_authority import to_thread

    auth = Depends(identity)

    @router.get("/_client/projects/{project_id}/runtime-model", include_in_schema=False)
    async def runtime_model(project_id: str, owner=auth):
        return await to_thread(read, svc, owner, project_id)

    @router.put("/_client/projects/{project_id}/runtime-model", include_in_schema=False)
    async def update_runtime_model(project_id: str, body: RuntimeModel, owner=auth):
        return await to_thread(save, svc, owner, project_id, body.model_dump())
