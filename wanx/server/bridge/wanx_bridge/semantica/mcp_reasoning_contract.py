"""Public single-key reasoning arguments. Identity and delivery are server-owned."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ObjectId = Annotated[str, StringConstraints(min_length=1, max_length=120, pattern=r"^\S+$")]
SkillId = Annotated[
    str, StringConstraints(pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", max_length=80)
]
Version = Annotated[
    str,
    StringConstraints(
        pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$", max_length=32
    ),
]
InputKey = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)]
InputText = Annotated[str, Field(max_length=12000)]
InputValue = InputText | bool | int | Annotated[list[InputText], Field(max_length=100)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Discover(Strict):
    query: str = Field(default="", max_length=2000)
    kind: Literal["general", "scenario", "domain_extension"] | None = None
    tag: str | None = Field(default=None, min_length=1, max_length=200)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=10, ge=1, le=20)
    detect: bool = False


class Prepare(Strict):
    version: Version | None = None
    inputs: dict[InputKey, InputValue] = Field(default_factory=dict, max_length=90)
    document_ids: list[ObjectId] = Field(default_factory=list, max_length=100)
    idempotency_key: Annotated[
        str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    ]
    skill_id: SkillId
    detect: bool = False


class Reference(Strict):
    preparation_id: ObjectId
    skill_id: SkillId
    reference_id: SkillId
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=4000, ge=1, le=12000)
    detect: bool = False


class Scope(Strict):
    preparation_id: ObjectId


class Search(Scope):
    query: str = Field(min_length=1, max_length=2000)
    document_ids: list[ObjectId] = Field(default_factory=list, max_length=100)
    entity_types: list[str] = Field(default_factory=list, max_length=50)
    limit: int = Field(default=10, ge=1, le=50)


class Evidence(Scope):
    evidence_id: ObjectId


class ReadDocument(Scope):
    document_id: ObjectId
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=4000, ge=1, le=12000)
    detect: bool = False


OPERATIONS = {
    "discover": Discover,
    "prepare": Prepare,
    "reference": Reference,
    "scope": Scope,
    "search": Search,
    "evidence": Evidence,
    "read-document": ReadDocument,
    "coverage": Scope,
}


def validate_payload(path, payload, query):
    operation = path.removeprefix("/reasoning/")
    if (
        operation not in OPERATIONS
        or query
        or not isinstance(payload, dict)
        or set(payload) != {"arguments"}
    ):
        raise ValueError("SKILL_INVALID_REQUEST")
    return {"arguments": OPERATIONS[operation].model_validate(payload["arguments"]).model_dump()}


def register_tools(mcp, read):
    def function(operation, model):
        async def invoke(arguments):
            return await read(
                "/reasoning/" + operation, payload={"arguments": arguments.model_dump()}
            )

        invoke.__annotations__ = {"arguments": model, "return": dict}
        return invoke

    descriptions = {
        "discover": "列出授权仓可用的推理方法；detect=true 才请求模型检测。",
        "prepare": "准备推理方法并固定材料版本；使用幂等键恢复。不是执行或发布知识。",
        "reference": "读取同一 Key 准备记录中的方法引用，强制脱敏。",
        "scope": "读取准备记录绑定的材料范围与版本。",
        "search": "在固定范围中检索；不会扩大到其他材料或仓。",
        "evidence": "读取固定范围内的证据，遵循脱敏保护。",
        "read-document": "按原文字符位置读取固定版本；未完成检测不交付未保护正文。",
        "coverage": "读取固定材料范围的交付覆盖状态。",
    }
    for operation, model in OPERATIONS.items():
        mcp.add_tool(
            function(operation, model),
            name="xingtu_reasoning_" + operation.replace("-", "_"),
            description=descriptions[operation],
        )
