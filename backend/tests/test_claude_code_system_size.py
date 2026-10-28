"""Oversized system prompts must not go on the CLI command line (128 KiB per-argument cap)."""
from services.claude_code_chat import _MAX_SYSTEM_ARG_BYTES, _fit_system


def test_small_system_prompt_stays_a_system_prompt():
    assert _fit_system("You are helpful.", "Hi") == ("You are helpful.", "Hi")


def test_large_system_prompt_moves_into_the_message():
    system = "context " * (_MAX_SYSTEM_ARG_BYTES // 4)
    new_system, new_prompt = _fit_system(system, "What do these papers say?")
    assert len(new_system.encode()) < 1000
    assert new_prompt.startswith("<instructions>\n" + system)
    assert new_prompt.endswith("</instructions>\n\nWhat do these papers say?")


def test_limit_counts_bytes_not_characters():
    system = "ä" * (_MAX_SYSTEM_ARG_BYTES // 2 + 10)  # under the limit in chars, over it in UTF-8 bytes
    assert _fit_system(system, "q")[0] != system


def test_open_fence():
    from services.claude_code_chat import _open_fence

    assert not _open_fence("Text\n\n```structure\n5C5P\n```\n")
    assert _open_fence('Text\n\n```structure\n{"models": [{"pdb": "5C5P", "color": "viol')


def test_reply_stopped_mid_card_gets_its_fence_closed(monkeypatch):
    """A refusal mid-card followed by the fallback model's text block: the fallback's card stays a card."""
    import asyncio

    import claude_agent_sdk
    from services import claude_code_chat

    class FakeStreamEvent:
        def __init__(self, event):
            self.event = event

    def block(text):
        return [
            FakeStreamEvent({"type": "content_block_start", "content_block": {"type": "text"}}),
            FakeStreamEvent({"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}),
        ]

    async def fake_query(prompt, options):
        for event in block('Intro.\n\n```structure\n{"models": [{"pdb": "5C5P", "color": "viol'):
            yield event
        for event in block("Finishing the card.\n\n```structure\n5C5P\n```"):
            yield event

    monkeypatch.setattr(claude_agent_sdk, "StreamEvent", FakeStreamEvent)
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)

    tokens: list[str] = []
    asyncio.run(claude_code_chat._run("system", "q", lambda e: tokens.append(e["text"]), False, []))
    text = "".join(tokens)
    assert '"viol\n```\n\nFinishing the card.' in text
    assert not claude_code_chat._open_fence(text)


def test_complete_claude_code_sends_image_and_allows_web(monkeypatch):
    import claude_agent_sdk
    from services import claude_code_chat

    seen = {}

    class FakeResult:
        is_error = False
        result = "answer"

    async def fake_query(prompt, options):
        async for message in prompt:
            seen["content"] = message["message"]["content"]
        seen["tools"], seen["allowed"] = options.tools, options.allowed_tools
        yield FakeResult()

    monkeypatch.setattr(claude_agent_sdk, "ResultMessage", FakeResult)
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)

    assert claude_code_chat.complete_claude_code("s", "What is plotted?", use_web=True, image_png=b"\x89PNG") == "answer"
    image, text = seen["content"]
    assert image["type"] == "image" and image["source"]["media_type"] == "image/png"
    assert text == {"type": "text", "text": "What is plotted?"}
    assert seen["tools"] == seen["allowed"] == ["WebSearch"]

    claude_code_chat.complete_claude_code("s", "plain")
    assert seen["content"] == "plain" and seen["tools"] == []


def test_run_reports_prompt_size_model_and_window(monkeypatch):
    """The largest prompt across the turns, the model and its context window come back as one event."""
    import asyncio

    import claude_agent_sdk
    from services import claude_code_chat

    class FakeStreamEvent:
        def __init__(self, event):
            self.event = event

    class FakeResult:
        is_error = False
        model_usage = {"claude-opus-5-5": {"contextWindow": 1_000_000}}

    def start(inp, cached):
        return FakeStreamEvent({"type": "message_start", "message": {
            "model": "claude-opus-5-5",
            "usage": {"input_tokens": inp, "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0}}})

    async def fake_query(prompt, options):
        yield start(90_000, 0)       # first turn
        yield start(500, 95_000)     # after a tool call: mostly cached, larger in total
        yield FakeResult()

    monkeypatch.setattr(claude_agent_sdk, "StreamEvent", FakeStreamEvent)
    monkeypatch.setattr(claude_agent_sdk, "ResultMessage", FakeResult)
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)

    events: list[dict] = []
    asyncio.run(claude_code_chat._run("system", "q", events.append, False, []))
    assert events[-1] == {"type": "context", "tokens": 95_500, "window": 1_000_000, "model": "claude-opus-5-5"}
