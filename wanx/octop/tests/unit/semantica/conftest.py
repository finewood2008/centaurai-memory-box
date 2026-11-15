"""Host bindings for tests of the independently owned adapters."""

import pytest
from wanx_bridge.semantica import models

from octop.infra.bridge_dependencies import semantica_model_host


@pytest.fixture(autouse=True)
def model_host_bindings():
    previous = models._host
    models.configure_host(semantica_model_host())
    yield
    models.configure_host(previous)
