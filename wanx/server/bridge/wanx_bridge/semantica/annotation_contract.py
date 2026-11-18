"""Finite metadata DTO, shared by both Bridge transport paths."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class AnnotationSearch(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    tags: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=30)
    match: Literal['all', 'any'] = 'all'

    @field_validator('tags')
    @classmethod
    def nonempty_tags(cls, tags):
        if any(not tag.strip() for tag in tags):
            raise ValueError('empty tag')
        return tags


class Source(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    file_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    space_id: Literal['personal']
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    revision: int = Field(ge=1, le=9007199254740991)


class Provenance(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    tag: str = Field(min_length=1, max_length=80)
    source: str = Field(min_length=1, max_length=80)
    itemId: str = Field(pattern=r'^[a-f0-9]{32}$')
    origin: str | None = Field(default=None, max_length=80)


class AnnotationWrite(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    operation_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,120}$')
    expected_document_version_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    expected_revision: int = Field(ge=0, le=9007199254740991)
    source: Source
    tags: list[str] = Field(max_length=2048)
    description: str = Field(max_length=2000)
    provenance: list[Provenance] = Field(default_factory=list, max_length=2048)
    needs_review: bool

    @field_validator('tags')
    @classmethod
    def valid_tags(cls, value):
        if any(not tag.strip() or len(tag)>80 for tag in value):
            raise ValueError('invalid tag')
        return value


def validate(method, body, query):
    if query:
        raise ValueError('annotation routes do not accept query selectors')
    if method == 'GET':
        if body:
            raise ValueError('read cannot accept body')
        return None
    AnnotationWrite.model_validate(body)
    return body['operation_id']
