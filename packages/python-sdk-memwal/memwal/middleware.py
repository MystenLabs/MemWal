"""
memwal — AI Middleware

Wraps LangChain and OpenAI SDK clients with automatic memory management.
Before each LLM call, relevant memories are recalled and injected.
After each call, the user message is analyzed for new facts (fire-and-forget).

Both integrations are optional: ``langchain-core`` and ``openai`` are only
imported when the corresponding wrapper is called.

Example (LangChain)::

    from langchain_openai import ChatOpenAI
    from memwal import with_memwal_langchain

    llm = ChatOpenAI(model="gpt-4o")
    smart_llm = with_memwal_langchain(
        llm,
        key="abcdef...",
        account_id="0x...",
    )
    response = await smart_llm.ainvoke([HumanMessage("What are my allergies?")])

Example (OpenAI)::

    from openai import AsyncOpenAI
    from memwal import with_memwal_openai

    client = AsyncOpenAI()
    smart_client = with_memwal_openai(
        client,
        key="abcdef...",
        account_id="0x...",
    )
    response = await smart_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "What are my allergies?"}],
    )
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    List,
    Optional,
)

from .client import MemWal
from .types import RecallMemory

if TYPE_CHECKING:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import BaseMessage

logger = logging.getLogger("memwal")


def _find_last_user_message(messages: Any) -> Optional[str]:
    """Extract the text of the last user message from a message list.

    Supports both dict-style messages (OpenAI format) and LangChain
    BaseMessage objects.
    """
    if not isinstance(messages, (list, tuple)):
        return None

    for msg in reversed(messages):
        # Dict-style (OpenAI format)
        if isinstance(msg, dict):
            if msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str):
                    return content
                # Multimodal content array
                if isinstance(content, list):
                    texts = [
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                        or isinstance(p, str)
                    ]
                    return " ".join(texts) if texts else None
        # LangChain BaseMessage
        elif hasattr(msg, "type") and hasattr(msg, "content"):
            if msg.type == "human":
                return msg.content if isinstance(msg.content, str) else str(msg.content)

    return None


def _format_memories(memories: List[RecallMemory]) -> str:
    """Format recalled memories into an injection string."""
    lines = [
        f"- {m.text} (relevance: {1 - m.distance:.2f})"
        for m in memories
    ]
    return (
        "[Memory Context] The following are known facts about this user "
        "from their personal memory store. Use these facts to answer the "
        "user's question:\n" + "\n".join(lines)
    )


def _fire_and_forget(coro: Any) -> None:
    """Schedule an async coroutine as fire-and-forget.

    Works whether or not an event loop is already running.
    """
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
    except RuntimeError:
        # No running loop -- run in a background thread
        def _run() -> None:
            try:
                asyncio.run(coro)
            except Exception:
                logger.debug("Fire-and-forget analyze() failed", exc_info=True)

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()


# ============================================================
# LangChain Integration
# ============================================================


def with_memwal_langchain(
    llm: "BaseChatModel",
    key: str,
    account_id: str,
    server_url: str = "http://localhost:8000",
    namespace: str = "default",
    max_memories: int = 5,
    auto_save: bool = True,
    min_relevance: float = 0.3,
    debug: bool = False,
) -> "BaseChatModel":
    """Wrap a LangChain ``BaseChatModel`` with MemWal memory management.

    Before each call:
        - Recall relevant memories for the last user message
        - Inject them as a system message

    After each call:
        - Analyze the user message to extract and store new facts (fire-and-forget)

    Args:
        llm: A LangChain ``BaseChatModel`` instance.
        key: Ed25519 delegate key (hex).
        account_id: MemWalAccount object ID.
        server_url: MemWal server URL.
        namespace: Default namespace.
        max_memories: Max memories to inject per request.
        auto_save: Auto-save new facts from conversation.
        min_relevance: Minimum similarity score (0-1) to include a memory.
        debug: Enable debug logging.

    Returns:
        A wrapped ``BaseChatModel`` that automatically uses MemWal memory.
    """
    try:
        from langchain_core.messages import HumanMessage, SystemMessage  # noqa: F811
        from langchain_core.outputs import ChatResult  # noqa: F401
    except ImportError as e:
        raise ImportError(
            "LangChain integration requires langchain-core. "
            "Install with: pip install memwal[langchain]"
        ) from e

    memwal = MemWal.create(
        key=key,
        account_id=account_id,
        server_url=server_url,
        namespace=namespace,
    )

    log = logger.debug if not debug else logger.warning

    original_agenerate = llm._agenerate
    original_generate = llm._generate

    async def _inject_memories(messages: List[BaseMessage]) -> List[BaseMessage]:
        """Recall memories and inject as system message."""
        user_text = _find_last_user_message(messages)
        if not user_text:
            return messages

        try:
            recall_result = await memwal.recall(user_text, max_memories, namespace)
            relevant = [
                m for m in recall_result.results
                if (1 - m.distance) >= min_relevance
            ]
            if not relevant:
                return messages

            memory_context = _format_memories(relevant)
            log(f"[MemWal] Found {len(relevant)} relevant memories")

            # Insert memory system message before the last user message
            result = list(messages)
            last_human_idx = -1
            for i in range(len(result) - 1, -1, -1):
                if isinstance(result[i], HumanMessage):
                    last_human_idx = i
                    break

            memory_msg = SystemMessage(content=memory_context)
            if last_human_idx > 0:
                result.insert(last_human_idx, memory_msg)
            else:
                result.insert(0, memory_msg)

            return result
        except Exception as e:
            log(f"[MemWal] Memory search failed: {e}")
            return messages

    async def _post_analyze(messages: List[BaseMessage]) -> None:
        """Analyze user message for new facts."""
        if not auto_save:
            return
        user_text = _find_last_user_message(messages)
        if user_text:
            try:
                await memwal.analyze(user_text, namespace)
            except Exception as e:
                log(f"[MemWal] Auto-save failed: {e}")

    async def patched_agenerate(
        messages: List[List[BaseMessage]], *args: Any, **kwargs: Any
    ) -> ChatResult:
        enriched = []
        for msg_list in messages:
            enriched.append(await _inject_memories(msg_list))

        result = await original_agenerate(enriched, *args, **kwargs)

        for msg_list in messages:
            _fire_and_forget(_post_analyze(msg_list))

        return result

    def patched_generate(
        messages: List[List[BaseMessage]], *args: Any, **kwargs: Any
    ) -> ChatResult:
        # For sync generate, we inject memories synchronously via asyncio.run
        import asyncio

        enriched = []
        for msg_list in messages:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop is not None and loop.is_running():
                # Already in async context -- cannot use asyncio.run
                enriched.append(msg_list)
            else:
                enriched.append(asyncio.run(_inject_memories(msg_list)))

        result = original_generate(enriched, *args, **kwargs)

        for msg_list in messages:
            _fire_and_forget(_post_analyze(msg_list))

        return result

    # Monkey-patch the LLM instance
    llm._agenerate = patched_agenerate  # type: ignore[assignment]
    llm._generate = patched_generate  # type: ignore[assignment]

    return llm


# ============================================================
# OpenAI SDK Integration
# ============================================================


def with_memwal_openai(
    client: Any,
    key: str,
    account_id: str,
    server_url: str = "http://localhost:8000",
    namespace: str = "default",
    max_memories: int = 5,
    auto_save: bool = True,
    min_relevance: float = 0.3,
    debug: bool = False,
) -> Any:
    """Wrap an OpenAI client with MemWal memory management.

    Works with both ``openai.OpenAI`` (sync) and ``openai.AsyncOpenAI`` (async).

    Before each ``chat.completions.create`` call:
        - Recall relevant memories for the last user message
        - Inject them as a system message

    After each call:
        - Analyze the user message to extract and store new facts (fire-and-forget)

    Args:
        client: An ``openai.OpenAI`` or ``openai.AsyncOpenAI`` instance.
        key: Ed25519 delegate key (hex).
        account_id: MemWalAccount object ID.
        server_url: MemWal server URL.
        namespace: Default namespace.
        max_memories: Max memories to inject per request.
        auto_save: Auto-save new facts from conversation.
        min_relevance: Minimum similarity score (0-1) to include a memory.
        debug: Enable debug logging.

    Returns:
        The same client, with ``chat.completions.create`` wrapped to use MemWal.
    """
    memwal = MemWal.create(
        key=key,
        account_id=account_id,
        server_url=server_url,
        namespace=namespace,
    )

    log = logger.debug if not debug else logger.warning

    is_async = hasattr(client, "_async_client") or type(client).__name__ == "AsyncOpenAI"

    if is_async:
        _wrap_async_openai(client, memwal, namespace, max_memories, auto_save, min_relevance, log)
    else:
        _wrap_sync_openai(client, memwal, namespace, max_memories, auto_save, min_relevance, log)

    return client


def _wrap_async_openai(
    client: Any,
    memwal: MemWal,
    namespace: str,
    max_memories: int,
    auto_save: bool,
    min_relevance: float,
    log: Callable[..., Any],
) -> None:
    """Wrap an async OpenAI client's chat.completions.create."""
    original_create = client.chat.completions.create

    async def patched_create(*args: Any, **kwargs: Any) -> Any:
        messages = kwargs.get("messages") or (args[0] if args else None)
        if messages is None:
            return await original_create(*args, **kwargs)

        # Inject memories
        user_text = _find_last_user_message(messages)
        if user_text:
            try:
                recall_result = await memwal.recall(user_text, max_memories, namespace)
                relevant = [
                    m for m in recall_result.results
                    if (1 - m.distance) >= min_relevance
                ]
                if relevant:
                    memory_context = _format_memories(relevant)
                    log(f"[MemWal] Found {len(relevant)} relevant memories")
                    messages = _inject_openai_memory(list(messages), memory_context)
                    if "messages" in kwargs:
                        kwargs["messages"] = messages
                    elif args:
                        args = (messages,) + args[1:]
            except Exception as e:
                log(f"[MemWal] Memory search failed: {e}")

        result = await original_create(*args, **kwargs)

        # Fire-and-forget analyze
        if auto_save and user_text:
            async def _analyze() -> None:
                try:
                    await memwal.analyze(user_text, namespace)
                except Exception as e:
                    log(f"[MemWal] Auto-save failed: {e}")

            _fire_and_forget(_analyze())

        return result

    client.chat.completions.create = patched_create


def _wrap_sync_openai(
    client: Any,
    memwal: MemWal,
    namespace: str,
    max_memories: int,
    auto_save: bool,
    min_relevance: float,
    log: Callable[..., Any],
) -> None:
    """Wrap a sync OpenAI client's chat.completions.create."""
    original_create = client.chat.completions.create

    def patched_create(*args: Any, **kwargs: Any) -> Any:
        import asyncio

        messages = kwargs.get("messages") or (args[0] if args else None)
        if messages is None:
            return original_create(*args, **kwargs)

        # Inject memories (sync)
        user_text = _find_last_user_message(messages)
        if user_text:
            try:
                recall_result = asyncio.run(
                    memwal.recall(user_text, max_memories, namespace)
                )
                relevant = [
                    m for m in recall_result.results
                    if (1 - m.distance) >= min_relevance
                ]
                if relevant:
                    memory_context = _format_memories(relevant)
                    log(f"[MemWal] Found {len(relevant)} relevant memories")
                    messages = _inject_openai_memory(list(messages), memory_context)
                    if "messages" in kwargs:
                        kwargs["messages"] = messages
                    elif args:
                        args = (messages,) + args[1:]
            except Exception as e:
                log(f"[MemWal] Memory search failed: {e}")

        result = original_create(*args, **kwargs)

        # Fire-and-forget analyze
        if auto_save and user_text:
            async def _analyze() -> None:
                try:
                    await memwal.analyze(user_text, namespace)
                except Exception as e:
                    log(f"[MemWal] Auto-save failed: {e}")

            _fire_and_forget(_analyze())

        return result

    client.chat.completions.create = patched_create


def _inject_openai_memory(
    messages: List[Dict[str, Any]],
    memory_context: str,
) -> List[Dict[str, Any]]:
    """Insert a memory system message before the last user message."""
    last_user_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], dict) and messages[i].get("role") == "user":
            last_user_idx = i
            break

    memory_msg: Dict[str, Any] = {"role": "system", "content": memory_context}

    if last_user_idx > 0:
        messages.insert(last_user_idx, memory_msg)
    else:
        messages.insert(0, memory_msg)

    return messages
