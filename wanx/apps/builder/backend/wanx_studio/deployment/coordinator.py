"""Persistent deployment control. Platform side effects live behind a trusted port."""
from __future__ import annotations

import asyncio
from contextvars import Context
from copy import deepcopy
from datetime import datetime, timezone
import re
import os
import time
from uuid import uuid4

from ..contracts import StudioError
from ..upgrade_guard import background_lock
from .adapters import Blocked, Observation, Plan, UnavailableAdapter, public_code
from .contracts import (validate_bundle, validate_request, validate_receipt,
                        validate_linked, validate_components, validate_reference,
                        request_digest)
from .journal import Journal

TERMINAL = {"succeeded", "rejected", "failed_recovered", "failed_degraded", "recovery_required"}
ACTIVATIONS = {"deploy", "promote", "rollback"}
SUPPORTED = ["deploy", "promote", "rollback", "restart"]
STEPS = ["validating", "preflight", "prepare_backend", "prepare_client", "prepare_channels",
         "prepare_data", "verify_candidate", "commit", "activate", "verify_active"]
MANAGEMENT = ["validating", "preflight", "commit", "manage", "verify_active"]
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class Coordinator:
    def __init__(self, root, adapter=None, *, clock=time.time, timeout=1800,
                 recovery_timeout=120, step_timeout=10, lease_seconds=45, retry_delay=2, upgrade_root=None):
        if step_timeout <= 0 or lease_seconds <= step_timeout * 3:
            raise ValueError("Deployment lease must exceed three times the adapter timeout")
        self.journal = Journal(root)
        self.adapter = adapter or UnavailableAdapter()
        self.clock, self.timeout, self.recovery_timeout = clock, timeout, recovery_timeout
        self.step_timeout, self.lease_seconds, self.retry_delay = step_timeout, lease_seconds, retry_delay
        self.upgrade_root = upgrade_root
        self.worker_id = uuid4().hex
        self._task = None
        self._closed = False

    def capabilities(self):
        return {"schemaVersion": 1, "available": self.adapter.available is True,
                "reason": None if self.adapter.available is True else "DEPLOYMENT_ADAPTER_UNAVAILABLE",
                "operations": self.supported_actions()}

    def supported_actions(self):
        declared = getattr(self.adapter, "supported_actions", SUPPORTED)
        if not isinstance(declared, (tuple, list)) or any(action not in SUPPORTED for action in declared):
            return []
        return list(dict.fromkeys(declared))

    async def _authorize(self, owner, target, action):
        try:
            outcome = await asyncio.wait_for(self.adapter.authorize(owner, deepcopy(target), action), self.step_timeout)
            if outcome is not None:
                raise Blocked("ADAPTER_RESULT_INVALID")
        except Blocked as error:
            raise StudioError(error.code, 503 if error.code in {"DEPLOYMENT_ADAPTER_UNAVAILABLE", "ADAPTER_RESULT_INVALID"} else 403) from None
        except Exception:
            raise StudioError("DEPLOYMENT_AUTHORITY_UNAVAILABLE", 503) from None

    async def register_release(self, owner, body):
        bundle = validate_bundle(body)
        try:
            result = await asyncio.wait_for(self.adapter.verify_release(owner, deepcopy(bundle)), self.step_timeout)
            if result is not None:
                raise Blocked("ADAPTER_RESULT_INVALID")
        except Blocked as error:
            raise StudioError(error.code, 503 if error.code in {"DEPLOYMENT_ADAPTER_UNAVAILABLE", "ADAPTER_RESULT_INVALID"} else 403) from None
        except Exception:
            raise StudioError("DEPLOYMENT_AUTHORITY_UNAVAILABLE", 503) from None
        return self.journal.register_release(owner, bundle)

    async def submit(self, owner, body):
        request = validate_request(body)
        if request["kind"] not in self.supported_actions():
            raise StudioError("DEPLOYMENT_ACTION_UNAVAILABLE", 503)
        await self._authorize(owner, request["target"], request["kind"])
        reference = request.get("releaseRef") or self.journal.get_environment(request["target"]).get("activeReleaseRef")
        if reference:
            self.journal.release(owner, request["target"]["applicationId"], reference)
        elif request["kind"] not in ACTIVATIONS:
            raise StudioError("DEPLOYMENT_RELEASE_REQUIRED", 409)
        op = self.journal.submit(owner, request, request_digest(request), self.clock(), self.clock() + self.timeout)
        self.start()
        return self.public_operation(op)

    async def environment(self, owner, target):
        await self._authorize(owner, target, "read")
        return self.journal.get_environment(target)

    def operation(self, owner, operation_id):
        return self.public_operation(self.journal.get_operation(owner, operation_id))

    def operations(self, owner, target=None, limit=50):
        return [self.public_operation(op) for op in self.journal.list_operations(owner, target, limit)]

    async def resume(self, owner, operation_id):
        op = self.journal.get_operation(owner, operation_id)
        await self._authorize(owner, op["target"], op["request"]["kind"])
        # No request edits and no new idempotency key. A live lease remains authoritative.
        self.start()
        return self.public_operation(op)

    async def recover(self, owner, operation_id):
        """Internal trusted-coordinator entry only; deliberately absent from HTTP."""
        original = self.journal.get_operation(owner, operation_id)
        if original["request"]["kind"] not in {*SUPPORTED, "recover"}:
            raise StudioError("RECOVERY_ACTION_UNSUPPORTED", 409)
        await self._authorize(owner, original["target"], "recover")
        op = self.journal.create_recovery(owner, operation_id, self.clock(), self.clock() + self.recovery_timeout)
        self.start()
        return self.public_operation(op)

    @staticmethod
    def public_operation(op):
        # Never expose driver authority, lease identity or private checkpoints to a renderer.
        result = {key: deepcopy(op[key]) for key in (
            "id", "target", "state", "phase", "revision", "createdAt", "updatedAt", "deadline",
            "commitStatus", "committedGeneration", "previousGeneration", "components", "errorCode",
        ) if key in op} | {"kind": op["request"]["kind"], "releaseRef": deepcopy(op["request"].get("releaseRef"))}
        # Older successful records may carry a resolved waiting diagnostic.
        # Correct the public read model without rewriting immutable history.
        if op["state"] == "succeeded":
            result["errorCode"] = None
        return result

    def start(self):
        if self._closed:
            raise StudioError("DEPLOYMENT_SERVICE_CLOSED", 503)
        if self._task is None or self._task.done():
            # Do not inherit the HTTP/Host ContextVar authority into a durable worker.
            self._task = asyncio.create_task(self._run(), context=Context())

    async def close(self):
        if self._closed:
            return
        self._closed = True
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self.journal.close()

    async def _run(self):
        while not self._closed:
            try:
                for pending in self.journal.pending(self.clock()):
                    await self.process_once(pending["id"])
                await self.deliver_pending()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A bad adapter cannot terminate durable scheduling or leak exception text.
                pass
            await asyncio.sleep(self.retry_delay)

    def _save(self, op, *, environment=None, receipt=None, event=None):
        return self.journal.save(op, self.worker_id, op["fence"], self.clock(),
                                 event=event or {"type": "progress", "state": op["state"], "phase": op["phase"]},
                                 environment=environment, receipt=receipt)

    def _bundle(self, op):
        ref = op["request"].get("releaseRef")
        if not ref:
            ref = self.journal.get_environment(op["target"]).get("activeReleaseRef")
        return self.journal.release(op["owner"], op["target"]["applicationId"], ref) if ref else None

    async def _check(self, op, bundle, phase):
        plan = await asyncio.wait_for(self.adapter.check(deepcopy(op), deepcopy(bundle), phase), self.step_timeout)
        if not isinstance(plan, Plan) or len(plan.required_channel_ids) > 128:
            raise Blocked("ADAPTER_RESULT_INVALID")
        channels = list(plan.required_channel_ids)
        if any(not isinstance(value, str) or not ID.fullmatch(value) for value in channels) or len(set(channels)) != len(channels):
            raise Blocked("ADAPTER_RESULT_INVALID")
        frozen = op["checkpoint"].get("requiredChannels")
        if frozen is not None and frozen != channels:
            raise Blocked("REGRESSION_EVIDENCE_MISMATCH")
        op["checkpoint"]["requiredChannels"] = channels

    async def _observe(self, step, op, bundle):
        async def call(method):
            observation = await asyncio.wait_for(method(step, deepcopy(op), deepcopy(bundle)), self.step_timeout)
            if not isinstance(observation, Observation) or observation.state not in {
                "done", "not_started", "unknown", "failed", "blocked", "waiting_box", "waiting_client"
            }:
                raise Blocked("ADAPTER_RESULT_INVALID")
            components = validate_components(list(observation.components))
            ids = [item["componentId"] for item in components]
            counts = [sum(item["required"] and item["role"] == role for item in components) for role in ("backend", "client")]
            if len(set(ids)) != len(ids) or any(count > 1 for count in counts) or len(components) + counts.count(0) > 128:
                raise Blocked("ADAPTER_RESULT_INVALID")
            for item in components:
                if "error" in item:
                    item["error"] = {"code": public_code(item["error"].get("code")), "owner": "deployment",
                                     "stage": step, "retryable": bool(item["error"].get("retryable"))}
            reference = validate_reference(observation.checkpoint_ref) if observation.checkpoint_ref is not None else None
            return Observation(observation.state, tuple(components), reference, public_code(observation.code))
        observation = await call(self.adapter.inspect)
        if observation.state == "not_started":
            observation = await call(self.adapter.execute)
            if observation.state == "not_started":
                raise Blocked("ADAPTER_RESULT_INVALID")
        return observation

    async def process_once(self, operation_id):
        lock = None
        if self.upgrade_root is not None and os.name == "posix":
            try:
                lock = await background_lock(self.upgrade_root)
            except StudioError as error:
                if error.code == "BUILDER_UPGRADE_BUSY":
                    return  # Durable work remains pending; do not claim or age its lease.
                raise
        try:
            return await self._process_once(operation_id)
        finally:
            if lock:
                lock.close()

    async def _process_once(self, operation_id):
        op = self.journal.claim(operation_id, self.worker_id, self.clock(), self.lease_seconds)
        if not op:
            return
        try:
            try:
                bundle = self._bundle(op)
            except StudioError:
                op["errorCode"] = "VERSION_NOT_PUBLISHED"
                self._finish(op, "failed_degraded" if op["commitStatus"] == "committed" else "recovery_required" if op["checkpoint"].get("intent") else "rejected")
                return
            for _ in range(1):
                if op["state"] in TERMINAL:
                    return
                phase = op["phase"]
                if self.clock() >= op["checkpoint"].get("compensationDeadline", op["deadline"]):
                    op = self._expired(op)
                    if op["state"] in TERMINAL:
                        return
                    phase = op["phase"]
                try:
                    op["checkpoint"].setdefault("previousHealth", self.journal.get_environment(op["target"])["health"])
                    if phase in {"validating", "preflight", "commit"}:
                        await self._check(op, bundle, phase)
                        op["errorCode"] = None
                        if phase == "commit":
                            op = self._commit(op)
                        else:
                            steps = STEPS if op["request"]["kind"] in ACTIVATIONS else MANAGEMENT
                            op["phase"] = steps[steps.index(phase) + 1]
                            op["state"] = "preflight" if phase == "validating" else "preparing"
                            op = self._save(op)
                        continue
                    if phase == "recover":
                        await self._check(op, bundle, "recover")
                    # Persist an intent BEFORE querying/performing the external effect.
                    op["checkpoint"]["intent"] = {"step": phase, "inputDigest": op["requestHash"]}
                    op = self._save(op)
                    observation = await self._observe(phase, op, bundle)
                    if observation.checkpoint_ref:
                        op["checkpoint"]["adapterRef"] = observation.checkpoint_ref
                    if observation.components or phase in {"verify_active", "recover"}:
                        op["components"] = list(observation.components)
                    if observation.state != "done":
                        op["errorCode"] = observation.code
                        if observation.state == "failed":
                            op = self._failed(op, observation.code)
                            if op["state"] in TERMINAL:
                                return
                            if op["phase"] == "compensate" and phase != "compensate":
                                continue
                        else:
                            op["state"] = observation.state if observation.state in {"blocked", "waiting_box", "waiting_client"} else "reconciling"
                            op = self._save(op)
                        return
                    if phase not in {"compensate", "recover"}:
                        # The previous wait/block has resolved. Failure recovery
                        # keeps its originating error until its own final outcome.
                        op["errorCode"] = None
                    if phase in {"verify_active", "recover"}:
                        if phase == "recover" and op["commitStatus"] != "committed":
                            self._finish(op, "failed_recovered")
                        else:
                            self._finish(op, "succeeded")
                        return
                    if phase == "compensate":
                        self._finish(op, "failed_recovered")
                        return
                    op["checkpoint"].setdefault("completed", []).append(phase)
                    steps = STEPS if op["request"]["kind"] in ACTIVATIONS else MANAGEMENT
                    op["phase"] = steps[steps.index(phase) + 1]
                    op["state"] = "verifying" if op["phase"].startswith("verify") else "preparing"
                    op = self._save(op)
                except Blocked as error:
                    op["errorCode"] = error.code
                    if phase == "commit":
                        op = self._failed(op, error.code)
                        continue
                    op["state"] = error.state if op["commitStatus"] != "committed" else "reconciling"
                    op = self._save(op)
                    return
                except (TimeoutError, OSError):
                    op["state"], op["errorCode"] = "reconciling", "ADAPTER_UNCERTAIN"
                    op = self._save(op)
                    return
                except StudioError as error:
                    if error.code in {"LEASE_LOST", "DEPLOYMENT_LEASE_LOST", "FENCING_CONFLICT", "OPERATION_TERMINAL", "DEPLOYMENT_OPERATION_TERMINAL"}:
                        return
                    op["state"], op["errorCode"] = "reconciling", "ADAPTER_RESULT_INVALID"
                    op = self._save(op)
                    return
                except Exception:
                    op["state"], op["errorCode"] = "reconciling", "ADAPTER_UNCERTAIN"
                    op = self._save(op)
                    return
        finally:
            # Cancellation leaves the durable intent intact. Next worker INSPECTS it.
            try:
                self.journal.release_claim(operation_id, self.worker_id, op["fence"], self.clock(), self.retry_delay)
            except StudioError:
                pass

    def _commit(self, op):
        environment = self.journal.get_environment(op["target"])
        if environment["generation"] != op["request"]["expectedGeneration"]:
            return self._failed(op, "GENERATION_CONFLICT")
        kind = op["request"]["kind"]
        generation = environment["generation"] + (1 if kind in ACTIVATIONS else 0)
        op["commitStatus"], op["committedGeneration"] = "committed", generation
        op["phase"], op["state"] = ("activate" if kind in ACTIVATIONS else "manage"), "committing"
        return self._save(op, environment={"generation": generation, "health": "maintenance",
            "activeReleaseRef": op["request"].get("releaseRef") or environment.get("activeReleaseRef")})

    def _failed(self, op, code):
        op["errorCode"] = public_code(code)
        if op["commitStatus"] == "committed":
            op["state"] = "reconciling"
            return self._save(op)
        if op["phase"] in {"compensate", "recover"}:
            return self._finish(op, "recovery_required")
        if not op["checkpoint"].get("intent"):
            return self._finish(op, "rejected")
        op["phase"], op["state"] = "compensate", "compensating"
        op["checkpoint"]["compensationDeadline"] = self.clock() + self.recovery_timeout
        return self._save(op)

    def _expired(self, op):
        op["errorCode"] = "DEPLOYMENT_WAIT_EXPIRED"
        if op["commitStatus"] == "committed":
            return self._finish(op, "failed_degraded")
        if op["phase"] in {"compensate", "recover"}:
            return self._finish(op, "recovery_required")
        return self._failed(op, "DEPLOYMENT_WAIT_EXPIRED")

    def _finish(self, op, outcome):
        if outcome == "succeeded":
            op["errorCode"] = None
        environment = self.journal.get_environment(op["target"])
        kind = op["request"]["kind"]
        release_ref = op["request"].get("releaseRef") or environment.get("activeReleaseRef")
        components = deepcopy(op["components"])
        if op["commitStatus"] == "committed" and outcome != "succeeded":
            # Missing observation is explicit unknown, never an invented success.
            for role in ("backend", "client"):
                if not any(c["role"] == role and c["required"] for c in components):
                    component_id = role
                    while any(c["componentId"] == component_id for c in components):
                        component_id = "missing_" + uuid4().hex
                    components.append({"componentId": component_id, "role": role, "required": True,
                                       "status": "unknown", "actualReleaseRef": None, "actualVersion": None})
        receipt = {"schemaVersion": 1, "receiptId": uuid4().hex, "operationId": op["id"],
            "operationRevision": op["revision"] + 1, "kind": kind, "target": op["target"],
            "requestedReleaseRef": release_ref, "previousGeneration": op["previousGeneration"],
            "committedGeneration": op["committedGeneration"], "environmentRevision": environment["revision"] + 1,
            "commitStatus": op["commitStatus"], "outcome": outcome, "componentResults": components,
            "observedAt": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "correlationId": op["id"]}
        if outcome != "succeeded":
            receipt["error"] = {"code": public_code(op.get("errorCode")), "owner": "deployment",
                                "stage": op["phase"], "retryable": outcome in {"failed_recovered", "failed_degraded", "recovery_required"}}
        if outcome in {"failed_degraded", "recovery_required"}:
            receipt["recoveryRef"] = {"id": op["id"], "revision": op["revision"] + 1}
        if kind == "recover":
            receipt["recoveryOf"] = op["request"]["recoveryOf"]
            original = self.journal.receipt(op["owner"], receipt["recoveryOf"])["receipt"]
            receipt["checkpointRef"] = deepcopy(original["recoveryRef"])
        validate_receipt(receipt)
        if outcome == "succeeded" and kind != "recover":
            bundle = self._bundle(op)
            if bundle is None:
                raise StudioError("DEPLOYMENT_RELEASE_REQUIRED", 409)
            validate_linked(bundle, op["request"], receipt, op["checkpoint"]["requiredChannels"])
        elif outcome == "succeeded":
            channels = op["checkpoint"].get("requiredChannels", [])
            if {c["componentId"] for c in components if c["role"] == "channel" and c["required"]} != set(channels):
                raise StudioError("REQUIRED_CHANNEL_MISSING", 422)
            for channel in channels:
                if not any(c["role"] == "channel" and c["componentId"] == channel and c["required"] and c["status"] == "ready" for c in components):
                    raise StudioError("REQUIRED_CHANNEL_MISSING", 422)
        health = op["checkpoint"].get("previousHealth", "empty") if outcome == "failed_recovered" else "healthy" if outcome == "succeeded" else "degraded" if outcome == "failed_degraded" else "recovery_required" if outcome == "recovery_required" else environment["health"]
        patch = {"health": health}
        if outcome == "succeeded" and kind in {"stop", "uninstall", "purge"}:
            patch["health"] = "stopped" if kind == "stop" else "uninstalled"
            if kind in {"uninstall", "purge"}:
                patch["activeReleaseRef"] = None
        op["state"], op["components"] = outcome, components
        return self._save(op, environment=patch, receipt=receipt, event={"type": "completed", "state": outcome})

    async def deliver_pending(self, *, owner=None, operation_id=None):
        if not self.journal.outbox_pending(self.clock(), owner=owner, operation_id=operation_id):
            return
        lock = None
        if self.upgrade_root is not None and os.name == "posix":
            try:
                lock = await background_lock(self.upgrade_root)
            except StudioError as error:
                if error.code == "BUILDER_UPGRADE_BUSY":
                    return
                raise
        try:
            await self._deliver_pending(owner=owner, operation_id=operation_id)
        finally:
            if lock:
                lock.close()

    async def _deliver_pending(self, *, owner=None, operation_id=None):
        for item in self.journal.outbox_pending(self.clock(), owner=owner, operation_id=operation_id):
            acknowledged = False
            try:
                ack = await asyncio.wait_for(self.adapter.deliver(deepcopy(item["receipt"])), self.step_timeout)
                acknowledged = ack == item["receiptId"]
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            self.journal.record_delivery(item["receiptId"], acknowledged, self.clock(), min(3600, 2 ** min(item["attempts"] + 1, 11)))
