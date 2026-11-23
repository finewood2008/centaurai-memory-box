"""Discovery keeps only bounded capability metadata and verified gateway defaults."""

import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.model_provider_runtime import _models
from wanx_bridge.model_reasoning import reasoning_metadata


def test_exact_verified_gateway_model_receives_toggle_capability():
    model = _models(["deepseek-flash"], "synthetic-secret", base_url="https://token.qeeshu.com/v1")[
        0
    ]
    assert model["reasoning"] is True
    assert model["reasoning_config"]["toggle"] is True
    assert model["reasoning_config"]["efforts"] == ["none", "high"]


@pytest.mark.parametrize(
    "base,model",
    [
        ("https://other.example/v1", "deepseek-flash"),
        ("https://token.qeeshu.com.evil.example/v1", "deepseek-flash"),
        ("https://token.qeeshu.com/another/v1", "deepseek-flash"),
        ("https://token.qeeshu.com/v1", "deepseek-v4-flash"),
    ],
)
def test_no_capability_is_guessed_for_an_unverified_combination(base, model):
    assert "reasoning_config" not in _models([model], "synthetic-secret", base_url=base)[0]


def test_explicit_capability_is_preserved_but_unknown_fields_are_discarded():
    raw = {
        "supported": True,
        "toggle": True,
        "adapter": "openai_reasoning_effort",
        "efforts": ["none", "high"],
        "default_effort": "high",
        "arbitrary": "not-to-be-persisted",
    }
    model = _models([{"id": "custom", "reasoning_config": raw}], "synthetic-secret")[0]
    assert model["reasoning_config"]["adapter"] == "openai_reasoning_effort"
    assert "arbitrary" not in model["reasoning_config"]


@pytest.mark.parametrize(
    "fields", [{"reasoning": False}, {"reasoning_config": {"supported": False}}]
)
def test_explicit_disabled_capability_wins_over_verified_default(fields):
    model = _models(
        [{"id": "deepseek-flash", **fields}],
        "synthetic-secret",
        base_url="https://token.qeeshu.com/v1",
    )[0]
    assert model["reasoning"] is False
    assert model["reasoning_config"] == {"supported": False}


@pytest.mark.parametrize(
    "capability",
    [
        {"adapter": "unknown"},
        {"adapter": "thinking", "toggle": "yes"},
        {"adapter": "thinking", "efforts": ["high", {"bad": True}]},
        {"adapter": "thinking", "efforts": ["synthetic-secret"]},
    ],
)
def test_invalid_capabilities_fail_discovery(capability):
    with pytest.raises(BridgeAuthError):
        _models([{"id": "custom", "reasoning_config": capability}], "synthetic-secret")


def test_status_only_metadata_matches_host_normalization():
    cap = reasoning_metadata(
        {
            "adapter": "status_only",
            "supported": True,
            "default_mode": "disabled",
            "efforts": ["high"],
            "default_effort": "high",
        }
    )
    assert cap["default_mode"] == "enabled"
    assert cap["toggle"] is False and cap["efforts"] == [] and cap["default_effort"] is None


def test_explicit_negative_capability_overrides_host_known_model_inference():
    from octop.infra.agents.providers.reasoning import reasoning_capability

    model = _models([{"id": "deepseek-v4-flash-202605", "reasoning": False}], "synthetic-secret")[0]
    assert reasoning_capability(model, base_url="http://proxy/v1") is None
