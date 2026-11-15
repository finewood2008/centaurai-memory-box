"""WANX standard transports, with explicit per-channel data and audience policy."""

from __future__ import annotations

import base64
import json
import mimetypes
from uuid import uuid4

from .contracts import StudioError, digest
from .haowen import KEY, KINDS
from .local_authority import to_thread

FIELDS = {
    "wecom": ["bot_id", "secret"],
    "feishu": ["app_id", "app_secret", "encrypt_key", "verification_token"],
    "dingtalk": ["client_id", "client_secret"],
    "weixin": ["bot_uin", "token"],
}
SECRETS = {"secret", "app_secret", "encrypt_key", "verification_token", "client_secret", "token"}


def gateway(svc):
    if not svc.server or not getattr(svc.server, "app_runtime", None):
        raise StudioError("HAOWEN_CHANNEL_UNAVAILABLE", 409)
    return svc.server.app_runtime.gateway


def channel_row(svc, session, key):
    cfg = svc.state(session)
    row = gateway(svc).get_channel(key)
    if (
        row is None
        or row.agent_id != cfg.get("agentId")
        or row.user_id != int(session["owner"].removeprefix("wanx:"))
        or row.kind not in KINDS
    ):
        raise StudioError("HAOWEN_CHANNEL_NOT_FOUND", 404)
    return row


async def ensure_agent(svc, session):
    if session["environment"] != "production":
        raise StudioError("HAOWEN_CHANNEL_PRODUCTION_ONLY", 409)
    if svc.local_required():
        # Never substitute a legacy WANX credential for local-data authority.
        raise StudioError("HAOWEN_CHANNEL_DELEGATION_REQUIRED", 409)
    async with svc.setup_lock:
        cfg = await to_thread(svc.state, session)
        if cfg.get("agentId"):
            return cfg["agentId"]
        from octop.infra.agents.manager import AgentCreateSpec

        aid = "haowen-" + uuid4().hex[:24]
        manager = svc.server.app_runtime.agent_registry
        await manager.create(
            AgentCreateSpec(
                name=cfg["name"] + " · " + session["app"][-6:],
                agent_id=aid,
                user_id=int(session["owner"].removeprefix("wanx:")),
                description="WANX HaoWen " + session["app"],
                system_prompt="本应用由盒端好问服务处理，仅使用应用管理员配置的资料和通道范围。",
                mcp_servers=[],
                skill_package_ids=[],
            )
        )
        await to_thread(svc.write, session, {"agentId": aid}, cfg["revision"])
        return aid


async def native(svc, session, value):
    action = value.get("action")
    if action == "catalog" and set(value) <= {"action", "kind", "parent"}:
        return await svc.catalog(session, value.get("kind"), value.get("parent", ""))
    if action == "select" and set(value) == {"action", "sources"}:
        return await svc.select(session, value["sources"])
    if action == "channels" and set(value) == {"action"}:
        cfg = await to_thread(svc.state, session)
        rows = (
            await to_thread(gateway(svc).list_channels, cfg["agentId"])
            if cfg.get("agentId")
            else []
        )
        return {
            "items": [
                {
                    "id": r.channel_id,
                    "kind": r.kind,
                    "name": r.name,
                    "enabled": bool(r.enabled),
                    "runtime": gateway(svc).runtime_status_to_dict(r.channel_id),
                }
                for r in rows
                if r.kind in KINDS
            ],
            "kinds": list(FIELDS),
        }
    if action == "channel-detail" and set(value) == {"action", "id"}:
        row = await to_thread(channel_row, svc, session, value["id"])
        config = json.loads(row.config_json)
        return {
            "kind": row.kind,
            "name": row.name,
            "configured": [f for f in FIELDS[row.kind] if config.get(f)],
            "values": {f: config.get(f, "") for f in FIELDS[row.kind] if f not in SECRETS},
        }
    if action == "channel-save" and set(value) == {"action", "id", "kind", "name", "values"}:
        kind, name, fields = value["kind"], value["name"], value["values"]
        if (
            kind not in FIELDS
            or not isinstance(name, str)
            or not 1 <= len(name.strip()) <= 100
            or not isinstance(fields, dict)
            or set(fields) - set(FIELDS[kind])
            or any(not isinstance(v, str) or len(v) > 4096 for v in fields.values())
        ):
            raise StudioError("HAOWEN_CHANNEL_INVALID", 422)
        aid = await ensure_agent(svc, session)
        old = await to_thread(channel_row, svc, session, value["id"]) if value["id"] else None
        if old and old.kind != kind:
            raise StudioError("HAOWEN_CHANNEL_INVALID", 422)
        config = (
            json.loads(old.config_json)
            if old
            else {"response_mode": "stream", "show_thinking": False, "show_tool_hints": False}
        )
        for k, v in fields.items():
            if v.strip():
                config[k] = v.strip()
        if any(not config.get(f) for f in FIELDS[kind][:2]):
            raise StudioError("HAOWEN_CHANNEL_INCOMPLETE", 422)
        gw = gateway(svc)
        if old:
            saved = await gw.update_channel(
                old.channel_id, name=name.strip(), config_json=json.dumps(config)
            )
        else:
            from octop.infra.gateway.gateway import ChannelCreateSpec

            # A transport can connect before policy exists, but dispatch denies all.
            saved = await gw.create_channel(
                ChannelCreateSpec(
                    channel_id=uuid4().hex,
                    agent_id=aid,
                    user_id=int(session["owner"].removeprefix("wanx:")),
                    kind=kind,
                    name=name.strip(),
                    config=config,
                )
            )
        # Credential refresh invalidates the previous service policy until re-saved.
        return {"id": saved.channel_id, "kind": saved.kind, "name": saved.name, "configured": True}
    if (
        action == "channel-toggle"
        and set(value) == {"action", "id", "enabled"}
        and type(value["enabled"]) is bool
    ):
        row = await to_thread(channel_row, svc, session, value["id"])
        await gateway(svc).update_channel(row.channel_id, enabled=int(value["enabled"]))
        return {"enabled": value["enabled"]}
    raise StudioError("HAOWEN_NATIVE_OPERATION_DENIED", 403)


async def save_policy(svc, session, value):
    if set(value) != {
        "revision",
        "id",
        "enabled",
        "subjects",
        "groups",
        "allowFiles",
        "sources",
    } or any(type(value[k]) is not bool for k in ("enabled", "allowFiles")):
        raise StudioError("HAOWEN_POLICY_INVALID", 422)
    if session["environment"] != "production" or svc.local_required():
        raise StudioError("HAOWEN_CHANNEL_DELEGATION_REQUIRED", 409)
    row = await to_thread(channel_row, svc, session, value["id"])
    for field in ("subjects", "groups"):
        if (
            not isinstance(value[field], list)
            or len(value[field]) > 100
            or any(not isinstance(s, str) or not KEY.fullmatch(s) for s in value[field])
        ):
            raise StudioError("HAOWEN_POLICY_INVALID", 422)
    if value["enabled"] and not value["subjects"] and not value["groups"]:
        raise StudioError("HAOWEN_AUDIENCE_REQUIRED", 409)
    cfg = await to_thread(svc.state, session)
    allowed = {(s["kind"], s["id"]): s for s in cfg["sources"]}
    if not isinstance(value["sources"], list) or len(value["sources"]) > 20:
        raise StudioError("HAOWEN_SOURCE_INVALID", 422)
    selected = []
    for ref in value["sources"]:
        if (
            not isinstance(ref, dict)
            or not isinstance(ref.get("kind"), str)
            or not isinstance(ref.get("id"), str)
            or (ref["kind"], ref["id"]) not in allowed
        ):
            raise StudioError("HAOWEN_SOURCE_NOT_SELECTED", 403)
        selected.append(allowed[(ref["kind"], ref["id"])])
    policy = {k: value[k] for k in ("id", "enabled", "subjects", "groups", "allowFiles")}
    policy.update(
        name=row.name,
        kind=row.kind,
        sources=selected,
        credentialRevision=digest([row.kind, row.config_json]),
    )
    channels = cfg.get("channels", {})
    channels[row.channel_id] = policy
    await to_thread(svc.write, session, {"channels": channels}, value["revision"])
    return await to_thread(svc.public, session)


def bound_session(svc, aid):
    with svc.service.store.lock:
        projects = svc.service.store.db.execute("SELECT owner,body FROM projects").fetchall()
    for owner, body in projects:
        p = json.loads(body)
        if p.get("_haowen", {}).get("production", {}).get("agentId") == aid:
            return {
                "owner": owner,
                "project": p["id"],
                "app": p["appId"],
                "environment": "production",
            }
    raise StudioError("HAOWEN_APP_UNAVAILABLE", 403)


def audience(msg, policy):
    subject = msg.channel_subject
    if subject is None or not subject.subject_id:
        raise StudioError("HAOWEN_IDENTITY_REQUIRED", 403)
    group = (
        subject.chat_type == "group"
        or msg.metadata.get("is_group") is True
        or msg.metadata.get("chat_type") == "group"
        or msg.group_context is not None
    )
    chat = str(subject.subject_id)
    sender = str(msg.metadata.get("sender_id") or ("" if group else chat))
    if chat not in policy["groups" if group else "subjects"]:
        raise StudioError("HAOWEN_AUDIENCE_DENIED", 403)
    # Group context is shared only inside that group. Passive context is not read.
    return (
        digest(
            [
                msg.channel_type,
                msg.channel_id,
                "group" if group else "dm",
                chat,
                msg.channel_session_id or "",
            ]
        ),
        chat,
        sender,
    )


async def file_request(svc, session, policy, text):
    from octop_gateway.models import FileContent, MessageEvent

    if not policy["allowFiles"]:
        return MessageEvent.text("此通道未开放原文件发送，请联系应用管理员。")
    cfg, model = await to_thread(svc.state, session), await to_thread(svc.model_stamp, session)
    await to_thread(svc.current, session, cfg, model, policy)
    sources = await to_thread(svc.scope_sources, session, policy)
    files = await to_thread(svc.file_entries, session, sources)
    key = text.removeprefix("/文件").strip()
    if not key:
        await to_thread(svc.current, session, cfg, model, policy)
        return MessageEvent.text(
            "可取用的文件：\n"
            + "\n".join(f"{f['name']} · {f['id']}" for f in files[:100])
            + "\n发送 /文件 文件名称或编号 获取原件。"
        )
    matches = [f for f in files if key in {f["id"], f["name"]}]
    if len(matches) != 1:
        return MessageEvent.text("未找到唯一且获授权的文件，请发送 /文件 查看可用名称和编号。")
    f = matches[0]
    if f["size"] > 20 * 1024 * 1024:
        return MessageEvent.text("原文件超过首版20MB发送范围，请在盒子文件空间中查看。")
    storage, data, offset = svc.space(session["owner"]), bytearray(), 0
    while offset < f["size"]:
        block, now = await to_thread(
            storage.read_chunk, f["id"], offset, min(1024 * 1024, f["size"] - offset)
        )
        if (
            not block
            or now.get("version") != f.get("version")
            or not await to_thread(svc.permitted_file, storage, now, sources)
        ):
            raise StudioError("HAOWEN_FILE_CHANGED", 409)
        data.extend(block)
        offset += len(block)
    await to_thread(svc.current, session, cfg, model, policy)
    latest = await to_thread(storage.metadata, f["id"])
    if latest.get("version") != f.get("version") or not await to_thread(
        svc.permitted_file, storage, latest, await to_thread(svc.scope_sources, session, policy)
    ):
        raise StudioError("HAOWEN_FILE_CHANGED", 409)
    return MessageEvent(
        content=[
            FileContent(
                filename=f["name"],
                size=len(data),
                data=base64.b64encode(data).decode(),
                mime_type=mimetypes.guess_type(f["name"])[0] or "application/octet-stream",
            )
        ]
    )


async def dispatch(svc, msg, agent):
    from octop_gateway.models import MessageEvent

    from .workshop import _actor

    actor = None
    try:
        session = await to_thread(bound_session, svc, agent.agent_id)
        if (
            agent.user_id != int(session["owner"].removeprefix("wanx:"))
            or agent.description != "WANX HaoWen " + session["app"]
        ):
            raise StudioError("HAOWEN_APP_UNAVAILABLE", 403)
        cfg = await to_thread(svc.state, session)
        if msg.text.strip() == "/身份":
            row = await to_thread(channel_row, svc, session, msg.channel_id)
            if not row.enabled or row.kind != msg.channel_type or msg.channel_subject is None:
                raise StudioError("HAOWEN_IDENTITY_REQUIRED", 403)
            subject = msg.channel_subject
            group = (
                subject.chat_type == "group"
                or msg.metadata.get("is_group") is True
                or msg.metadata.get("chat_type") == "group"
                or msg.group_context is not None
            )
            yield MessageEvent.text(
                ("群 ID：" if group else "人员 ID：")
                + str(subject.subject_id)
                + "\n请由好问管理员将此 ID 加入对应允许名单。"
            )
            yield MessageEvent.completed()
            return
        policy = cfg.get("channels", {}).get(msg.channel_id)
        if not policy or not policy["enabled"] or policy["kind"] != msg.channel_type:
            raise StudioError("HAOWEN_CHANNEL_DISABLED", 403)
        await to_thread(
            svc.current, session, cfg, await to_thread(svc.model_stamp, session), policy
        )
        key, _, _ = audience(msg, policy)
        actor = _actor.set((session["owner"], None))
        if msg.text.strip().startswith("/文件"):
            yield await file_request(svc, session, policy, msg.text.strip())
        elif msg.text.strip().startswith("/出处"):
            ref = msg.text.strip().removeprefix("/出处").strip()
            with svc.service.store.lock:
                row = svc.service.store.db.execute(
                    "SELECT response FROM haowen_turns WHERE owner=? AND app=? AND environment=? AND session=? ORDER BY created DESC LIMIT 1",
                    (session["owner"], session["app"], "production", key),
                ).fetchone()
            evidence = json.loads(row[0])["evidence"] if row else []
            match = next((e for e in evidence if e["id"] == ref), None)
            if match is None:
                yield MessageEvent.text(
                    "请发送 /出处 引用编号，查看本会话最近一次回答中仍获授权的依据。"
                )
            else:
                current = await svc.evidence(session, match, policy)
                await to_thread(
                    svc.current, session, cfg, await to_thread(svc.model_stamp, session), policy
                )
                yield MessageEvent.text(match["title"] + "\n" + current["text"][:4000])
        else:
            if not msg.text.strip() or msg.has_media:
                yield MessageEvent.text(
                    "好问目前通过文字提问。使用 /文件 可查看本通道获授权的文件。"
                )
            else:
                mid = str(
                    msg.metadata.get("message_id")
                    or msg.metadata.get("msg_id")
                    or digest([msg.text, msg.timestamp])
                )
                result = await svc.answer(session, key, msg.text, digest(mid), policy)
                parts = (
                    (["资料依据\n" + result["content"]] if result["content"] else [])
                    + (["通用知识补充\n" + result["supplement"]] if result["supplement"] else [])
                    + result["notes"]
                )
                if result["evidence"]:
                    parts.append(
                        "出处\n"
                        + "\n".join("[" + e["id"] + "] " + e["title"] for e in result["evidence"])
                        + "\n发送 /出处 编号 可回查当前依据。"
                    )
                yield MessageEvent.text("\n\n".join(parts))
    except Exception as exc:
        code = getattr(exc, "code", "HAOWEN_FAILED")
        safe = {
            "HAOWEN_AUDIENCE_DENIED": "当前人员或群尚未加入好问的允许名单，请联系应用管理员。",
            "HAOWEN_CONFIG_CHANGED": "应用配置刚刚变化，本轮未交付，请重新提问。",
            "HAOWEN_MODEL_CONSENT_REQUIRED": "管理员尚未确认将相关资料片段交给所选模型，本轮未调用模型。",
            "HAOWEN_CHANNEL_DELEGATION_REQUIRED": "当前盒子的本地授权模式尚未开放常驻通道授权，请在应用内提问。",
        }
        yield MessageEvent.text(
            safe.get(code, "好问暂时无法处理，请检查应用配置、通道状态与资料授权后重试。")
        )
    finally:
        if actor is not None:
            _actor.reset(actor)
    yield MessageEvent.completed()
