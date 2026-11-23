"""Independent native gate: no imports of Octop, Bridge or cloud authentication."""

from importlib import import_module
from typing import TYPE_CHECKING

from .config import GateConfig, load_required_policy

if TYPE_CHECKING:
    from .client import GateContext, GateSemanticaTaskContext, get_context
    from .middleware import LocalDataGateMiddleware

__all__ = [
    "GateConfig",
    "GateContext",
    "GateSemanticaTaskContext",
    "LocalDataGateMiddleware",
    "get_context",
    "load_required_policy",
]


def __getattr__(name):
    # Policy-only processes need neither the broker client nor request middleware.
    if name in {"GateContext", "GateSemanticaTaskContext", "get_context"}:
        module = ".client"
    elif name == "LocalDataGateMiddleware":
        module = ".middleware"
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(__all__))
