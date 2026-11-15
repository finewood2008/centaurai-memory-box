from types import SimpleNamespace

from wanx_studio.identity_scope import canonical_owner


def test_explicit_admin_alias_maps_one_account_scope():
    admin = SimpleNamespace(id=2, role="admin")
    member = SimpleNamespace(id=2, role="user")
    assert canonical_owner(admin, aliases="2:1") == "wanx:1"
    assert canonical_owner(member, aliases="2:1") == "wanx:2"


def test_invalid_aliases_and_unlisted_admins_remain_stable():
    assert canonical_owner(SimpleNamespace(id=3, role="admin"), aliases="bad,2:x") == "wanx:3"


def test_sso_admin_defaults_to_bootstrap_management_scope():
    assert canonical_owner(SimpleNamespace(id=2, role="admin", username="sso_example")) == "wanx:1"
