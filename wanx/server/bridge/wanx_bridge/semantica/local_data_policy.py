"""Semantica routes and MCP contracts for the shared local data gateway."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from centuarai_local_data_gate import semantica_bootstrap, starlink_workbench
from centuarai_local_data_gate.native_policy import ID, MIB, query_values
from centuarai_local_data_gate.semantica_models import warehouse_workspace
from centuarai_local_data_gate.team import resource_binding_route, team_resource

from ..local_data_protocol import DataProtocolError, need
from . import annotation_contract
from .document_contract import BLOCK_QUERY, validate_block_page

MCP_OPERATIONS = {
    "initialize": "mcp_initialize",
    "notifications/initialized": "mcp_initialized",
    "ping": "mcp_ping",
    "tools/list": "mcp_tools_list",
}
MCP_TOOLS = frozenset({"search_knowledge", "search_workspaces", "get_evidence", "retrieval_status"})
SOURCE_ANNOTATION = rf"/documents/{ID}/source-annotation"
SOURCE_ANNOTATION_OPERATIONS = frozenset({"get_source_annotation", "save_source_annotation"})
SEMANTICA_RULES = (
    ("GET", "/capabilities", "get_capabilities", "read"),
    ("GET", "/status", "get_status", "read"),
    ("GET", "/documents", "list_documents", "read"),
    ("GET", "/jobs", "list_jobs", "read"),
    ("GET", "/retrieval/status", "retrieval_status", "read"),
    ("POST", "/retrieval/indexes", "build_index", "write"),
    ("POST", "/documents", "upload_document", "write"),
    ("GET", rf"/documents/{ID}", "get_document", "read"),
    ("GET", rf"/documents/{ID}/text", "get_document_text", "read"),
    ("GET", rf"/documents/{ID}/blob", "get_document_blob", "read"),
    ("GET", SOURCE_ANNOTATION, "get_source_annotation", "read"),
    ("PUT", SOURCE_ANNOTATION, "save_source_annotation", "write"),
    ("PUT", rf"/documents/{ID}/text", "replace_text_document", "write"),
    ("POST", rf"/documents/{ID}/extraction", "reextract_document", "write"),
    ("DELETE", rf"/documents/{ID}", "delete_document", "write"),
    ("GET", rf"/operations/{ID}", "get_operation_result", "read"),
    ("GET", rf"/jobs/{ID}", "get_job", "read"),
    ("POST", rf"/jobs/{ID}/retry", "retry_job", "write"),
    ("POST", rf"/jobs/{ID}/cancel", "cancel_job", "write"),
    ("POST", "/imports", "begin_import", "write"),
    ("PATCH", rf"/imports/{ID}", "append_import", "write"),
    ("POST", rf"/imports/{ID}/commit", "commit_import", "write"),
    ("POST", "/search", "search_knowledge", "read"),
    ("POST", "/search/workspaces", "search_workspaces", "read"),
    ("GET", rf"/evidence/{ID}", "get_evidence", "read"),
    ("GET", "/graph", "get_graph", "read"),
    ("GET", "/owner/graph", "owner_graph", "read"),
    ("GET", "/ontologies", "list_ontologies", "read"),
    ("POST", "/ontologies", "create_ontology", "write"),
    ("POST", rf"/ontologies/{ID}/publish", "publish_ontology", "write"),
)


def _warehouse(context, operation, resource=None, warehouse=None):
    selected = team_resource(resource)
    warehouse = selected[1] if selected else warehouse
    return {
        "kind": "warehouse",
        "principalNamespace": context["principalNamespace"],
        "workspaceId": warehouse_workspace(context["boxId"], context["principalNamespace"],
            context.get("ownershipEpoch", 0), resource if selected else "semantica", warehouse),
        "warehouseId": warehouse,
        "operation": operation,
    }


def route_policy(context, observation, *, result, native=False):
    target = observation["rawTarget"]
    path = urlsplit(target).path
    prefix = "/api/integration" if native else "/api/semantica"
    suffix = path[len(prefix) :]
    resource = observation["headers"]["dataContext"]
    selected = team_resource(resource)
    if selected:
        need(
            selected[0] == "knowledge" and context.get("team") is not None,
            "LOCAL_DATA_SCOPE_DENIED",
        )
        need(
            re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", selected[1]) is not None,
            "LOCAL_DATA_SCOPE_DENIED",
        )
    else:
        resource = "semantica"
    query = query_values(target)
    bound_warehouse = selected[1] if selected else None
    workbench = re.fullmatch(
        r"/warehouses/(?P<warehouse>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?P<path>/workbench/.*)",
        suffix,
    )
    if workbench or suffix.startswith("/workbench/"):
        if workbench:
            need(not native, "LOCAL_DATA_ROUTE_DENIED")
            if selected:
                need(workbench["warehouse"] == selected[1], "LOCAL_DATA_SCOPE_DENIED")
            bound_warehouse = workbench["warehouse"]
            suffix = workbench["path"]
        else:
            need(native, "LOCAL_DATA_SCOPE_DENIED")
        method = observation["method"]
        operation = starlink_workbench.operation_name(method, suffix)
        need(operation is not None, "LOCAL_DATA_ROUTE_DENIED")
        try:
            starlink_workbench.validate_query(method, suffix, query)
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED") from exc
        action = "read" if method == "GET" else "execute" if selected else "write"
        upstream = "/api/integration" + suffix
        if raw_query := urlsplit(target).query:
            upstream += "?" + raw_query
        return result(
            context,
            "semantica",
            resource,
            action,
            0 if method == "GET" else 2 * MIB,
            upstream,
            _warehouse(context, operation, resource, bound_warehouse),
        )
    scoped = re.fullmatch(r"/warehouses/(?P<warehouse>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?P<path>/.*)?", suffix)
    root_suffix = suffix
    if scoped:
        if selected:
            need(scoped["warehouse"] == selected[1], "LOCAL_DATA_SCOPE_DENIED")
        bound_warehouse = scoped["warehouse"]
        if scoped["path"] and scoped["path"] not in {"/delete", "/delete/prepare"}:
            suffix = scoped["path"]
            if suffix.startswith("/modeling/"):
                workspace = _warehouse(context, "", resource, bound_warehouse)["workspaceId"]
                suffix = "/modeling/warehouses/" + workspace + suffix[len("/modeling"):]
    method = observation["method"]
    operation = semantica_bootstrap.operation_name(method, suffix)
    if operation is not None:
        try:
            semantica_bootstrap.validate_query(method, suffix, query)
            semantica_bootstrap.validate_selection(None, query, bound_warehouse)
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED") from exc
        if re.match(r"/modeling/warehouses/", suffix):
            workspace = _warehouse(context, operation, resource, bound_warehouse)["workspaceId"]
            need(suffix.split("/")[3] == workspace, "LOCAL_DATA_SCOPE_DENIED")
        upstream = "/api/integration" + suffix
        if raw_query := urlsplit(target).query:
            upstream += "?" + raw_query
        return result(context, "semantica", resource,
            "read" if method == "GET" else "execute" if selected else "write",
            0 if method == "GET" else 2 * MIB, upstream,
            _warehouse(context, operation, resource, bound_warehouse))
    need(
        (set(query) - BLOCK_QUERY)
        <= {
            "limit",
            "offset",
            "entity_id",
            "segment_offset",
            "segment_limit",
            "version_id",
            "start",
            "end",
            "length",
            "page_number",
            "expected_sha256",
            "expected_origin_revision",
            "expected_version_id",
            "warehouse_id",
        },
        "LOCAL_DATA_ROUTE_DENIED",
    )
    if "warehouse_id" in query:
        need(
            bound_warehouse is not None and query["warehouse_id"] == bound_warehouse, "LOCAL_DATA_SCOPE_DENIED"
        )
    alias = scoped is not None and scoped["path"] is not None
    if selected and root_suffix.startswith("/warehouses/"):
        alias = False
        suffix = root_suffix
        match = re.fullmatch(r"/warehouses/([^/]+)(/.*)?", suffix)
        need(match is not None and match[1] == selected[1], "LOCAL_DATA_SCOPE_DENIED")
        remainder = match[2] or ""
        if remainder and remainder not in {
            "/clear",
            "/clear/prepare",
        }:
            # Existing warehouse UI aliases map only onto the same finite
            # integration operations. No alias introduces a key/settings API.
            suffix = remainder
            alias = True
    if BLOCK_QUERY.intersection(query):
        need(
            observation["method"] == "GET"
            and re.fullmatch(rf"/documents/{ID}", suffix) is not None,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        try:
            validate_block_page(query)
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED") from exc
    warehouse_rules = (
        (
            ("GET", "/warehouses", "list_warehouses", "read"),
            ("POST", "/warehouses", "create_warehouse", "execute"),
            ("GET", rf"/warehouses/{re.escape(selected[1])}", "get_warehouse", "read"),
            (
                "POST",
                rf"/warehouses/{re.escape(selected[1])}/clear/prepare",
                "prepare_clear_warehouse",
                "execute",
            ),
            ("POST", rf"/warehouses/{re.escape(selected[1])}/clear", "clear_warehouse", "execute"),
        )
        if selected
        else ()
    )
    for method, pattern, operation, action in SEMANTICA_RULES + (() if alias else warehouse_rules):
        if method == observation["method"] and re.fullmatch(pattern, suffix):
            if operation in SOURCE_ANNOTATION_OPERATIONS:
                need(not selected and bound_warehouse is not None, "LOCAL_DATA_SCOPE_DENIED")
                need(not query, "LOCAL_DATA_ROUTE_DENIED")
            if selected:
                need(operation != "owner_graph", "LOCAL_DATA_SCOPE_DENIED")
                if operation in {"build_index", "create_ontology", "publish_ontology"}:
                    action = "execute"
            upstream = target if native else "/api/integration" + target[len(prefix) :]
            if alias:
                upstream = "/api/integration" + suffix
                raw_query = urlsplit(target).query
                if raw_query:
                    upstream += "?" + raw_query
            return result(
                context,
                "semantica",
                resource,
                action,
                0 if method == "GET" else 2 * MIB,
                upstream,
                _warehouse(context, operation, resource, bound_warehouse),
            )
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")


def mcp_route(context, observation, *, families, result):
    method = observation["method"]
    query = query_values(observation["rawTarget"])
    selector = observation["headers"]["dataContext"]
    need(
        "semantica" in families
        and method == "POST"
        and observation["transport"] == "http"
        and not query,
        "LOCAL_DATA_ROUTE_DENIED",
    )
    resource = selector if team_resource(selector) else "semantica"
    if resource != "semantica":
        selected = team_resource(resource)
        need(
            selected[0] == "knowledge"
            and re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", selected[1])
            is not None,
            "LOCAL_DATA_SCOPE_DENIED",
        )
    return result(
        context,
        "semantica-mcp",
        resource,
        "read",
        2 * MIB,
        "/mcp",
        _warehouse(context, "mcp_pending", resource),
    )


async def validate_staged(sessions, operation, staging, *, business_object):
    route = operation["route"]
    path = urlsplit(route["upstreamPath"]).path
    if route["audience"] == "semantica" and route["serviceContext"]["operation"] in SOURCE_ANNOTATION_OPERATIONS:
        method = operation["observation"]["method"]
        need(method != "GET" or staging.length == 0, "LOCAL_DATA_ROUTE_DENIED")
        body = business_object(await staging.read(2 * MIB)) if method != "GET" else None
        try:
            annotation_contract.validate(method, body, query_values(route["upstreamPath"]))
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED") from exc
    if route["audience"] == "semantica" and path.startswith("/api/integration/workbench/"):
        method = operation["observation"]["method"]
        need(method != "GET" or staging.length == 0, "LOCAL_DATA_ROUTE_DENIED")
        body = business_object(await staging.read(2 * MIB)) if method != "GET" else None
        try:
            starlink_workbench.validate_body(method, path[len("/api/integration") :], body)
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED") from exc
    if route["audience"] == "semantica" and semantica_bootstrap.operation_name(
            operation["observation"]["method"], path[len("/api/integration"):]) is not None:
        method = operation["observation"]["method"]
        need(method != "GET" or staging.length == 0, "LOCAL_DATA_ROUTE_DENIED")
        body = business_object(await staging.read(2 * MIB)) if method != "GET" else None
        query = query_values(route["upstreamPath"])
        try:
            semantica_bootstrap.validate_body(method, path[len("/api/integration"):], body)
            semantica_bootstrap.validate_selection(body, query, route["serviceContext"]["warehouseId"])
        except ValueError as exc:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED") from exc
    if route["audience"] == "semantica-mcp":
        body = business_object(await staging.read(2 * MIB))
        need(
            body.get("jsonrpc") == "2.0" and set(body) <= {"jsonrpc", "id", "method", "params"},
            "LOCAL_DATA_ROUTE_DENIED",
        )
        if body.get("method") == "tools/call":
            params = body.get("params")
            need(
                type(params) is dict
                and set(params) <= {"name", "arguments"}
                and type(params.get("name")) is str
                and params.get("name") in MCP_TOOLS
                and type(params.get("arguments", {})) is dict,
                "LOCAL_DATA_ROUTE_DENIED",
            )
            operation_name = params["name"]
        else:
            need(type(body.get("method")) is str, "LOCAL_DATA_ROUTE_DENIED")
            operation_name = MCP_OPERATIONS.get(body.get("method"))
            need(operation_name is not None, "LOCAL_DATA_ROUTE_DENIED")
        await sessions.bind_mcp_operation(operation["operationId"], operation_name)


def child_policy(parent, body, *, result, allows):
    context = parent["context"]
    route = parent["route"]
    if route["audience"] == "octop" and body["audience"] == "semantica":
        need(
            (
                context["applicationId"] in {"wanx-host", "ai.wanx.studio"}
                and route["resourceId"] == "team:management"
                and "applications.manage" in context.get("team", {}).get("permissions", [])
                and resource_binding_route(parent["observation"]["method"], route["upstreamPath"])
            )
            or (
                re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", context["applicationId"])
                is not None
                and route["resourceId"] == "team:application:" + context["applicationId"]
                and parent["observation"]["method"] == "POST"
                and re.fullmatch(
                    r"/api/app-studio/runtime/[A-Za-z0-9_-]{1,128}/invoke", route["upstreamPath"]
                )
                is not None
            ),
            "LOCAL_DATA_ROUTE_DENIED",
        )
        resolved = route_policy(context, body, result=result, native=True)
        need(
            resolved["action"] == "read"
            and resolved["serviceContext"]["operation"]
            in {
                "list_warehouses",
                "get_warehouse",
                "list_documents",
                "get_document",
                "get_document_text",
                "search_knowledge",
                "search_workspaces",
                "get_evidence",
                "get_graph",
            }
            and allows(parent.get("requiredGrants") or [], resolved["resourceId"], "read"),
            "LOCAL_DATA_SCOPE_DENIED",
        )
        return resolved
    if route["audience"] == "semantica-mcp" and body["audience"] == "semantica":
        resolved = route_policy(context, body, result=result, native=True)
        need(
            resolved["serviceContext"]["operation"] == route["serviceContext"]["operation"]
            and resolved["resourceId"] == route["resourceId"]
            and resolved["serviceContext"]["workspaceId"] == route["serviceContext"]["workspaceId"]
            and resolved["action"] == "read"
            and route["serviceContext"]["operation"] in MCP_TOOLS,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return resolved
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
