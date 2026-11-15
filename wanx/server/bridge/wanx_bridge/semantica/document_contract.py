"""Bounded pagination shared by native Bridge and host-mounted adapters."""

import re

BLOCK_QUERY = frozenset({"block_offset", "block_limit"})


def validate_block_page(query):
    for key in BLOCK_QUERY:
        if key not in query:
            continue
        value = query[key]
        maximum = 500 if key == "block_limit" else 2147483647
        if (
            not isinstance(value, str)
            or not re.fullmatch(r"0|[1-9][0-9]{0,9}", value)
            or not (1 if key == "block_limit" else 0) <= int(value) <= maximum
        ):
            raise ValueError("invalid block page")
