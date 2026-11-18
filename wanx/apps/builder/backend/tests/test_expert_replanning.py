"""Reconcile only proven expert capability gaps after explicit configuration."""
from copy import deepcopy

import pytest

from wanx_studio.contracts import StudioError, digest
from test_studio import svc, op
from test_studio_expert_delivery import wire, TEMPLATE, VERIFICATION

REASON = "用户要求调用已显式选择的小通文本专家，需检查来源应用声明的 foundation.invoke 能力与授权是否可用。"
TYPED_GAP = "foundation：" + REASON


@pytest.fixture
async def expert_case(svc, tmp_path, monkeypatch):
    manager, _ = wire(svc, tmp_path)

    async def preflight(**kwargs):
        return {"available": True, "modelCalls": 0}

    async def model(owner, body):
        return {"choices": [{"message": {"content": "WANX_EXPERT_DEPENDENCY_OK"}}]}

    # External transports only; real check, PM tool, configuration, runtime
    # invoke, fingerprint and authority guards remain active.
    monkeypatch.setattr(svc.runner, "preflight", preflight)
    monkeypatch.setattr(svc, "model", model)

    def create():
        p = svc.store.create("alice", "Expert replanning", "输入文本，调用用户选择的文本专家", op(), dev_kit=True)
        svc.preparation.enable("alice", p["id"])
        return p["id"]

    def configure(pid, revision=0, template=TEMPLATE):
        body = {"operationId": op(), "expectedRevision": revision, "template": template,
                "verification": VERIFICATION if template is not None else None}
        return manager.configure("alice", pid, body), body

    async def check(pid):
        return await svc.preparation.check("alice", pid, {"operationId": op()})

    async def handoff(pid, checked):
        return await svc.preparation.handoff("alice", pid, {"expectedRevision": checked["preparation"]["revision"]})

    def begin_pm(pid):
        turn = op()
        def begin(p):
            p["preparation"]["interview"].update(state="running", turnId=turn)
        svc.store.mutate("alice", pid, op(), {}, begin)
        return turn

    def end_pm(pid):
        svc.store.mutate("alice", pid, op(), {}, lambda p: p["preparation"]["interview"].update(state="completed"))

    async def prepare(platform_gap=None, platform_position="after"):
        pid = create()
        await handoff(pid, await check(pid))
        turn = begin_pm(pid)
        async def record_platform():
            message = {"id": op(), "role": "user", "text": "还要调用未开放的外部工单 API"}
            svc.store.mutate("alice", pid, op(), {}, lambda p: p["messages"].append(message))
            await svc.preparation.pm.tool("alice", pid, turn, "record_platform_gap", {
                "expectedHash": digest(svc.store.get("alice", pid)["solution"]), "id": "external-ticket-api",
                "requirement": platform_gap, "reason": "该外部平台没有公开运行合同", "sourceMessageId": message["id"],
            })
        if platform_gap and platform_position == "before":
            await record_platform()
        requested = await svc.preparation.pm.tool("alice", pid, turn, "require_capability", {"capability": "foundation", "reason": REASON})
        assert requested["returnToClient"] is True
        if platform_gap and platform_position == "after":
            await record_platform()
        end_pm(pid)
        configured, request = configure(pid)
        assert configured["configuration"]["contract"]["template"] == TEMPLATE
        assert configured["project"]["preparation"]["phase"] == "intake"
        assert configured["project"]["preparation"]["handoff"] is None
        checked = await check(pid)
        report = checked["preparation"]["report"]
        assert report["required"] == ["foundation"]
        assert report["results"]["foundation"]["status"] == "passed"
        assert report["codex"]["available"] is True
        return pid, checked, request

    return svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare


async def test_selecting_expert_after_pm_gap_reopens_planning_without_approving_development(expert_case):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare()
    # Previously rejected CAPABILITY_CHECK_REQUIRED after all required probes
    # passed, trapping the user before the PM could continue the same project.
    replanned = await handoff(pid, checked)
    assert replanned["preparation"]["phase"] == "acp"
    assert replanned["preparation"]["interview"]["sync"] == "pending"
    assert not replanned["confirmation"] and not replanned["tasks"]
    assert replanned["preparation"]["handoff"]["contracts"]["foundation"]["expertDeployment"]["template"] == TEMPLATE
    current = svc.store.get("alice", pid)
    assert current["preparation"]["gaps"] == [TYPED_GAP]
    assert not replanned["preparation"].get("gapDecisions")
    assert svc.preparation.gaps(current) == []
    public = svc.snapshot("alice", pid)["preparation"]
    assert public["gaps"] == []
    proof = public["resolvedCapabilityGaps"]
    assert len(proof) == 1 and proof[0]["requirement"] == TYPED_GAP
    assert proof[0]["source"] == "current-expert-probe" and proof[0]["status"] == "satisfied"
    assert proof[0]["operationId"] == current["preparation"]["report"]["operationId"]
    assert proof[0]["expertContractDigest"] == digest(current["deploymentExpert"])
    from wanx_studio.scope_decisions import scope_state
    scope = scope_state(current)["capabilityGaps"]
    assert len(scope) == 1 and scope[0]["decision"] is None
    assert scope[0]["technicalResolution"]["source"] == "current-expert-probe"
    from wanx_studio.iterative import proposal
    assert not any("foundation" in item and "现有 WANX 能力尚不支持" in item for item in proposal(current)["missing"])
    svc.preparation.guard("alice", svc.store.get("alice", pid), planning=True)
    with pytest.raises(StudioError, match="PRD_NOT_SYNCHRONIZED"):
        svc.confirm("alice", pid, {"operationId": op(), "solutionHash": digest(svc.store.get("alice", pid)["solution"])})
    repeated = await handoff(pid, checked)
    assert repeated["preparation"]["handoff"]["id"] == replanned["preparation"]["handoff"]["id"]


@pytest.mark.parametrize("platform_gap", ["foundation：调用未开放的外部工单 API", "调用外部平台 API 并自动发布"])
async def test_real_platform_gaps_are_not_resolved_by_prefix_or_expert_selection(expert_case, platform_gap):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare(platform_gap)
    assert svc.store.get("alice", pid)["preparation"]["gaps"] == [TYPED_GAP, platform_gap]
    assert svc.preparation.gaps(svc.store.get("alice", pid)) == [platform_gap]
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await handoff(pid, checked)
    assert not svc.store.get("alice", pid)["preparation"].get("gapDecisions")


async def test_no_prior_handoff_cannot_turn_initial_gap_evidence_into_authority(expert_case):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid = create()
    def historical_intake(p):
        # A historical/imported typed note without a completed handoff is not
        # proof; the public PM tool cannot run in this state.
        p["preparation"]["gaps"] = [TYPED_GAP]
        svc.preparation.event(p, "capability.required", capability="foundation", reason=REASON)
    svc.store.mutate("alice", pid, op(), {}, historical_intake)
    configure(pid)
    checked = await check(pid)
    assert svc.preparation.gaps(svc.store.get("alice", pid)) == [TYPED_GAP]
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await handoff(pid, checked)


@pytest.mark.parametrize("change", ["failed_probe", "running_probe", "stale_report", "other_template", "other_revision", "missing_selection", "missing_report_revision", "missing_report_contract", "changed_verification", "latest_selection_mismatch"])
async def test_stale_or_unproved_expert_evidence_reopens_the_typed_gap(expert_case, monkeypatch, change):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare()
    if change == "failed_probe":
        async def failed(*args):
            raise StudioError("MODEL_UPSTREAM_FAILED", 502)
        monkeypatch.setattr(svc, "model", failed)
        checked = await check(pid)
    else:
        def alter(p):
            prep = p["preparation"]
            if change == "running_probe": prep["currentProbe"]["state"] = "running"
            elif change == "stale_report": prep["revision"] += 1
            elif change == "other_template": prep["report"]["results"]["foundation"]["expertTemplate"]["resourceId"] = "other-expert"
            elif change == "other_revision": p["_deploymentExpertRevision"] += 1
            elif change == "missing_selection": prep["events"] = [e for e in prep["events"] if e["type"] != "expert.contract.selected"]
            elif change == "missing_report_revision": prep["report"].pop("preparationRevision")
            elif change == "missing_report_contract": prep["report"].pop("expertContractDigest")
            elif change == "changed_verification": p["deploymentExpert"]["verification"]["checks"][0]["expected"]["contains"] = "changed"
            elif change == "latest_selection_mismatch": svc.preparation.event(p, "expert.contract.selected", profile="wanx-expert-app-v1", revision=999)
        svc.store.mutate("alice", pid, op(), {}, alter)
        checked = svc.snapshot("alice", pid)
    assert svc.preparation.gaps(svc.store.get("alice", pid)) == [TYPED_GAP]
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await handoff(pid, checked)


async def test_removing_selected_expert_reopens_original_requirement(expert_case):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare()
    configure(pid, revision=1, template=None)
    checked = await check(pid)
    assert svc.store.get("alice", pid)["preparation"]["gaps"] == [TYPED_GAP]
    assert svc.preparation.gaps(svc.store.get("alice", pid)) == [TYPED_GAP]
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await handoff(pid, checked)


async def test_pm_selected_foundation_is_a_supported_contract_requiring_fresh_probe(expert_case):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid = create()
    configure(pid)
    await handoff(pid, await check(pid))
    turn = begin_pm(pid)
    result = await svc.preparation.pm.tool("alice", pid, turn, "require_capability", {"capability": "foundation", "reason": REASON})
    assert result == {"returnToClient": False, "automaticCheck": True}
    current = svc.store.get("alice", pid)
    assert not current["preparation"]["gaps"]
    assert "foundation" in current["preparation"]["required"]
    assert "foundation" in current["solution"]["capabilities"]
    assert current["preparation"]["report"] is None
    end_pm(pid)
    checked = await check(pid)
    assert checked["preparation"]["report"]["results"]["foundation"]["status"] == "passed"


async def test_configuration_retries_cas_and_new_revision_preserve_real_checks(expert_case):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, request = await prepare()
    before = deepcopy(svc.store.get("alice", pid))
    manager.configure("alice", pid, request)
    after = svc.store.get("alice", pid)
    assert after["preparation"]["report"] == before["preparation"]["report"]
    assert after["preparation"]["events"] == before["preparation"]["events"]
    with pytest.raises(StudioError, match="EXPERT_CONTRACT_CHANGED"):
        configure(pid, revision=0)
    changed = {"schemaVersion": 1, "checks": [{"id": "text-roundtrip", "input": {"text": "changed"}, "expected": {"contains": "changed"}}]}
    with pytest.raises(StudioError, match="OPERATION_CONFLICT"):
        manager.configure("alice", pid, {**request, "verification": changed})
    configure(pid, revision=1)
    assert svc.preparation.gaps(svc.store.get("alice", pid)) == [TYPED_GAP]
    checked = await check(pid)
    assert (await handoff(pid, checked))["preparation"]["phase"] == "acp"


@pytest.mark.parametrize("position", ["before", "after", "selected"])
async def test_same_text_platform_requirement_never_becomes_a_technical_resolution(expert_case, position):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    if position in {"before", "after"}:
        pid, checked, _ = await prepare(TYPED_GAP, platform_position=position)
    else:
        pid, checked, _ = await prepare()
        await handoff(pid, checked)
        turn = begin_pm(pid)
        message = {"id": op(), "role": "user", "text": "同一描述还包括一个没有授权的外部接口"}
        svc.store.mutate("alice", pid, op(), {}, lambda p: p["messages"].append(message))
        await svc.preparation.pm.tool("alice", pid, turn, "record_platform_gap", {
            "expectedHash": digest(svc.store.get("alice", pid)["solution"]), "id": "same-text-after-selection",
            "requirement": TYPED_GAP, "reason": "固定文本专家不提供所需外部接口", "sourceMessageId": message["id"],
        })
        end_pm(pid)
        checked = await check(pid)
    current = svc.store.get("alice", pid)
    assert current["preparation"]["gaps"] == [TYPED_GAP]
    assert svc.preparation.gaps(current) == [TYPED_GAP]
    assert not svc.snapshot("alice", pid)["preparation"].get("resolvedCapabilityGaps")
    from wanx_studio.scope_decisions import scope_state
    assert "technicalResolution" not in scope_state(current)["capabilityGaps"][0]
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await handoff(pid, checked)
    assert not current["preparation"].get("gapDecisions")


@pytest.mark.parametrize("historical_state", ["exact", "missing_handoff", "legacy_platform", "legacy_intake", "not_introduced"])
async def test_legacy_typed_event_without_gap_introduced_needs_unambiguous_handoff_provenance(expert_case, historical_state):
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare()
    def restore_old_event(p):
        prep = p["preparation"]
        for event in prep["events"]:
            if event["type"] == "capability.required":
                event.pop("gapIntroduced", None)
                if historical_state == "not_introduced": event["gapIntroduced"] = False
        if historical_state == "missing_handoff":
            prep["events"] = [event for event in prep["events"] if event["type"] != "intake.handed-off"]
            for index, event in enumerate(prep["events"], 1): event["seq"] = index
        elif historical_state == "legacy_platform":
            svc.preparation.event(p, "platform.gap-recorded", gapId="historical-unknown-gap")
        elif historical_state == "legacy_intake":
            svc.preparation.event(p, "intake.updated", operationId=op())
    svc.store.mutate("alice", pid, op(), {}, restore_old_event)
    current = svc.store.get("alice", pid)
    assert current["preparation"]["gaps"] == [TYPED_GAP]
    if historical_state == "exact":
        assert svc.preparation.gaps(current) == []
        assert (await handoff(pid, checked))["preparation"]["phase"] == "acp"
    else:
        assert svc.preparation.gaps(current) == [TYPED_GAP]
        with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
            await handoff(pid, checked)


async def test_frozen_evidence_archives_only_satisfied_typed_gap_and_preserves_live_requirements(expert_case):
    from wanx_studio.versions import frozen
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    external = "foundation：调用未开放的外部工单 API"
    pid, checked, _ = await prepare(external)
    live = svc.store.get("alice", pid)
    frozen_evidence = frozen(live)["preparation"]
    assert frozen_evidence["gaps"] == [external]
    assert [item["requirement"] for item in frozen_evidence["resolvedCapabilityGaps"]] == [TYPED_GAP]
    assert frozen_evidence["resolvedCapabilityGaps"][0]["source"] == "current-expert-probe"
    assert live["preparation"]["gaps"] == [TYPED_GAP, external]
    assert not live["preparation"].get("gapDecisions")


async def test_real_standard_artifact_transfer_archives_resolved_gap_without_importing_authority(expert_case):
    from pathlib import Path
    from wanx_studio import devkit_build
    from wanx_studio.versions import verify
    svc, manager, create, configure, check, handoff, begin_pm, end_pm, prepare = expert_case
    pid, checked, _ = await prepare()
    await handoff(pid, checked)
    # As in the standard pipeline fixture, fixed developer output replaces the
    # developer/model process; real workspace generation, build, package,
    # immutable capture, adoption and cross-owner transfer are exercised.
    def ready(p):
        p["solution"]["capabilities"] = ["data", "foundation"]
        p["preparation"]["interview"].update(state="completed", sync="saved")
        p["confirmation"] = {"hash": digest(p["solution"]), "at": 1}
    svc.store.mutate("alice", pid, op(), {}, ready)
    await handoff(pid, await check(pid))
    current = svc.store.get("alice", pid)
    task = op()
    current["tasks"].append({"id": task, "state": "running", "solutionHash": digest(current["solution"]),
        "instruction": "Synthetic standard developer output", "events": [], "question": None, "buildFormat": "wanx-app-dev-kit"})
    svc.store.save(current)
    workspace = devkit_build.create_workspace(current, svc.project_root, svc.store.root / "tasks" / task)
    current = svc.store.get("alice", pid)
    current["tasks"][-1].update(devKitWorkspace=workspace["root"], devKitSpecHash=workspace["specHash"])
    svc.store.save(current)
    built = await svc.add_artifact("alice", pid, task, devkit_build.mutable_files(Path(workspace["root"])))
    artifact = deepcopy(svc.store.get("alice", pid)["artifacts"][-1])
    verify(artifact)
    assert all(stage["exitCode"] == 0 for stage in artifact["devKitPackage"]["stages"].values())
    evidence = artifact["snapshot"]["preparation"]
    assert evidence["gaps"] == []
    assert [item["requirement"] for item in evidence["resolvedCapabilityGaps"]] == [TYPED_GAP]
    assert svc.store.get("alice", pid)["preparation"]["gaps"] == [TYPED_GAP]
    adopted = svc.versions.adopt("alice", pid, {"operationId": op(), "expectedRevision": built["versioning"]["revision"],
        "artifactHash": artifact["hash"], "confirmedByUser": True})
    assert adopted["versioning"]["adoptedHash"] == artifact["hash"]
    bundle = svc.export_standard_version("alice", pid, artifact["hash"])
    imported = svc.import_standard_version("bob", bundle, op())
    imported_id = imported["id"]
    receiver = svc.store.get("bob", imported_id)
    assert receiver["preparation"]["gaps"] == []
    assert receiver["preparation"]["events"] == []
    assert receiver["preparation"]["report"] is None
    assert not receiver["preparation"].get("resolvedCapabilityGaps")
    assert receiver["preparation"]["handoff"]["report"]["codex"]["available"] is False
    assert receiver["preparation"]["handoff"]["report"]["operationId"] is None
    assert receiver["artifacts"] == [artifact]
    assert receiver["versioning"]["adoptedHash"] is None
    with pytest.raises(StudioError, match="CAPABILITY_CHECK_REQUIRED"):
        await svc.preparation.handoff("bob", imported_id, {"expectedRevision": receiver["preparation"]["revision"]})
    # Current authorization is supplied by the receiving deployment adapter,
    # never copied from export metadata or frozen source proof.
    profile = svc.directory_profile
    def authorize_receiver(owner):
        if owner not in {"alice", "bob"}:
            raise StudioError("STUDIO_ADMIN_REQUIRED", 403)
    profile.authorize_owner = authorize_receiver
    fresh = await svc.preparation.check("bob", imported_id, {"operationId": op()})
    assert fresh["preparation"]["report"]["results"]["foundation"]["status"] == "passed"
    assert fresh["preparation"]["report"]["operationId"] != evidence["report"]["operationId"]
    restored = await svc.preparation.handoff("bob", imported_id, {"expectedRevision": fresh["preparation"]["revision"]})
    assert restored["preparation"]["phase"] == "acp"
    assert restored["preparation"]["handoff"]["report"]["operationId"] == fresh["preparation"]["report"]["operationId"]
    assert not svc.store.get("bob", imported_id)["preparation"].get("gapDecisions")
