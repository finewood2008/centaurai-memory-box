"""Finite warehouse metadata commands within current owner authorization."""
from pydantic import Field

from .modeling_contract import Operation, openapi_extra


class QuickWarehouse(Operation):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=500)


class RenameWarehouse(Operation):
    name: str = Field(min_length=1, max_length=60)


ROUTES = [
    ("POST", "/warehouses", "Quick-create a warehouse with a published general ontology", QuickWarehouse),
    ("GET", "/warehouses", "List owned warehouses with current ontology summaries", None),
    ("GET", "/warehouses/{warehouse_id}", "Read warehouse status and its current published ontology", None),
    ("PATCH", "/warehouses/{warehouse_id}", "Rename the current owner's warehouse", RenameWarehouse),
]


def schema_extra(path, model):
    extra = openapi_extra(path, model)
    if model is RenameWarehouse:
        extra["description"] = (
            "Renames only name within current warehouse authorization. Requires a stable "
            "operation_id; retries return the original metadata receipt. Description, documents, "
            "ontology and warehouse identity remain unchanged. Name is trimmed, 1–60 Unicode "
            "codepoints, without control characters."
        )
        return extra
    extra["description"] = (
        "Uses existing WANX identity and warehouse authorization. Quick creation needs only name, "
        "optional description and a stable operation_id. No model call or template selector. "
        "The successful receipt contains current_ontology: id, version_number, name, status, "
        "template_id, template_version, entity_type_count, relation_type_count. "
        "An operation replay returns the original receipt; GET the warehouse to read current rules. "
        "Existing warehouses may return current_ontology=null and are never upgraded by reads."
    )
    return extra
