"""Export the routes registered by WANX Octop without starting the server."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "apps/personal-client/host-sdk/contracts"
sys.path[:0] = [str(ROOT / source) for source in (
    "octop/src",
    "server/bridge",
    "apps/builder/backend",
)]

from fastapi.routing import iter_route_contexts
from starlette.routing import Mount, WebSocketRoute

from octop.api.app import build_app
from octop.config import CapabilitiesConfig, MobileCapabilities, OctopConfig

HTTP_METHODS = {"get", "head", "post", "put", "patch", "delete", "options", "trace"}


async def collect():
    config = OctopConfig(
        enable_dashboard=False,
        enable_api_docs=True,
        capabilities=CapabilitiesConfig(mobile=MobileCapabilities(enabled=True)),
    )
    with TemporaryDirectory(prefix="wanx-api-inventory-") as home:
        shutdown_callbacks = []
        server = SimpleNamespace(
            services=SimpleNamespace(
                config=config,
                settings_repo=SimpleNamespace(get_active_model=lambda: ("", "")),
                provider_repo=SimpleNamespace(list_all=lambda: []),
            ),
            database_bound=True,
            paths=SimpleNamespace(root=Path(home)),
            add_shutdown_callback=shutdown_callbacks.append,
        )
        try:
            with patch.dict(os.environ, {"WANX_STUDIO_ROOT": str(ROOT / "apps/builder")}):
                app = build_app(server)
            schema = app.openapi()
            documented = {
                (method.upper(), path): operation
                for path, item in schema["paths"].items()
                for method, operation in item.items()
                if method in HTTP_METHODS
            }
            operations = {}
            for route in iter_route_contexts(app.routes):
                if isinstance(route.original_route, Mount):
                    if route.path != "/mcp":
                        raise RuntimeError(f"Uncatalogued ASGI mount: {route.path}")
                    for name in app.state.mcp_transports:
                        # Both transports are stateless, so session deletion returns 405.
                        for method in ("GET", "POST"):
                            operations[method, f"/mcp/{name}"] = ("mcp", "Streamable HTTP")
                    continue
                if isinstance(route.original_route, WebSocketRoute):
                    # FastAPI stores the prefixed WebSocket on the included route context.
                    effective = getattr(route, "starlette_route", None) or route.original_route
                    operations["WS", effective.path_format] = ("websocket", "WebSocket")
                    continue
                if not route.path_format or not route.methods:
                    raise RuntimeError(f"Uncatalogued route: {route.original_route!r}")
                for method in route.methods:
                    key = (method, route.path_format)
                    tags = documented.get(key, {}).get("tags") or getattr(route, "tags", None)
                    module = route.endpoint.__module__
                    fallback = "octop-service" if module == "octop.api.app" else module.removeprefix(
                        "octop.api.routers."
                    ).split(".")[0]
                    group = (tags or [fallback])[0]
                    operations[key] = (group, "OpenAPI" if key in documented else "未纳入 OpenAPI")
            if missing := documented.keys() - operations.keys():
                raise RuntimeError(f"OpenAPI operations missing from route inventory: {sorted(missing)}")
        finally:
            for callback in reversed(shutdown_callbacks):
                await callback()
    return schema, operations


def render(schema, operations):
    supplemental = [
        {"method": method, "path": path,
         "group": "starlink" if group == "semantica" or path == "/mcp/starlink" else group,
         "type": transport}
        for (method, path), (group, transport) in sorted(
            operations.items(), key=lambda item: (item[0][1], item[0][0])
        )
        if transport != "OpenAPI"
    ]
    return split_modules(schema, supplemental)


def component_refs(value):
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/"):
            kind, name, *_ = ref.removeprefix("#/components/").split("/")
            yield kind, name
        for child in value.values():
            yield from component_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from component_refs(child)


def module_components(paths, components):
    required = defaultdict(dict)
    pending = list(component_refs(paths))
    while pending:
        kind, name = pending.pop()
        if name not in required[kind]:
            component = components[kind][name]
            required[kind][name] = component
            pending.extend(component_refs(component))
    return {kind: dict(sorted(items.items())) for kind, items in sorted(required.items())}


def application_contract():
    source = json.loads((CONTRACTS / "api.openapi.json").read_text(encoding="utf-8"))
    shared_schemas = {}

    def rewrite(value):
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {key: rewrite(item) for key, item in value.items()}
        for key in ("x-wanx-request-schema", "x-wanx-response-schema"):
            if isinstance(result.get(key), str) and result[key].startswith("schemas/"):
                result[key] = "../" + result[key]
        ref = result.get("$ref", "")
        if ref.startswith("#/components/"):
            kind, name = ref.removeprefix("#/components/").split("/", 1)
            result["$ref"] = f"#/components/{kind}/WanxApp_{name}"
        elif ref.endswith(".schema.json"):
            filename = Path(ref).name
            name = "WanxApp_" + filename.removesuffix(".schema.json")
            if name not in shared_schemas:
                schema = json.loads((CONTRACTS / "schemas" / filename).read_text(encoding="utf-8"))
                # The original schema IDs are preserved in contracts/schemas.
                schema.pop("$id", None)
                shared_schemas[name] = schema
                shared_schemas[name] = rewrite(schema)
            result["$ref"] = f"#/components/schemas/{name}"
        return result

    paths = rewrite(source["paths"])
    components = {
        kind: {f"WanxApp_{name}": rewrite(value) for name, value in items.items()}
        for kind, items in source["components"].items()
        if kind != "securitySchemes"
    }
    components["schemas"].update(shared_schemas)
    return paths, components, source["components"]["securitySchemes"]


def split_modules(schema, supplemental_routes):
    paths_by_module = defaultdict(dict)
    supplemental_by_module = defaultdict(list)
    native_modules = {}
    for path, operations in schema["paths"].items():
        for method, operation in operations.items():
            module = (operation.get("tags") or ["untagged"])[0]
            if module == "semantica":
                module = "starlink"
            paths_by_module[module].setdefault(path, {})[method] = operation
            native_modules[path, method] = module
    for route in supplemental_routes:
        supplemental_by_module[route["group"]].append(route)

    app_paths, app_components, app_security = application_contract()
    app_modules = set()
    for path, operations in app_paths.items():
        inherited_parameters = operations.get("parameters", [])
        for method, contract in operations.items():
            if method == "parameters":
                continue
            if inherited_parameters:
                parameters = {}
                for parameter in [*inherited_parameters, *contract.get("parameters", [])]:
                    ref = parameter.get("$ref")
                    definition = (
                        app_components["parameters"][ref.rsplit("/", 1)[1]] if ref else parameter
                    )
                    parameters[definition["in"], definition["name"]] = parameter
                contract = {**contract, "parameters": list(parameters.values())}
            if path.startswith("/api/semantica/open/v1/"):
                name = "starlink"
            elif method == "x-wanx-websocket":
                name = "websocket"
            else:
                name = native_modules[path, method]
            app_modules.add(name)
            item = paths_by_module[name].setdefault(path, {})
            if method in item:
                item[method] = {
                    **item[method],
                    "x-wanx-application-contract": contract,
                    **{key: value for key, value in contract.items() if key.startswith("x-wanx-")},
                }
            else:
                item[method] = contract

    components = {
        kind: {**schema["components"].get(kind, {}), **app_components.get(kind, {})}
        for kind in schema["components"].keys() | app_components.keys()
    }
    files = {}
    index = []
    for name in sorted(paths_by_module.keys() | supplemental_by_module.keys()):
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        filename = f"{slug}.openapi.json"
        output_path = f"octop-modules/{filename}"
        if not slug or output_path in files:
            raise RuntimeError(f"Invalid or duplicate module filename for {name}")
        paths = paths_by_module[name]
        supplemental = supplemental_by_module[name]
        tags = {tag for operations in paths.values()
                for operation in operations.values() for tag in operation.get("tags", [])}
        module = {
            "openapi": schema["openapi"],
            "info": {**schema["info"], "title": f'WANX Octop · {name}'},
            "paths": paths,
            "components": {
                **module_components(paths, components),
                "securitySchemes": {
                    **schema["components"]["securitySchemes"],
                    **(app_security if name == "starlink" else {}),
                },
            },
            "tags": [tag for tag in schema.get("tags", []) if tag["name"] in tags],
            "x-wanx-supplemental-routes": supplemental,
        }
        if name in app_modules:
            module.update({
                "x-wanx-contract": "wanx-business-api/1",
                "x-wanx-catalog": "../api-catalog.v1.json",
                "x-wanx-permissions": "../permissions.v1.json",
            })
        files[output_path] = module
        index.append({
            "name": name,
            "file": filename,
            "httpOperations": sum(
                method in HTTP_METHODS for operations in paths.values() for method in operations
            ),
            "supplementalRoutes": len(supplemental),
        })
    files["octop-modules/index.json"] = {"modules": index}
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the committed snapshot is stale")
    args = parser.parse_args()
    files = render(*asyncio.run(collect()))
    previous_modules = {
        path.relative_to(CONTRACTS).as_posix()
        for path in (CONTRACTS / "octop-modules").glob("*.openapi.json")
    }
    if (CONTRACTS / "octop.openapi.json").is_file():
        previous_modules.add("octop.openapi.json")
    for name in sorted(previous_modules - files.keys()):
        if args.check:
            raise SystemExit(f"Stale Octop API module: {name}")
        (CONTRACTS / name).unlink()
    for name, document in files.items():
        destination = CONTRACTS / name
        contents = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        if args.check:
            if not destination.is_file() or destination.read_text(encoding="utf-8") != contents:
                raise SystemExit(f"Stale Octop API snapshot: {name}")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents, encoding="utf-8")
    print(f"{len(files) - 1} Octop module documents and their index")


if __name__ == "__main__":
    main()
