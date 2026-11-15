"""Trusted server-side port. There is deliberately no renderer-configurable driver.

Implementations use durable management authority, not the submitting HTTP/Host
session. Every external effect must reject stale fencing tokens and be idempotent
on (operation id, step). inspect must distinguish proven not_started from unknown.
Data compensation is legal only before the coordinator's durable commit decision.
"""
from dataclasses import dataclass
from typing import Protocol


PUBLIC_CODES = frozenset({
    "DEPLOYMENT_ADAPTER_UNAVAILABLE", "UPSTREAM_DECISION_REQUIRED",
    "REGRESSION_EVIDENCE_MISMATCH", "RUNTIME_INCOMPATIBLE", "CHANNEL_NOT_READY",
    "BOX_UNREACHABLE", "CLIENT_UNAVAILABLE", "INSUFFICIENT_RESOURCES",
    "DEPENDENCY_UNAVAILABLE", "MIGRATION_NOT_COMPATIBLE", "GENERATION_CONFLICT",
    "UPDATE_REQUIRED", "RECOVERY_REQUIRED", "DEPLOYMENT_TARGET_DENIED",
    "PROVENANCE_INVALID", "ADAPTER_RESULT_INVALID", "ADAPTER_UNCERTAIN",
    "DEPLOYMENT_WAIT_EXPIRED", "DEPLOYMENT_CANCELLED", "VERSION_NOT_PUBLISHED",
})


def public_code(code):
    return code if isinstance(code, str) and code in PUBLIC_CODES else "ADAPTER_UNCERTAIN"


class Blocked(Exception):
    def __init__(self, code="UPSTREAM_DECISION_REQUIRED", state="blocked"):
        self.code = public_code(code)
        self.state = state if state in {"blocked", "waiting_box", "waiting_client"} else "blocked"
        super().__init__(self.code)


@dataclass(frozen=True)
class Plan:
    required_channel_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Observation:
    state: str  # done / not_started / unknown / failed / blocked / waiting_box / waiting_client
    components: tuple[dict, ...] = ()
    checkpoint_ref: dict | None = None
    code: str = "ADAPTER_UNCERTAIN"


class DeploymentAdapter(Protocol):
    # Configuration is trusted process wiring, never an HTTP request field.
    available: bool
    async def authorize(self, owner: str, target: dict, action: str) -> None: ...
    async def verify_release(self, owner: str, bundle: dict) -> None: ...
    async def check(self, operation: dict, bundle: dict | None, phase: str) -> Plan: ...
    async def inspect(self, step: str, operation: dict, bundle: dict | None) -> Observation: ...
    async def execute(self, step: str, operation: dict, bundle: dict | None) -> Observation: ...
    async def deliver(self, receipt: dict) -> str: ...  # Return the acknowledged receiptId.


class UnavailableAdapter:
    """Fail closed until platform owners supply verified management adapters."""
    available = False

    async def authorize(self, owner, target, action):
        raise Blocked("DEPLOYMENT_ADAPTER_UNAVAILABLE")

    async def verify_release(self, owner, bundle):
        raise Blocked("DEPLOYMENT_ADAPTER_UNAVAILABLE")

    async def check(self, operation, bundle, phase):
        raise Blocked("DEPLOYMENT_ADAPTER_UNAVAILABLE")

    async def inspect(self, step, operation, bundle):
        return Observation("unknown", code="DEPLOYMENT_ADAPTER_UNAVAILABLE")

    async def execute(self, step, operation, bundle):
        raise Blocked("DEPLOYMENT_ADAPTER_UNAVAILABLE")

    async def deliver(self, receipt):
        raise Blocked("DEPLOYMENT_ADAPTER_UNAVAILABLE")
