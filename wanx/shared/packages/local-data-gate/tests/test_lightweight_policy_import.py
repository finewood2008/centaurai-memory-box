"""Readiness can validate the required-policy marker without request dependencies."""

import subprocess
import sys
from pathlib import Path


def test_policy_only_import_uses_the_standard_library(tmp_path):
    source = Path(__file__).resolve().parents[1]
    script = """
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from centuarai_local_data_gate import load_required_policy
from centuarai_local_data_gate.config import load_required_policy as config_loader
from centuarai_local_data_gate.protocol import DataProtocolError

assert load_required_policy is config_loader
assert load_required_policy(Path(sys.argv[2]) / 'missing.json') is None
try:
    load_required_policy(Path(sys.argv[2]))
except DataProtocolError as error:
    assert error.code == 'LOCAL_DATA_REQUIRED'
else:
    raise AssertionError('present invalid policy was accepted')
assert 'centuarai_local_data_gate.client' not in sys.modules
assert 'centuarai_local_data_gate.middleware' not in sys.modules
assert 'httpx' not in sys.modules
assert 'cryptography' not in sys.modules
"""
    subprocess.run([sys.executable, "-S", "-c", script, str(source), str(tmp_path)], check=True)
