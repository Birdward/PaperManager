"""On Claude Code, writing tasks run on Opus over the whole text; LiteLLM keeps its small caps."""
import pytest

from config import settings
from services import ai, claude_code_chat, litellm_client


@pytest.fixture
def claude(monkeypatch):
    """No LiteLLM endpoint, Claude Code enabled; records every Claude Code call."""
    calls: list[dict] = []
    monkeypatch.setattr(settings, "litellm_endpoint", "")
    monkeypatch.setattr(claude_code_chat, "subscription_fallback_available", lambda: True)

    def fake_complete(system, prompt, *, model="sonnet", **kw):
        calls.append({"system": system, "prompt": prompt, "model": model})
        return '{"claims": [{"text": "A claim", "type": "finding"}]}'

    monkeypatch.setattr(claude_code_chat, "complete_claude_code", fake_complete)
    return calls


def test_chat_completion_passes_the_model(claude):
    litellm_client.chat_completion([{"role": "user", "content": "hi"}])
    litellm_client.chat_completion([{"role": "user", "content": "hi"}], claude_model="opus")
    assert [c["model"] for c in claude] == ["sonnet", "opus"]


def test_summary_reads_far_past_the_old_cap_on_opus(claude):
    text = "intro " * 2000 + "CHAPTER4MARKER " + "body " * 40_000  # marker at ~12k chars, text ~210k
    ai.summarize_paper(text, "Thesis")
    assert claude[-1]["model"] == "opus"
    assert "CHAPTER4MARKER" in claude[-1]["prompt"] and len(claude[-1]["prompt"]) > 200_000


def test_claims_read_the_whole_text_on_opus(claude):
    text = "front " * 3000 + "RESULTSMARKER " + "x " * 50_000
    claims = ai.extract_claims(text, "Thesis", model="litellm")
    assert claims == [{"text": "A claim", "type": "finding"}]
    assert claude[-1]["model"] == "opus" and "RESULTSMARKER" in claude[-1]["prompt"]


def test_litellm_keeps_its_small_caps(monkeypatch):
    monkeypatch.setattr(settings, "litellm_endpoint", "http://litellm.invalid")
    assert ai._text_limit(24000) == 24000
    monkeypatch.setattr(settings, "litellm_endpoint", "")
    from services.paper_pages import INLINE_CHARS
    assert ai._text_limit(24000) == INLINE_CHARS and ai._text_limit(15000, 120_000) == 120_000


def test_knowledge_chat_window_is_claude_codes(monkeypatch):
    # "claude" runs on Claude Code when the user has no API key; patched so no database is needed.
    monkeypatch.setattr(ai, "_subscription_instead_of_key", lambda: True)
    assert ai.context_window_for("claude-code") == 1_000_000
    assert ai.context_window_for("claude") == 1_000_000      # no key: runs on Claude Code
    assert ai.context_window_for("claude-work") == ai.CONTEXT_WINDOW
