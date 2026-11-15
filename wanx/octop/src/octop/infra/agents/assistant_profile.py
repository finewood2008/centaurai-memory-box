"""One owner-private general expert for the first-party WANX assistant."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from octop.infra.agents.experts.catalog import build_create_spec_from_expert
from octop.infra.agents.experts.default_agent import (
    default_home_local_backend,
    user_policy_workspace_root,
)
from octop.infra.errors import ErrorCode, OctopError

PREFERENCE_KEY = "wanx_assistant_agent_id"
TEMPLATE_ID = "default"

ASSISTANT_ASK_PROMPT = """你是万象·对话，提供聊天、问答与引导式沟通。
明确的问题直接回答；需要澄清场景或取舍时，使用 ask_user_question 给出选择题。
一次问 1—3 个相关问题，每题 2—3 个选项，推荐项放在首位并标注“推荐”；允许自由补充。
回应用户的选择后继续讨论，不反复确认已知信息，不把普通问答变成任务流程。
不构建应用、不生成或修改文件、不执行命令、不操作电脑。需要制作产品时，说明可去开物继续。
始终保持问答模式，不建议切换到 Craft 或 Plan；只读使用用户明确授权的参考资料。
"""


def is_assistant_profile(row: Any, user_repo: Any) -> bool:
    """Identify only the account's bound first-party assistant, not other experts."""
    if row is None or row.application_id != "wanx" or row.user_id is None:
        return False
    user = user_repo.get(row.user_id)
    if user is None or not isinstance(user.preferences_json, str):
        return False
    try:
        preferences = json.loads(user.preferences_json)
    except ValueError:
        return False
    return isinstance(preferences, dict) and preferences.get(PREFERENCE_KEY) == row.agent_id


class AssistantProfiles:
    def __init__(self, server: Any) -> None:
        self.server = server
        self._locks: dict[int, asyncio.Lock] = {}

    @staticmethod
    def _eligible(row: Any, uid: int) -> bool:
        return bool(
            row is not None
            and row.user_id == uid
            and row.application_id == "wanx"
            and row.template_name == TEMPLATE_ID
            and row.kind == "expert"
            and not row.is_shared
        )

    def _existing(self, uid: int) -> Any:
        services = self.server.services
        user = services.user_repo.get(uid)
        preferences = json.loads(user.preferences_json or "{}") if user else {}
        bound_id = preferences.get(PREFERENCE_KEY) if isinstance(preferences, dict) else None
        bound = services.agent_repo.get(bound_id) if isinstance(bound_id, str) else None
        if self._eligible(bound, uid):
            return bound
        candidates = [
            row
            for row in services.agent_repo.list_by_user(uid)
            if self._eligible(row, uid) and row.enabled
        ]
        return min(candidates, key=lambda row: (row.created_at, row.agent_id), default=None)

    async def ensure(self, user: Any) -> dict[str, Any]:
        if user.application_id != "wanx":
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        async with self._locks.setdefault(user.id, asyncio.Lock()):
            registry = self.server.app_runtime.agent_registry
            row = await asyncio.to_thread(self._existing, user.id)
            if row is None:
                expert = self.server.expert_catalog.get(TEMPLATE_ID)
                if expert is None:
                    raise OctopError(ErrorCode.NOT_FOUND, "通用专家模板尚未安装")
                root = await asyncio.to_thread(user_policy_workspace_root, self.server, user.id)
                spec = build_create_spec_from_expert(
                    expert_id=TEMPLATE_ID,
                    expert=expert,
                    user_id=user.id,
                    agent_id=f"wanx-assistant-{user.id}",
                    locale=user.locale,
                    config_extra={"backend": default_home_local_backend(root_dir=root)},
                )
                names = {r.name for r in await asyncio.to_thread(registry.list_agents, user.id)}
                base_name = spec.name
                suffix = 1
                while spec.name in names:
                    spec.name = f"{base_name} · AI助理 {suffix}"
                    suffix += 1
                try:
                    row = await registry.create(spec)
                except OctopError:
                    # A second process may have completed the same fixed-id creation.
                    row = await asyncio.to_thread(self._existing, user.id)
                    if row is None:
                        raise
            if not row.enabled:
                raise OctopError(ErrorCode.FORBIDDEN, "通用专家已停用，请联系管理员")
            await asyncio.to_thread(
                self.server.services.user_repo.set_preference,
                user.id,
                PREFERENCE_KEY,
                row.agent_id,
            )
            if row.last_state not in {"running", "starting"}:
                await registry.start(row.agent_id)
            return {
                "agent_id": row.agent_id,
                "template_id": TEMPLATE_ID,
                "default_model": row.default_model,
            }
