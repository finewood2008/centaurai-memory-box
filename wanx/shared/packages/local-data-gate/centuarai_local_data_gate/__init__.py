"""Independent native gate: no imports of Octop, Bridge or cloud authentication."""

from .client import GateContext, GateSemanticaTaskContext, get_context
from .config import GateConfig, load_required_policy
from .middleware import LocalDataGateMiddleware

__all__ = [
    "GateConfig",
    "GateContext",
    "GateSemanticaTaskContext",
    "LocalDataGateMiddleware",
    "get_context",
    "load_required_policy",
]
