"""Required-mode routes. Unknown applications, scopes and operations are denied."""

from __future__ import annotations

import copy
import json
import math
import re
from urllib.parse import urlsplit

from centuarai_local_data_gate.native_policy import (
    FILE,
    MIB,
    application_families,
    classify_octop,
    query_values,
)
from centuarai_local_data_gate.team import team_resource

from .local_data_protocol import DataProtocolError, grants, need
from .semantica import local_data_policy as semantica_policy

METADATA_PATHS = frozenset({"/api/platform/assets/manifest", "/api/platform/version"})
RESOURCES = frozenset({"wanx", "space", "space:personal", "clipboard", "semantica"})
CLIPBOARD_RULES = (
    ("GET", r"(?:/note)?", "read", 0),
    ("PUT", r"/note", "write", 2 * MIB),
    ("POST", r"/(?:batches|manage)", "write", 2 * MIB),
    ("GET", rf"/{FILE}(?:/content)?", "read", 0),
    ("PUT", rf"/{FILE}/content", "write", 4 * MIB),
    ("POST", rf"/{FILE}/(?:complete|export)", "write", MIB),
    ("POST", r"/agent-access", "read", MIB),
)


def business_object(raw):
    def pairs(items):
        value = {}
        for name, item in items:
            need(name not in value)
            value[name] = item
        return value

    def constant(_):
        raise DataProtocolError()

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        need(type(value) is dict)

        def depth(item, level=0):
            need(level <= 32)
            need(type(item) is not float or math.isfinite(item))
            for child in (
                item.values() if type(item) is dict else item if type(item) is list else ()
            ):
                depth(child, level + 1)

        depth(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise DataProtocolError() from None


def _allows(values, resource, action):
    aliases = {"space", "space:personal"}
    return any(
        action in item["actions"]
        and (
            item["resourceId"] == resource
            or item["resourceId"] in aliases
            and resource in aliases
            or item["resourceId"] == "wanx"
            and resource in {"space", "space:personal", "clipboard"}
        )
        for item in values
    )


def _resource(context, resource, action):
    if resource is None:
        resource = next(
            (
                item["resourceId"]
                for item in context["grants"]
                if (
                    item["resourceId"] in RESOURCES
                    or context.get("team")
                    and team_resource(item["resourceId"])
                )
                and action in item["actions"]
            ),
            None,
        )
    need(
        resource is not None and _allows(context["grants"], resource, action),
        "LOCAL_DATA_FORBIDDEN",
    )
    return resource


def application_policy(application_id, launch_id, view):
    families = application_families(application_id)
    need(families is not None, "LOCAL_DATA_ROUTE_DENIED")
    allowed = (
        RESOURCES
        if application_id == "wanx-host"
        else {"semantica"}
        if "semantica" in families
        else {"wanx"}
    )
    if re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", application_id):
        need(
            view.get("team") is not None
            and any(
                value["resourceId"] == "team:application:" + application_id
                for value in view["grants"]
            ),
            "LOCAL_DATA_FORBIDDEN",
        )
        result = []
        for value in view["grants"]:
            if not view.get("team"):
                continue
            if value["resourceId"] == "team:application:" + application_id:
                result.append(copy.deepcopy(value))
            elif "read" in value["actions"] and (
                value["resourceId"] in {"semantica", "wanx"}
                or (team_resource(value["resourceId"]) or (None,))[0] == "knowledge"
            ):
                # No direct data route exists for this application family.
                # Native published-manifest resolution must further freeze the
                # exact sources before the broker permits any read child hop.
                result.append({"resourceId": value["resourceId"], "actions": ["read"]})
        grants(result)
        return result
    result = [
        copy.deepcopy(value)
        for value in view["grants"]
        if value["resourceId"] in allowed
        or view.get("team")
        and team_resource(value["resourceId"])
        and (
            application_id in {"wanx-host", "ai.wanx.studio"}
            or "semantica" in families
            and value["resourceId"].startswith("team:knowledge:")
        )
    ]
    grants(result)
    return result


def _result(context, audience, resource, action, limit, target, service):
    return {
        "audience": audience,
        "resourceId": _resource(context, resource, action),
        "action": action,
        "bodyLimit": limit,
        "upstreamPath": target,
        "serviceContext": service,
    }


def route_policy(context, observation):
    target, method = observation["rawTarget"], observation["method"]
    path = urlsplit(target).path
    query = query_values(target)
    families = application_families(context["applicationId"]) or frozenset()
    selector = observation["headers"]["dataContext"]
    need(
        selector in (None, "personal")
        or team_resource(selector) is not None
        and context.get("team") is not None,
        "LOCAL_DATA_SCOPE_DENIED",
    )
    principal = {
        "kind": "principal",
        "principalNamespace": context["principalNamespace"],
        "clipboardScope": None,
    }
    if path in METADATA_PATHS:
        need(
            "platform" in families
            and method == "GET"
            and observation["transport"] == "http"
            and not query,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return _result(context, "octop", None, "read", 0, target, principal)
    if path.startswith("/api/clipboard/v1"):
        need(
            "clipboard" in families and observation["transport"] == "http",
            "LOCAL_DATA_ROUTE_DENIED",
        )
        need(
            set(query) <= {"kind", "q", "offset", "trash", "since", "length", "expected", "after"},
            "LOCAL_DATA_ROUTE_DENIED",
        )
        for verb, pattern, action, cap in CLIPBOARD_RULES:
            if method == verb and re.fullmatch("/api/clipboard/v1" + pattern, path):
                return _result(
                    context,
                    "clipboard",
                    "clipboard",
                    action,
                    cap,
                    target,
                    {
                        "kind": "clipboard",
                        "principalNamespace": context["principalNamespace"],
                        "applicationId": context["applicationId"],
                    },
                )
        raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
    if path == "/api/semantica/mcp":
        return semantica_policy.mcp_route(context, observation, families=families, result=_result)
    if path.startswith("/api/semantica/"):
        need(
            "semantica" in families and observation["transport"] == "http",
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return semantica_policy.route_policy(context, observation, result=_result)
    # Direct capability access routes carry body-dependent actions. Until their
    # dedicated native resolver exists, only the fixed clipboard child may use them.
    need(
        path not in {"/api/personal-space/agent-access", "/api/personal-space/connection-access"},
        "LOCAL_DATA_ROUTE_DENIED",
    )
    rule = classify_octop(
        method, target, observation["transport"], context["applicationId"], selector
    )
    permission = (
        "resources.manage"
        if rule["family"] == "team-resources"
        else "applications.manage"
        if rule["family"] in {"team-management", "studio"}
        or rule["family"] == "company-runtime"
        and rule["resourceId"] == "team:management"
        else None
    )
    if permission:
        need(
            permission in context.get("team", {}).get("permissions", []), "LOCAL_DATA_SCOPE_DENIED"
        )
    return _result(
        context, "octop", rule["resourceId"], rule["action"], rule["bodyLimit"], target, principal
    )


async def validate_staged(sessions, operation, staging):
    route = operation["route"]
    path = urlsplit(route["upstreamPath"]).path
    await semantica_policy.validate_staged(
        sessions, operation, staging, business_object=business_object
    )
    if route["audience"] == "clipboard" and re.fullmatch(rf"/api/clipboard/v1/{FILE}/export", path):
        body = business_object(await staging.read(MIB))
        need(
            set(body) <= {"expected", "id", "parent", "space_id"}
            and {"expected", "id"} <= set(body)
            and type(body["expected"]) is int
            and body["expected"] > 0
            and body.get("space_id", "personal") == "personal",
            "LOCAL_DATA_SCOPE_DENIED",
        )
        await sessions.bind_clipboard_export(
            operation["operationId"], export_id=body["id"], parent=body.get("parent", "")
        )


def child_policy(parent, body):
    context = parent["context"]
    route = parent["route"]
    target = body["rawTarget"]
    path = urlsplit(target).path
    need(body["transport"] == "http", "LOCAL_DATA_ROUTE_DENIED")
    if body["audience"] == "semantica":
        return semantica_policy.child_policy(parent, body, result=_result, allows=_allows)
    need(
        route["audience"] == "clipboard" and body["audience"] == "octop", "LOCAL_DATA_ROUTE_DENIED"
    )
    allowed = (
        ("POST", r"/api/personal-space/(?:app-folders|uploads)", "write", MIB),
        ("GET", rf"/api/personal-space/(?:uploads/{FILE}|files/{FILE}(?:/content)?)", "read", 0),
        ("PUT", rf"/api/personal-space/uploads/{FILE}", "write", 4 * MIB),
        ("POST", rf"/api/personal-space/uploads/{FILE}/complete", "write", MIB),
        (
            "DELETE",
            rf"/api/personal-space/(?:uploads/{FILE}|files/{FILE}|trash/{FILE})",
            "write",
            0,
        ),
        ("POST", r"/api/personal-space/connection-access", "read", MIB),
    )
    for method, pattern, action, cap in allowed:
        if body["method"] == method and re.fullmatch(pattern, path):
            need(set(query_values(target)) <= {"offset", "length"}, "LOCAL_DATA_ROUTE_DENIED")
            # Parent mutations may read their own source and perform the narrow
            # storage callbacks below. Read parents never write/delete uploads.
            need(action == "read" or route["action"] == "write", "LOCAL_DATA_ROUTE_DENIED")
            if path.endswith("/connection-access"):
                need(
                    route["upstreamPath"] == "/api/clipboard/v1/agent-access"
                    and body["headers"]["spaceLink"] is not None,
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            clipboard_scope = parent["constraints"].get("clipboardScope") or {
                "application": "wanx.clipboard",
                "exportId": None,
                "parent": None,
            }
            return _result(
                context,
                "octop",
                route["resourceId"],
                action,
                cap,
                target,
                {
                    "kind": "principal",
                    "principalNamespace": context["principalNamespace"],
                    "clipboardScope": clipboard_scope,
                },
            )
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
