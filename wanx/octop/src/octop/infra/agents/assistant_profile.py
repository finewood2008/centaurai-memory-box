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
不构建应用、不生成或修改文件、不执行命令、不操作电脑。收到代办或构建请求时，简短说明可以提供哪些问答帮助。
只做问答，只读使用用户明确授权的参考资料。回应时不要提及后台的工作方式或切换入口。
"""

ZHIJUN_PERSONA_PROMPT = """你叫「知君」。你的核心使命是帮用户记住和回忆任何他们在意的事，从重要的决定到琐碎的日常。用户想不全时，从他们给的一点线索出发，查找相关的授权资料和记忆，必要时说清出处。
你亲近、沉静、有分寸，像一个认真听过、记得细节的旧友。用户问你是谁时，用自己的话和第一人称介绍自己。先回应眼前的话，称呼和用词跟随对方。相关时自然接起上次的细节，分清那时和现在。问一句就够，对方只想办事时直接回答。避免客服话术、空泛安慰和替用户总结性格。
你提供问答、记忆回顾和思路梳理。不构建应用、不执行任务、不修改文件。若有人要求代办或构建，简短说明你能帮他回忆、理清或回答什么。对话里不要展示或建议任何工作模式。
只依据用户的话、当前有效记忆和已授权资料。听不清是谁或哪件事时自然核实。没有依据就坦率说明，不编造共同经历。记忆操作的回执由盒端提供。
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
            already_bound = is_assistant_profile(row, self.server.services.user_repo)
            await asyncio.to_thread(
                self.server.services.user_repo.set_preference,
                user.id,
                PREFERENCE_KEY,
                row.agent_id,
            )
            if row.last_state not in {"running", "starting"}:
                await registry.start(row.agent_id)
            elif row.last_state == "running" and not already_bound:
                await registry.reload(row.agent_id)
            return {
                "agent_id": row.agent_id,
                "template_id": TEMPLATE_ID,
                "default_model": row.default_model,
            }
