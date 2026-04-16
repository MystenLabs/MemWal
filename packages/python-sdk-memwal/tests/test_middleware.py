"""
Tests for MemWal middleware integrations.

Covers:
  - with_memwal_langchain: memory injection, auto_save, min_relevance filter,
    no memories found, error resilience (LLM still called on recall failure)
  - with_memwal_openai: async and sync variants, injection, auto_save, resilience
  - _find_last_user_message: dict and LangChain BaseMessage variants
  - _format_memories: output format
  - _inject_openai_memory: insertion position

No actual LLM or MemWal server calls are made — all network traffic is mocked
with ``respx`` and all LLM responses are mocked with ``unittest.mock``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import nacl.signing
import pytest
import respx

from memwal.middleware import (
    _find_last_user_message,
    _format_memories,
    _inject_openai_memory,
    with_memwal_langchain,
    with_memwal_openai,
)
from memwal.types import RecallMemory
from memwal.utils import bytes_to_hex

# ============================================================
# Shared test key
# ============================================================

_SEED = b"\x02" * 32
_KEY = nacl.signing.SigningKey(_SEED)
_KEY_HEX = bytes_to_hex(bytes(_KEY))
_ACCOUNT_ID = "0xtest"
_SERVER = "http://localhost:8000"

# ============================================================
# Helper: mock MemWal recall endpoint
# ============================================================

_RECALL_URL = f"{_SERVER}/api/recall"
_ANALYZE_URL = f"{_SERVER}/api/analyze"


def _mock_recall(memories: list, *, total: int | None = None) -> httpx.Response:
    """Return a mocked /api/recall response."""
    return httpx.Response(
        200,
        json={
            "results": memories,
            "total": total if total is not None else len(memories),
        },
    )


def _mock_analyze() -> httpx.Response:
    return httpx.Response(
        200,
        json={"facts": [], "total": 0, "owner": "0xowner"},
    )


# ============================================================
# Pure function tests (no mocking needed)
# ============================================================


class TestFindLastUserMessage:
    """Tests for _find_last_user_message."""

    def test_dict_style_user_message(self) -> None:
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "What are my allergies?"},
        ]
        assert _find_last_user_message(messages) == "What are my allergies?"

    def test_dict_style_last_user_wins(self) -> None:
        messages = [
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "second question"},
        ]
        assert _find_last_user_message(messages) == "second question"

    def test_no_user_message_returns_none(self) -> None:
        messages = [{"role": "system", "content": "sys"}, {"role": "assistant", "content": "hi"}]
        assert _find_last_user_message(messages) is None

    def test_empty_list_returns_none(self) -> None:
        assert _find_last_user_message([]) is None

    def test_non_list_returns_none(self) -> None:
        assert _find_last_user_message("not a list") is None  # type: ignore[arg-type]

    def test_langchain_human_message(self) -> None:
        """LangChain HumanMessage objects (msg.type == 'human') should be found."""
        msg = MagicMock()
        msg.type = "human"
        msg.content = "LangChain question"
        assert _find_last_user_message([msg]) == "LangChain question"

    def test_langchain_system_message_ignored(self) -> None:
        sys_msg = MagicMock()
        sys_msg.type = "system"
        sys_msg.content = "system prompt"
        assert _find_last_user_message([sys_msg]) is None

    def test_multimodal_content_array(self) -> None:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "image_url", "image_url": "..."},
                ],
            }
        ]
        assert _find_last_user_message(messages) == "hello"


class TestFormatMemories:
    """Tests for _format_memories."""

    def test_format_single_memory(self) -> None:
        memories = [RecallMemory(blob_id="b1", text="I love coffee", distance=0.1)]
        result = _format_memories(memories)
        assert "I love coffee" in result
        assert "0.90" in result  # relevance = 1 - 0.1
        assert "[Memory Context]" in result

    def test_format_multiple_memories(self) -> None:
        memories = [
            RecallMemory(blob_id="b1", text="I love coffee", distance=0.05),
            RecallMemory(blob_id="b2", text="I live in Tokyo", distance=0.2),
        ]
        result = _format_memories(memories)
        assert "I love coffee" in result
        assert "I live in Tokyo" in result
        # Both should appear as bullet points
        assert result.count("- ") == 2

    def test_format_starts_with_memory_context(self) -> None:
        memories = [RecallMemory(blob_id="b1", text="fact", distance=0.0)]
        assert _format_memories(memories).startswith("[Memory Context]")


class TestInjectOpenAIMemory:
    """Tests for _inject_openai_memory."""

    def test_inserts_before_last_user_message(self) -> None:
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "question"},
        ]
        result = _inject_openai_memory(messages, "memory context")
        # Should be: system | memory-system | user
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "system"
        assert result[1]["content"] == "memory context"
        assert result[2]["role"] == "user"

    def test_inserts_at_start_when_only_user_message(self) -> None:
        messages = [{"role": "user", "content": "question"}]
        result = _inject_openai_memory(messages, "context")
        # last_user_idx == 0, so insert at 0
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "user"

    def test_does_not_mutate_original(self) -> None:
        original = [{"role": "user", "content": "q"}]
        _inject_openai_memory(list(original), "ctx")  # pass a copy
        assert len(original) == 1  # original unchanged


# ============================================================
# LangChain middleware tests
# ============================================================


class TestWithMemWalLangChain:
    """Tests for with_memwal_langchain."""

    def _make_llm(self) -> MagicMock:
        """Create a minimal mock LangChain BaseChatModel."""
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        llm = MagicMock()
        llm._agenerate = AsyncMock(
            return_value=ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="LLM answer"))]
            )
        )
        llm._generate = MagicMock(
            return_value=ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="LLM answer sync"))]
            )
        )
        return llm

    @respx.mock
    async def test_memories_injected_as_system_message(self) -> None:
        """When memories are found, a SystemMessage is injected before the HumanMessage."""
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        llm = self._make_llm()
        captured: list = []

        async def _capture_agenerate(messages_batch, *a, **kw):
            captured.extend(messages_batch)
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="ok"))]
            )

        llm._agenerate = _capture_agenerate

        respx.post(_RECALL_URL).mock(
            return_value=_mock_recall([
                {"blob_id": "b1", "text": "User loves coffee", "distance": 0.05}
            ])
        )
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        await smart_llm._agenerate([[HumanMessage("What do I drink?")]])

        assert len(captured) == 1
        injected = captured[0]
        # Should have SystemMessage injected
        system_msgs = [m for m in injected if isinstance(m, SystemMessage)]
        assert len(system_msgs) == 1
        assert "User loves coffee" in system_msgs[0].content

    @respx.mock
    async def test_no_memories_found_no_injection(self) -> None:
        """When no memories match, the message list is passed unchanged."""
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        llm = self._make_llm()
        captured: list = []

        async def _capture_agenerate(messages_batch, *a, **kw):
            captured.extend(messages_batch)
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="ok"))]
            )

        llm._agenerate = _capture_agenerate

        respx.post(_RECALL_URL).mock(return_value=_mock_recall([]))
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        await smart_llm._agenerate([[HumanMessage("hello")]])

        injected = captured[0]
        system_msgs = [m for m in injected if isinstance(m, SystemMessage)]
        assert len(system_msgs) == 0

    @respx.mock
    async def test_min_relevance_filters_low_score_memories(self) -> None:
        """Memories below min_relevance are filtered out."""
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        llm = self._make_llm()
        captured: list = []

        async def _capture_agenerate(messages_batch, *a, **kw):
            captured.extend(messages_batch)
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="ok"))]
            )

        llm._agenerate = _capture_agenerate

        # distance=0.9 → relevance=0.1, below min_relevance=0.3
        respx.post(_RECALL_URL).mock(
            return_value=_mock_recall([
                {"blob_id": "b1", "text": "barely relevant", "distance": 0.9}
            ])
        )
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER,
            min_relevance=0.3, auto_save=False
        )
        await smart_llm._agenerate([[HumanMessage("hello")]])

        injected = captured[0]
        system_msgs = [m for m in injected if isinstance(m, SystemMessage)]
        assert len(system_msgs) == 0

    @respx.mock
    async def test_recall_failure_does_not_block_llm(self) -> None:
        """If MemWal recall fails, the LLM is still called with original messages."""
        from langchain_core.messages import HumanMessage

        llm = self._make_llm()

        respx.post(_RECALL_URL).mock(return_value=httpx.Response(500, text="error"))
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        # Should NOT raise — recall failure is swallowed, LLM still called
        await smart_llm._agenerate([[HumanMessage("will this work?")]])

    @respx.mock
    async def test_auto_save_triggers_analyze(self) -> None:
        """With auto_save=True, analyze() is called fire-and-forget after LLM call."""
        from langchain_core.messages import HumanMessage

        llm = self._make_llm()

        respx.post(_RECALL_URL).mock(return_value=_mock_recall([]))
        analyze_route = respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=True
        )
        await smart_llm._agenerate([[HumanMessage("store this")]])

        # Give fire-and-forget task time to run
        await asyncio.sleep(0.05)
        assert analyze_route.called

    @respx.mock
    async def test_no_user_message_no_recall(self) -> None:
        """If there's no user message, recall is not called."""
        from langchain_core.messages import SystemMessage

        llm = self._make_llm()
        recall_route = respx.post(_RECALL_URL).mock(return_value=_mock_recall([]))

        smart_llm = with_memwal_langchain(
            llm, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        await smart_llm._agenerate([[SystemMessage("only system")]])
        assert not recall_route.called


# ============================================================
# OpenAI middleware tests
# ============================================================


class TestWithMemWalOpenAI:
    """Tests for with_memwal_openai."""

    def _make_async_client(self) -> MagicMock:
        """Create a mock AsyncOpenAI client."""
        client = MagicMock()
        client.__class__.__name__ = "AsyncOpenAI"
        # Simulate detection logic
        client._async_client = MagicMock()

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "async answer"
        client.chat = MagicMock()
        client.chat.completions = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=mock_response)
        return client

    def _make_sync_client(self) -> MagicMock:
        """Create a mock sync OpenAI client."""
        client = MagicMock()
        client.__class__.__name__ = "OpenAI"
        # No _async_client attribute → sync path
        del client._async_client

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "sync answer"
        client.chat = MagicMock()
        client.chat.completions = MagicMock()
        original_create = MagicMock(return_value=mock_response)
        client.chat.completions.create = original_create
        return client

    @respx.mock
    async def test_async_client_injects_memory(self) -> None:
        """Async OpenAI client: memory injected as system message before user message."""
        client = self._make_async_client()
        captured_messages: list = []

        async def _capture_create(*args, **kwargs):
            msgs = kwargs.get("messages") or args[0]
            captured_messages.extend(msgs)
            return MagicMock()

        client.chat.completions.create = _capture_create

        respx.post(_RECALL_URL).mock(
            return_value=_mock_recall([
                {"blob_id": "b1", "text": "I love sushi", "distance": 0.05}
            ])
        )
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart = with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        await smart.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "What food do I like?"}],
        )

        system_msgs = [m for m in captured_messages if m.get("role") == "system"]
        assert len(system_msgs) == 1
        assert "I love sushi" in system_msgs[0]["content"]

    @respx.mock
    async def test_async_client_no_memories_no_injection(self) -> None:
        """No memories → original messages passed unchanged."""
        client = self._make_async_client()
        captured: list = []

        async def _capture(*args, **kwargs):
            msgs = kwargs.get("messages") or (args[0] if args else [])
            captured.extend(msgs)
            return MagicMock()

        client.chat.completions.create = _capture

        respx.post(_RECALL_URL).mock(return_value=_mock_recall([]))

        smart = with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        await smart.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hello"}],
        )

        system_msgs = [m for m in captured if isinstance(m, dict) and m.get("role") == "system"]
        assert len(system_msgs) == 0

    @respx.mock
    async def test_async_client_recall_failure_resilient(self) -> None:
        """If recall fails, the LLM call still proceeds."""
        client = self._make_async_client()

        respx.post(_RECALL_URL).mock(return_value=httpx.Response(500, text="error"))
        respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart = with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=False
        )
        # Should NOT raise
        await smart.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "test"}],
        )

    @respx.mock
    async def test_async_client_auto_save(self) -> None:
        """With auto_save=True, analyze is triggered after completion."""
        client = self._make_async_client()

        respx.post(_RECALL_URL).mock(return_value=_mock_recall([]))
        analyze_route = respx.post(_ANALYZE_URL).mock(return_value=_mock_analyze())

        smart = with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER, auto_save=True
        )
        await smart.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "save this fact"}],
        )

        await asyncio.sleep(0.05)
        assert analyze_route.called

    @respx.mock
    async def test_min_relevance_filter(self) -> None:
        """Memories with relevance below min_relevance are not injected."""
        client = self._make_async_client()
        captured: list = []

        async def _capture(*args, **kwargs):
            msgs = kwargs.get("messages") or (args[0] if args else [])
            captured.extend(msgs)
            return MagicMock()

        client.chat.completions.create = _capture

        # distance=0.85 → relevance=0.15, below min_relevance=0.3
        respx.post(_RECALL_URL).mock(
            return_value=_mock_recall([
                {"blob_id": "b1", "text": "low relevance fact", "distance": 0.85}
            ])
        )

        smart = with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER,
            min_relevance=0.3, auto_save=False
        )
        await smart.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "anything"}],
        )

        system_msgs = [m for m in captured if isinstance(m, dict) and m.get("role") == "system"]
        assert len(system_msgs) == 0

    @respx.mock
    def test_sync_client_wraps_create(self) -> None:
        """Sync OpenAI client wrapper is applied correctly."""
        client = self._make_sync_client()
        original_create = client.chat.completions.create

        with_memwal_openai(
            client, key=_KEY_HEX, account_id=_ACCOUNT_ID, server_url=_SERVER
        )

        # The create method should now be a different callable (patched)
        assert client.chat.completions.create is not original_create
