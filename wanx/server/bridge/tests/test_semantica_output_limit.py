import pytest
from wanx_bridge.semantica.model_budget import output_budget


def test_requested_16k_budget_preserves_lower_model_cap():
    assert output_budget({'max_output_tokens': 32768}, 16384) == 16384
    assert output_budget({'max_output_tokens': 6144}, 16384) == 6144
    assert output_budget({}, 16384) == 16384
    assert output_budget({'max_output_tokens': 32768}) == 4096
    for value in (True, '16384', 0, -1, 16385):
        with pytest.raises(ValueError):
            output_budget({}, value)
