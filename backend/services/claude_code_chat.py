"""Chat through Claude Code on a Claude subscription instead of an API key.

The Claude Agent SDK starts the Claude Code CLI (bundled in the pip wheel) as a
subprocess. The CLI authenticates with ``CLAUDE_CODE_OAUTH_TOKEN`` (create one
with ``claude setup-token``) or, when running outside Docker, with the local
``claude`` login in ``~/.claude``. Usage then counts against that subscription.

A Claude subscription is personal: it must not be offered to other users of the
app. The model option is therefore off unless the user is listed in
``CLAUDE_CODE_USERS``, and every built-in Claude Code tool (Bash, Read, Write,
...) is disabled — the model only gets the read-only library tools and, when
web search is on, WebSearch.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import queue
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Awaitable, Callable, Generator

from config import settings
from services.auth import get_request_user

log = logging.getLogger(__name__)

# "opus" is the CLI alias for the newest Opus model on the subscription.
CLAUDE_CODE_MODEL = "opus"
_LIBRARY_SERVER = "library"
_DONE = object()


def _allowed_users() -> set[str]:
    return {u.strip().lower() for u in settings.claude_code_users.split(",") if u.strip()}


def _has_credentials() -> bool:
    if settings.claude_code_oauth_token.strip() or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return True
    return (Path.home() / ".claude" / ".credentials.json").exists()


def claude_code_available(username: str | None = None) -> bool:
    """True when *username* may use the Claude Code model option."""
    name = (username if username is not None else get_request_user()) or ""
    if name.strip().lower() not in _allowed_users():
        return False
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return False
    return _has_credentials()


def subscription_fallback_available() -> bool:
    """True when work meant for LiteLLM may run on the Claude subscription instead.

    Background jobs (concept map, ingest helpers) have no request user; they
    count as the owner's.
    """
    return claude_code_available(get_request_user() or settings.default_user_name)


def _require_available() -> None:
    if not claude_code_available():
        raise ValueError(
            "Claude Code is not enabled for this user. Set CLAUDE_CODE_USERS and "
            "CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) on the server."
        )


# The SDK hands the system prompt to the CLI as one command-line argument, and Linux caps a
# single argument at 128 KiB (MAX_ARG_STRLEN): a Knowledge Chat scoped to many papers failed
# with "Argument list too long". Larger system prompts travel in the first user message
# (stdin) instead.
_MAX_SYSTEM_ARG_BYTES = 100_000
_SYSTEM_IN_MESSAGE = (
    "Your instructions and context are in the <instructions> block at the start of the "
    "first user message. Follow them exactly as a system prompt."
)


def _fit_system(system: str, prompt: str) -> tuple[str, str]:
    """Return (system, prompt), moving an oversized system prompt into the prompt."""
    if len(system.encode("utf-8")) <= _MAX_SYSTEM_ARG_BYTES:
        return system, prompt
    return _SYSTEM_IN_MESSAGE, f"<instructions>\n{system}\n</instructions>\n\n{prompt}"


def _subprocess_env() -> dict[str, str]:
    """Env overrides for the CLI: force subscription auth.

    The CLI prefers ANTHROPIC_API_KEY over the OAuth token, and the backend
    container has the app's API key in its environment, so blank it. The
    account's claude.ai connectors (Drive, Gmail, ...) would otherwise load as
    extra MCP tools.
    """
    env = {k: "" for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL") if k in os.environ}
    env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    token = settings.claude_code_oauth_token.strip()
    if token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return env


_FENCE = re.compile(r"^```", re.M)


def _open_fence(text: str) -> bool:
    """True when *text* ends inside a fenced block (an odd number of ``` lines)."""
    return len(_FENCE.findall(text)) % 2 == 1


def _prompt(history: list[dict[str, Any]], question: str) -> str:
    """Flatten earlier turns into one prompt; each request is a fresh CLI session."""
    if not history:
        return question
    turns = [f"<{m['role']}>\n{m['content']}\n</{m['role']}>" for m in history]
    return "Earlier turns of this conversation:\n\n" + "\n\n".join(turns) + f"\n\nCurrent message:\n{question}"


async def _run(
    system: str,
    prompt: str,
    emit: Callable[[dict[str, Any]], None],
    use_web: bool,
    library_tools: list[Any],
) -> None:
    """Run one Claude Code query, emitting token/step events through *emit*."""
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, StreamEvent, create_sdk_mcp_server, query

    mcp_servers: dict[str, Any] = {}
    allowed = ["WebSearch"] if use_web else []
    if library_tools:
        mcp_servers[_LIBRARY_SERVER] = create_sdk_mcp_server(name=_LIBRARY_SERVER, tools=library_tools)
        allowed += [f"mcp__{_LIBRARY_SERVER}__{t.name}" for t in library_tools]

    system, prompt = _fit_system(system, prompt)
    options = ClaudeAgentOptions(
        system_prompt=system,
        model=CLAUDE_CODE_MODEL,
        tools=["WebSearch"] if use_web else [],
        allowed_tools=allowed,
        mcp_servers=mcp_servers,
        strict_mcp_config=True,
        permission_mode="dontAsk",
        setting_sources=[],
        cwd=tempfile.gettempdir(),
        env=_subprocess_env(),
        include_partial_messages=True,
        max_turns=25,
    )

    async def messages():
        yield {"type": "user", "message": {"role": "user", "content": prompt}}

    written: list[str] = []
    async for message in query(prompt=messages(), options=options):
        if isinstance(message, StreamEvent):
            event = message.event
            if event.get("type") == "content_block_start" and event.get("content_block", {}).get("type") == "text":
                if written:
                    # A reply stopped mid-card (safety refusal, then the CLI's fallback model
                    # continues) leaves its fence open; close it so the rest renders.
                    sep = "\n```\n\n" if _open_fence("".join(written)) else "\n\n"
                    written.append(sep)
                    emit({"type": "token", "text": sep})
            elif event.get("type") == "content_block_delta" and event.get("delta", {}).get("type") == "text_delta":
                written.append(event["delta"]["text"])
                emit({"type": "token", "text": event["delta"]["text"]})
            elif event.get("type") == "content_block_start" and event.get("content_block", {}).get("name") == "WebSearch":
                emit({"type": "step", "kind": "web", "description": "Searching the web", "cypher": None, "count": None})
        elif isinstance(message, ResultMessage) and message.is_error:
            detail = "; ".join(message.errors or []) or message.result or message.subtype
            raise RuntimeError(f"Claude Code failed: {detail}")


def _drive(run: Callable[[Callable[[dict[str, Any]], None]], Awaitable[None]]) -> Generator[dict[str, Any], None, None]:
    """Run the async query on its own event loop in a thread; yield its events.

    The chat routes are sync generators served from the threadpool, so the
    request context (current user) is copied into the worker thread.
    """
    events: queue.Queue = queue.Queue()
    ctx = contextvars.copy_context()

    def worker() -> None:
        try:
            asyncio.run(run(events.put))
        except Exception as exc:  # surfaced to the caller below
            events.put(exc)
        finally:
            events.put(_DONE)

    threading.Thread(target=ctx.run, args=(worker,), daemon=True).start()
    while True:
        item = events.get()
        if item is _DONE:
            return
        if isinstance(item, Exception):
            raise item
        yield item


def knowledge_chat_claude_code(
    system: str,
    history: list[dict[str, Any]],
    question: str,
    driver: Any,
    use_web: bool,
) -> Generator[dict[str, Any], None, None]:
    """Knowledge Chat on Claude Code: same events as ``knowledge_chat_stream``."""
    _require_available()
    from claude_agent_sdk import tool
    from services.ai import LIBRARY_TOOLS, execute_library_tool

    async def run(emit: Callable[[dict[str, Any]], None]) -> None:
        def library_tool(spec: dict[str, Any]):
            @tool(spec["name"], spec["description"], spec["input_schema"])
            async def handler(args: dict[str, Any]) -> dict[str, Any]:
                step, content = await asyncio.to_thread(execute_library_tool, spec["name"], args, driver)
                emit(step)
                return {"content": [{"type": "text", "text": content}]}
            return handler

        tools = [library_tool(t) for t in LIBRARY_TOOLS] if driver else []
        await _run(system, _prompt(history, question), emit, use_web, tools)

    yield from _drive(run)


def run_structured_claude_code(
    system: str,
    prompt: str,
    schema: dict[str, Any],
    *,
    model: str = "sonnet",
    effort: str = "medium",
) -> dict[str, Any]:
    """One tool-less Claude Code turn whose answer is JSON matching *schema*.

    *model* is a CLI alias ("sonnet", "opus", "haiku"): it resolves to the
    newest model of that family on the subscription.
    """
    _require_available()

    async def run(emit: Callable[[dict[str, Any]], None]) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        system_, prompt_ = _fit_system(system, prompt)
        options = ClaudeAgentOptions(
            system_prompt=system_,
            model=model,
            effort=effort,
            output_format={"type": "json_schema", "schema": schema},
            tools=[],
            allowed_tools=[],
            strict_mcp_config=True,
            permission_mode="dontAsk",
            setting_sources=[],
            cwd=tempfile.gettempdir(),
            env=_subprocess_env(),
        )

        async def messages():
            yield {"type": "user", "message": {"role": "user", "content": prompt_}}

        async for message in query(prompt=messages(), options=options):
            if isinstance(message, ResultMessage):
                if message.is_error:
                    detail = "; ".join(message.errors or []) or message.result or message.subtype
                    raise RuntimeError(f"Claude Code failed: {detail}")
                emit({"type": "result", "data": message.structured_output})

    for event in _drive(run):
        if event["type"] == "result":
            if not isinstance(event["data"], dict):
                raise RuntimeError("Claude Code returned no structured output")
            return event["data"]
    raise RuntimeError("Claude Code returned no result")


def complete_claude_code(system: str, prompt: str, *, model: str = "sonnet") -> str:
    """One tool-less Claude Code turn; returns the answer text.

    Stands in for the LiteLLM model when no LiteLLM endpoint is configured.
    Callers check ``subscription_fallback_available()`` first.
    """

    async def run(emit: Callable[[dict[str, Any]], None]) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        system_, prompt_ = _fit_system(system or "You are a helpful research assistant.", prompt)
        options = ClaudeAgentOptions(
            system_prompt=system_,
            model=model,
            tools=[],
            allowed_tools=[],
            strict_mcp_config=True,
            permission_mode="dontAsk",
            setting_sources=[],
            cwd=tempfile.gettempdir(),
            env=_subprocess_env(),
            max_turns=1,
        )

        async def messages():
            yield {"type": "user", "message": {"role": "user", "content": prompt_}}

        async for message in query(prompt=messages(), options=options):
            if isinstance(message, ResultMessage):
                if message.is_error:
                    detail = "; ".join(message.errors or []) or message.result or message.subtype
                    raise RuntimeError(f"Claude Code failed: {detail}")
                emit({"type": "result", "text": message.result or ""})

    for event in _drive(run):
        if event["type"] == "result":
            return event["text"].strip()
    raise RuntimeError("Claude Code returned no result")


def chat_with_paper_claude_code(
    paper_text: str,
    paper_title: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Single-paper chat on Claude Code; returns the full answer."""
    _require_available()
    from services.ai import _load_prompt

    system = _load_prompt("chat_system.txt").format(
        title=paper_title or "(unknown)",
        text=paper_text[:60000],
    )
    prompt = _prompt(list(history or []), question)
    return "".join(
        e["text"] for e in _drive(lambda emit: _run(system, prompt, emit, True, [])) if e["type"] == "token"
    )
