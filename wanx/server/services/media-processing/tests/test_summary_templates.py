import pytest

from wanx_media import summary_templates as templates
from wanx_media.store import Problem, Store


@pytest.fixture
def template_store(tmp_path):
    store = Store(tmp_path)
    with store.db() as db:
        templates.initialize(db)
    return store


@pytest.fixture
def grant():
    return {
        "id": "old-grant",
        "box": "box-a",
        "user": "alice",
        "space": "personal",
        "instance": "desktop-a",
    }


def test_builtin_and_scoped_default_lifecycle(template_store, grant):
    with template_store.db() as db:
        public = templates.list_templates(db, grant)
        builtin = public["templates"][0]
        assert builtin["id"] == templates.BUILTIN_TEMPLATE_ID
        assert public["defaultTemplateId"] == builtin["id"]
        assert builtin["isBuiltin"] is True
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_IMMUTABLE"):
            templates.delete_template(db, grant, builtin["id"], builtin["revision"])
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_IMMUTABLE"):
            templates.update_template(
                db, grant, builtin["id"], "新名称", "新要求", 1
            )

        first = templates.create_template(db, grant, "会议", "提取行动项")
        other = templates.create_template(db, grant, "票据", "提取金额")
        assert templates.set_default(db, grant, first["id"]) == first
        assert templates.resolve_template(db, grant) == first
        assert templates.set_default(db, grant, other["id"]) == other
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_NOT_FOUND"):
            templates.set_default(db, grant, "absent")
        assert templates.list_templates(db, grant)["defaultTemplateId"] == other["id"]
        assert templates.set_default(db, grant, None) == builtin
        assert templates.resolve_template(db, grant) == builtin
        templates.set_default(db, grant, first["id"])
        templates.delete_template(db, grant, first["id"], expected_revision=1)
        assert templates.resolve_template(db, grant) == builtin
        assert templates.get_template(db, grant, other["id"]) == other


@pytest.mark.parametrize(
    ("field", "value"),
    [("box", "box-b"), ("user", "bob"), ("space", "shared"), ("instance", "desktop-b")],
)
def test_custom_template_cannot_cross_owner_scope(template_store, grant, field, value):
    with template_store.db() as db:
        template = templates.create_template(db, grant, "家庭纪要", "提取决策")
        templates.set_default(db, grant, template["id"])
        foreign = {**grant, field: value}
        foreign_templates = templates.list_templates(db, foreign)
        assert foreign_templates["defaultTemplateId"] == templates.BUILTIN_TEMPLATE_ID
        assert len(foreign_templates["templates"]) == 1
        for use in (
            lambda: templates.get_template(db, foreign, template["id"]),
            lambda: templates.set_default(db, foreign, template["id"]),
            lambda: templates.update_template(
                db, foreign, template["id"], "改", "改", 1
            ),
            lambda: templates.delete_template(db, foreign, template["id"], 1),
        ):
            with pytest.raises(Problem, match="SUMMARY_TEMPLATE_NOT_FOUND") as denied:
                use()
            assert denied.value.status == 404
        assert templates.resolve_template(db, grant) == template


def test_templates_persist_across_grant_rotation_and_detect_stale_edits(
    template_store, grant
):
    with template_store.db() as db:
        template = templates.create_template(db, grant, "会议", "保留结论")
        templates.set_default(db, grant, template["id"])

    restarted = Store(template_store.directory)
    replacement = {**grant, "id": "new-grant"}
    with restarted.db() as db:
        assert templates.resolve_template(db, replacement) == template
        edited = templates.update_template(
            db, replacement, template["id"], "讨论", "保留待办", expected_revision=1
        )
        assert edited["revision"] == 2
        assert edited["instructions"] == "保留待办"
        assert templates.resolve_template(db, replacement) == edited
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_REVISION_CONFLICT"):
            templates.update_template(db, replacement, template["id"], "改", "改", 1)
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_REVISION_CONFLICT"):
            templates.delete_template(db, replacement, template["id"], 1)
        assert templates.get_template(db, replacement, template["id"]) == edited


def test_custom_template_limit_is_per_owner(template_store, grant, monkeypatch):
    monkeypatch.setattr(templates, "MAX_CUSTOM_TEMPLATES", 1)
    with template_store.db() as db:
        templates.create_template(db, grant, "第一个", "摘要")
        with pytest.raises(Problem, match="SUMMARY_TEMPLATE_LIMIT") as error:
            templates.create_template(db, grant, "第二个", "摘要")
        assert error.value.status == 429
        templates.create_template(
            db, {**grant, "instance": "desktop-b"}, "第一个", "摘要"
        )
