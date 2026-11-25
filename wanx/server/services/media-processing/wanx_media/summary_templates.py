"""Summary templates belong to a verified media instance across grant rotations."""

from __future__ import annotations

import uuid

from .store import Problem


BUILTIN_TEMPLATE_ID = "builtin-default"
MAX_CUSTOM_TEMPLATES = 100

_BUILTIN = {
    "id": BUILTIN_TEMPLATE_ID,
    "name": "通用总结",
    "instructions": (
        "概括材料的主题和结论，分条列出关键信息。"
        "原文明确提到待办、负责人或截止时间时，另列行动项。"
        "保留重要数字与日期，避免编造材料没有提供的信息。"
    ),
    "revision": 1,
    "isBuiltin": True,
}
_OWNER = "box=? AND user=? AND space=? AND instance=?"


def initialize(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS summary_templates (
            id TEXT PRIMARY KEY,
            box TEXT NOT NULL,
            user TEXT NOT NULL,
            space TEXT NOT NULL,
            instance TEXT NOT NULL,
            name TEXT NOT NULL,
            instructions TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1))
        )
    """)
    db.execute("""
        CREATE INDEX IF NOT EXISTS summary_templates_owner
        ON summary_templates(box, user, space, instance)
    """)
    db.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS summary_templates_default
        ON summary_templates(box, user, space, instance) WHERE is_default=1
    """)


def _scope(grant):
    return tuple(grant[key] for key in ("box", "user", "space", "instance"))


def _record(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "instructions": row["instructions"],
        "revision": row["revision"],
        "isBuiltin": False,
    }


def list_templates(db, grant):
    rows = db.execute(
        f"""SELECT * FROM summary_templates WHERE {_OWNER}
            ORDER BY name COLLATE NOCASE, id""",
        _scope(grant),
    ).fetchall()
    return {
        "templates": [dict(_BUILTIN), *(_record(row) for row in rows)],
        "defaultTemplateId": next(
            (row["id"] for row in rows if row["is_default"]), BUILTIN_TEMPLATE_ID
        ),
    }


def get_template(db, grant, template_id):
    if template_id == BUILTIN_TEMPLATE_ID:
        return dict(_BUILTIN)
    row = db.execute(
        f"SELECT * FROM summary_templates WHERE id=? AND {_OWNER}",
        (template_id, *_scope(grant)),
    ).fetchone()
    if row is None:
        raise Problem("SUMMARY_TEMPLATE_NOT_FOUND", 404)
    return _record(row)


def resolve_template(db, grant, template_id=None):
    if template_id is not None:
        return get_template(db, grant, template_id)
    row = db.execute(
        f"SELECT * FROM summary_templates WHERE {_OWNER} AND is_default=1",
        _scope(grant),
    ).fetchone()
    return _record(row) if row is not None else dict(_BUILTIN)


def create_template(db, grant, name, instructions):
    scope = _scope(grant)
    count = db.execute(
        f"SELECT count(*) FROM summary_templates WHERE {_OWNER}", scope
    ).fetchone()[0]
    if count >= MAX_CUSTOM_TEMPLATES:
        raise Problem("SUMMARY_TEMPLATE_LIMIT", 429)
    template_id = uuid.uuid4().hex
    db.execute(
        """INSERT INTO summary_templates
           (id, box, user, space, instance, name, instructions)
           VALUES(?, ?, ?, ?, ?, ?, ?)""",
        (template_id, *scope, name, instructions),
    )
    return get_template(db, grant, template_id)


def _require_editable(db, grant, template_id, expected_revision):
    template = get_template(db, grant, template_id)
    if template["isBuiltin"]:
        raise Problem("SUMMARY_TEMPLATE_IMMUTABLE", 409)
    if template["revision"] != expected_revision:
        raise Problem("SUMMARY_TEMPLATE_REVISION_CONFLICT", 409)


def update_template(db, grant, template_id, name, instructions, expected_revision):
    _require_editable(db, grant, template_id, expected_revision)
    db.execute(
        f"""UPDATE summary_templates
            SET name=?, instructions=?, revision=revision+1 WHERE id=? AND {_OWNER}""",
        (name, instructions, template_id, *_scope(grant)),
    )
    return get_template(db, grant, template_id)


def delete_template(db, grant, template_id, expected_revision):
    _require_editable(db, grant, template_id, expected_revision)
    db.execute(
        f"DELETE FROM summary_templates WHERE id=? AND {_OWNER}",
        (template_id, *_scope(grant)),
    )


def set_default(db, grant, template_id):
    template = get_template(
        db, grant, BUILTIN_TEMPLATE_ID if template_id is None else template_id
    )
    scope = _scope(grant)
    db.execute(
        f"UPDATE summary_templates SET is_default=0 WHERE {_OWNER} AND is_default=1",
        scope,
    )
    if not template["isBuiltin"]:
        db.execute(
            f"UPDATE summary_templates SET is_default=1 WHERE id=? AND {_OWNER}",
            (template["id"], *scope),
        )
    return template
