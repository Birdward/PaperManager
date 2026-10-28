"""
Tests for Claude AI summarization service.

Unit tests use mocks and run without API keys.
Integration tests (marked) hit the real Claude API.
"""
import pytest
from unittest.mock import patch, MagicMock

from services.ai import summarize_paper, chat_with_paper


# ── Unit tests (mocked) ───────────────────────────────────────────────────────

def test_summarize_empty_text_returns_fallback():
    result = summarize_paper("")
    assert "No text" in result or "no text" in result.lower()
    assert result  # not empty string


def test_summarize_whitespace_text_returns_fallback():
    result = summarize_paper("   \n\t  ")
    assert result  # graceful, not a crash


def _mock_client(response_text: str):
    mock_msg = MagicMock()
    mock_msg.content = [MagicMock(text=response_text)]
    mock_client = MagicMock()
    mock_client.messages.create.return_value = mock_msg
    return mock_client


def test_summarize_calls_claude_api():
    with patch("services.ai.chat_completion", return_value="## Summary\n\nThis paper proposes X.") as mock_cc:
        result = summarize_paper("Some paper text here.", title="Test Paper")
    assert "Summary" in result
    mock_cc.assert_called_once()


def test_summarize_passes_title_in_prompt():
    with patch("services.ai.chat_completion", return_value="Summary content") as mock_cc:
        summarize_paper("paper text", title="My Amazing Paper")

    prompt_content = mock_cc.call_args.kwargs["messages"][0]["content"]
    assert "My Amazing Paper" in prompt_content


def test_summarize_truncates_long_text():
    """With a LiteLLM model, text longer than its cap is truncated in the prompt.
    (On Claude the whole paper is sent: tests/test_models_and_limits.py.)"""
    from config import settings

    long_text = "word " * 20000  # ~100k chars
    with patch.object(settings, "litellm_endpoint", "http://litellm.invalid"), \
         patch("services.ai.chat_completion", return_value="Summary") as mock_cc:
        summarize_paper(long_text)

    prompt_content = mock_cc.call_args.kwargs["messages"][0]["content"]
    assert len(prompt_content) < len(long_text)


# ── Integration tests ─────────────────────────────────────────────────────────

# ── chat_with_paper unit tests ────────────────────────────────────────────────

@pytest.fixture
def personal_key():
    """Chat with Claude needs a personal Anthropic key (per user, or the owner's env key).
    The Anthropic client itself is mocked in each test, so the key is never sent anywhere."""
    with patch("services.ai.get_effective_ai_config", return_value={"anthropic_api_key": "test-key"}):
        yield


def test_chat_without_personal_key_raises():
    with patch("services.ai.get_effective_ai_config", return_value={"anthropic_api_key": ""}):
        with pytest.raises(ValueError, match="Personal Anthropic key"):
            chat_with_paper(paper_text="x", paper_title="t", question="q")


def test_chat_returns_answer(personal_key):
    mock_client = _mock_client("The Transformer uses attention mechanisms.")
    with patch("services.ai.anthropic.Anthropic", return_value=mock_client):
        answer = chat_with_paper(
            paper_text="The model uses attention.",
            paper_title="Attention Paper",
            question="What does the model use?",
        )
    assert "attention" in answer.lower()


def test_chat_passes_history(personal_key):
    mock_client = _mock_client("Follow-up answer.")
    with patch("services.ai.anthropic.Anthropic", return_value=mock_client):
        chat_with_paper(
            paper_text="Paper text.",
            paper_title="Title",
            question="Second question",
            history=[
                {"role": "user", "content": "First question"},
                {"role": "assistant", "content": "First answer"},
            ],
        )
    call_kwargs = mock_client.messages.create.call_args[1]
    messages = call_kwargs["messages"]
    assert len(messages) == 3  # 2 history + 1 new question
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"
    assert messages[2]["content"] == "Second question"


def test_chat_system_prompt_contains_title_and_text(personal_key):
    mock_client = _mock_client("Answer.")
    with patch("services.ai.anthropic.Anthropic", return_value=mock_client):
        chat_with_paper(
            paper_text="Critical paper content here.",
            paper_title="My Paper Title",
            question="Question?",
        )
    call_kwargs = mock_client.messages.create.call_args[1]
    system_prompt = call_kwargs["system"]
    assert "My Paper Title" in system_prompt
    assert "Critical paper content here." in system_prompt


# ── chat endpoint unit tests ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_chat_endpoint_returns_answer(personal_key):
    from httpx import AsyncClient, ASGITransport
    from main import app
    from db.queries.papers import create_paper, delete_paper
    from db.connection import get_driver

    paper = create_paper(get_driver(), {
        "title": "Chat Test Paper",
        "raw_text": "This paper proposes the Transformer model.",
    })
    mock_client = _mock_client("The paper proposes the Transformer.")
    with patch("services.ai.anthropic.Anthropic", return_value=mock_client):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                f"/papers/{paper['id']}/chat",
                # The endpoint defaults to the LiteLLM model; ask for Claude explicitly.
                json={"question": "What does this paper propose?", "history": [], "model": "claude"},
            )
    try:
        assert r.status_code == 200
        assert r.json()["answer"] == "The paper proposes the Transformer."
        mock_client.messages.create.assert_called_once()
    finally:
        conv_id = r.json().get("conversation_id") if r.status_code == 200 else None
        with get_driver().session() as s:
            if conv_id:
                s.run("MATCH (c:Conversation {id: $id}) OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m) DETACH DELETE c, m", id=conv_id)
        delete_paper(get_driver(), paper["id"])


@pytest.mark.asyncio
async def test_chat_endpoint_404_for_missing_paper():
    from httpx import AsyncClient, ASGITransport
    from main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/papers/nonexistent-id/chat",
            json={"question": "What?", "history": []},
        )
    assert r.status_code == 404


# ── integration tests ─────────────────────────────────────────────────────────

@pytest.mark.integration
def test_summarize_real_paper():
    """Calls real Claude API — requires ANTHROPIC_API_KEY in .env."""
    sample_text = (
        "We present the Transformer, a model architecture eschewing recurrence "
        "and instead relying entirely on an attention mechanism to draw global "
        "dependencies between input and output. The Transformer allows for "
        "significantly more parallelization and can reach a new state of the art "
        "in translation quality after being trained for as little as twelve hours "
        "on eight P100 GPUs."
    )
    result = summarize_paper(sample_text, title="Attention Is All You Need")
    assert len(result) > 100
    # Should contain at least some of the expected structure markers
    markers = ["Problem", "Method", "finding", "Relevance", "attention", "Transformer"]
    assert any(m.lower() in result.lower() for m in markers)
