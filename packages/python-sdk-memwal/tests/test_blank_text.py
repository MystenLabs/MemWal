"""Whitespace-only text is rejected before a request is sent (#1129)."""

from __future__ import annotations

import pytest

from memwal.client import _reject_blank_text


@pytest.mark.parametrize("text", ["", " ", "\t", "\n", "  \t\n "])
def test_blank_text_rejected(text: str) -> None:
    with pytest.raises(ValueError, match="Text cannot be empty"):
        _reject_blank_text(text)


def test_padded_text_is_not_trimmed() -> None:
    _reject_blank_text("  hello  ")


def test_bulk_item_message_names_the_index() -> None:
    with pytest.raises(ValueError, match=r"items\[0\].text cannot be empty"):
        _reject_blank_text(" \t", "items[0].text cannot be empty")
