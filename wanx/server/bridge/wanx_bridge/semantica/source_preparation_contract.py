"""Finite source confirmation and index retry operations for material intake."""
from typing import Literal
from pydantic import Field, field_validator
from .material_processing_contract import NativeOperation, Wire

DOCUMENT = '/workbench/documents/{document_id}'
ERROR_CODES = frozenset({'SOURCE_VERSION_CONFLICT', 'SOURCE_NOT_READY',
    'SOURCE_CONFIRMATION_STALE', 'SOURCE_OPERATION_CONFLICT'})


class ConfirmSource(NativeOperation):
    expected_document_version_id: str = Field(min_length=1, max_length=120)
    confirmed: Literal[True]

    @field_validator('confirmed', mode='before')
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError('An explicit boolean confirmation is required')
        return value


class RetrySourceIndex(NativeOperation):
    expected_document_version_id: str = Field(min_length=1, max_length=120)
    confirmation_id: str = Field(min_length=1, max_length=120)


IndexStatus = Literal['not_started', 'blocked', 'queued', 'running', 'ready', 'failed', 'cancelled', 'stale']


class SourceReceipt(Wire):
    operation_id: str
    confirmation_id: str
    document_id: str
    document_version_id: str
    confirmed_at: str
    index_id: str | None
    index_job_id: str | None
    index_status: IndexStatus
    index_reused: bool
    extraction_started: Literal[False]
    publication_performed: Literal[False]


class SourceResponse(Wire):
    receipt: SourceReceipt
    reused: bool


class SourceReview(Wire):
    status: Literal['not_required', 'unconfirmed', 'confirmed', 'stale']
    confirmation_id: str | None
    confirmed_version_id: str | None
    confirmed_at: str | None


class IndexProgress(Wire):
    status: IndexStatus
    document_version_id: str | None
    index_id: str | None
    job_id: str | None
    job_status: str | None
    completed_units: int | None
    total_units: int | None
    error: dict | None
    retryable: bool


class Preparation(Wire):
    status: Literal['parsing', 'awaiting_confirmation', 'indexing', 'ready', 'blocked', 'failed', 'cancelled']
    source_review: SourceReview
    indexing: IndexProgress
    ready: bool


ROUTES = [
    ('POST', DOCUMENT + '/source-confirmations', 'Confirm the current material source and prepare its index', ConfirmSource, {}),
    ('POST', DOCUMENT + '/index-retries', 'Retry indexing an already confirmed material version', RetrySourceIndex, {}),
]
RESPONSES = {(method, path): SourceResponse for method, path, *_ in ROUTES}
EXAMPLES = {
    ConfirmSource: {'operation_id': 'source-confirm', '_native_operation_id': 'source-confirm',
                    'expected_document_version_id': 'version', 'confirmed': True},
    RetrySourceIndex: {'operation_id': 'source-retry', '_native_operation_id': 'source-retry',
                    'expected_document_version_id': 'version', 'confirmation_id': 'confirmation'},
}
