"""Claude and LiteLLM AI services — summarization and chat."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Generator

import anthropic
from config import settings
from services.user_ai_config import get_effective_ai_config
from services.litellm_client import (
    WEB_SEARCH_TOOL_OPENAI,
    chat_completion,
    get_litellm_client,
    litellm_configured,
    parse_tool_args,
    resolve_chat_model,
)
from services.web_search import WEB_SEARCH_TOOL, search_web

log = logging.getLogger(__name__)

# Prompts live in <project_root>/prompts/ — loaded fresh on every call so
# you can edit them without restarting the backend.
_PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"

# Personal Anthropic API — always use the canonical base URL, never the
# ANTHROPIC_BASE_URL env var (which may be set to a corporate proxy with
# surrounding newlines, causing httpx URL validation errors).
_ANTHROPIC_BASE_URL = "https://api.anthropic.com"


def _personal_client() -> anthropic.Anthropic:
    """Return an Anthropic client for the personal API key with SSL settings applied."""
    cfg = get_effective_ai_config()
    api_key = (cfg.get("anthropic_api_key") or "").strip()
    if not api_key:
        raise ValueError("Personal Anthropic key is not configured for this user.")
    return anthropic.Anthropic(
        api_key=api_key,
        base_url=_ANTHROPIC_BASE_URL,
        http_client=anthropic.DefaultHttpxClient(verify=_ssl_verify()),
    )


def _subscription_instead_of_key() -> bool:
    """True when the user has no personal API key but may use Claude Code.

    Requests for the personal "claude" model then run on the subscription.
    """
    from services.claude_code_chat import claude_code_available

    key = (get_effective_ai_config().get("anthropic_api_key") or "").strip()
    return not key and claude_code_available()


def _work_client() -> anthropic.Anthropic:
    """Return Anthropic work client for the effective user config."""
    cfg = get_effective_ai_config()
    work_key = (cfg.get("anthropic_work_api_key") or "").strip()
    if not work_key:
        raise ValueError("Work Anthropic key is not configured for this user.")
    work_kwargs: dict[str, Any] = {
        "api_key": work_key,
        "http_client": anthropic.DefaultHttpxClient(verify=_ssl_verify()),
    }
    work_base = (cfg.get("anthropic_work_base_url") or "").strip()
    if work_base:
        work_kwargs["base_url"] = work_base
    return anthropic.Anthropic(**work_kwargs)


def _load_prompt(filename: str) -> str:
    path = _PROMPTS_DIR / filename
    return path.read_text(encoding="utf-8")


def _ssl_verify():
    """Return the httpx SSL verify value based on settings."""
    if not settings.ssl_verify:
        return False
    if settings.ssl_ca_bundle:
        return settings.ssl_ca_bundle
    return True


def summarize_paper(text: str, title: str = "", custom_instructions: str | None = None) -> str:
    """Return a markdown summary of *text* using the local Gemma model (LiteLLM).

    If *custom_instructions* is provided it replaces the instructional section of
    the default prompt while still appending the paper title and text automatically.
    Falls back to a short notice if text is empty.
    """
    if not text or not text.strip():
        return "_No text could be extracted from this paper._"

    # Gemma has a smaller context window than Claude — cap the paper text.
    paper_text = text[:24000]
    if custom_instructions and custom_instructions.strip():
        prompt = (
            f"{custom_instructions.strip()}\n\n"
            f"Paper title: {title or '(unknown)'}\n\n"
            f"Paper text:\n{paper_text}"
        )
    else:
        prompt = _load_prompt("summary.txt").format(
            title=title or "(unknown)",
            text=paper_text,
        )

    try:
        result = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096,
        )
    except Exception as exc:
        log.warning("summarize_paper: LiteLLM call failed | %s", exc)
        return "_Summary could not be generated (the LLM call failed)._"

    if not result or not result.strip():
        return "_Summary could not be generated._"
    return result


def suggest_topics(title: str, abstract: str = "", summary: str = "") -> list[str]:
    """Return a list of research topic names for a paper using the local Gemma model."""
    import json, re

    if not title and not abstract and not summary:
        return []

    context_parts = []
    if abstract:
        context_parts.append(f"Abstract:\n{abstract[:3000]}")
    if summary:
        context_parts.append(f"Summary:\n{summary[:2000]}")
    context = "\n\n".join(context_parts) or "(no abstract or summary available — infer from title only)"

    prompt = _load_prompt("topics.txt").format(title=title or "(unknown)", context=context)

    try:
        text = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            json_mode=True,
            max_tokens=256,
        )
    except Exception as exc:
        log.warning("suggest_topics: LiteLLM call failed | %s", exc)
        return []
    # Extract JSON even if the model wraps it in markdown fences
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        return []
    try:
        raw = json.loads(match.group())
    except json.JSONDecodeError:
        return []
    return [t.strip() for t in (raw.get("topics") or []) if t.strip()]


def _run_claude_with_tools(
    client: anthropic.Anthropic,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
) -> str:
    """Agentic loop: run Claude with the web_search tool until it stops calling tools."""
    tools = [WEB_SEARCH_TOOL]
    while True:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            tools=tools,
        )
        if response.stop_reason == "tool_use":
            # Collect tool calls and execute them
            tool_results = []
            for block in response.content:
                if block.type == "tool_use" and block.name == "web_search":
                    query = block.input.get("query", "")
                    max_r = int(block.input.get("max_results", 5))
                    results = search_web(query, max_results=max_r)
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(results),
                        }
                    )
            # Feed results back
            messages = list(messages)
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
        else:
            # Final text response
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return ""


def chat_with_paper(
    paper_text: str,
    paper_title: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Answer *question* about a paper using its full text as context.
    Claude can also search the web for related information."""
    system = _load_prompt("chat_system.txt").format(
        title=paper_title or "(unknown)",
        text=paper_text[:60000],
    )
    if _subscription_instead_of_key():
        from services.claude_code_chat import chat_with_paper_claude_code
        return chat_with_paper_claude_code(paper_text, paper_title, question, history)
    client = _personal_client()
    messages: list[dict[str, Any]] = list(history or [])
    messages.append({"role": "user", "content": question})
    return _run_claude_with_tools(client, "claude-opus-4-6", system, messages)


def chat_with_paper_work(
    paper_text: str,
    paper_title: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Answer *question* using the work/Foundry Anthropic gateway.
    Claude can also search the web for related information."""
    client = _work_client()
    system = _load_prompt("chat_system.txt").format(
        title=paper_title or "(unknown)",
        text=paper_text[:60000],
    )
    messages: list[dict[str, Any]] = list(history or [])
    messages.append({"role": "user", "content": question})
    return _run_claude_with_tools(client, "claude-opus-4-6", system, messages)


def chat_with_paper_litellm(
    paper_text: str,
    paper_title: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Answer *question* about a paper using LiteLLM (Gemma via proxy).
    Uses tool calling to allow web searches when the model supports it."""
    if not litellm_configured():
        from services.claude_code_chat import chat_with_paper_claude_code
        return chat_with_paper_claude_code(paper_text, paper_title, question, history)
    client = get_litellm_client()
    model = settings.litellm_model

    system = _load_prompt("chat_system.txt").format(
        title=paper_title or "(unknown)",
        text=paper_text[:12000],
    )
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for msg in (history or []):
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": question})

    max_iterations = 5
    last_content = ""
    for _ in range(max_iterations):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=[WEB_SEARCH_TOOL_OPENAI],
            )
        except Exception as exc:
            log.warning("LiteLLM tool-calling failed, falling back to plain chat | %s", exc)
            return chat_completion(messages=messages, model=model)

        choice = response.choices[0].message
        last_content = (choice.content or "").strip()
        tool_calls = choice.tool_calls or []
        if not tool_calls:
            return last_content

        messages.append(choice.model_dump(exclude_none=True))
        for tc in tool_calls:
            if tc.function.name == "web_search":
                args = parse_tool_args(tc.function.arguments)
                query = args.get("query", "")
                max_r = int(args.get("max_results", 5))
                results = search_web(query, max_results=max_r)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(results),
                })

    return last_content


# Backward-compatible alias
chat_with_paper_ollama = chat_with_paper_litellm


# ── Knowledge Chat (cross-library, streaming) ─────────────────────────────────

CONTEXT_WINDOW = 200_000  # Claude Opus 4.6 token limit

# Tool definition for live Cypher queries
CYPHER_TOOL: dict[str, Any] = {
    "name": "run_cypher",
    "description": (
        "Execute a read-only Cypher query against the Neo4j graph database. "
        "Use this to retrieve counts, find specific papers or authors, traverse "
        "relationships, or gather any structured data that is not in the pre-loaded "
        "paper context. Only MATCH/RETURN queries are permitted — no write operations."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "A read-only Cypher query. Must use MATCH and RETURN. "
                    "Always include a LIMIT clause. Never use CREATE, MERGE, SET, "
                    "DELETE, DETACH DELETE, or REMOVE."
                ),
            },
            "description": {
                "type": "string",
                "description": "Short human-readable description of what this query fetches (shown in the UI as a reasoning step).",
            },
        },
        "required": ["query", "description"],
    },
}

# Tool definition for semantic vector search
SEMANTIC_SEARCH_TOOL: dict[str, Any] = {
    "name": "semantic_search",
    "description": (
        "Find papers by semantic similarity to a free-text query. "
        "Use this when keyword or tag matching would miss papers that express the same "
        "concept with different terminology (e.g. 'attention mechanism' vs 'scaled dot-product similarity'). "
        "Returns papers ranked by cosine similarity to the embedded query."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Free-text query to embed and match against paper embeddings.",
            },
            "limit": {
                "type": "integer",
                "description": "Number of results to return, between 1 and 20. Defaults to 10.",
            },
            "description": {
                "type": "string",
                "description": "Short human-readable label for the UI reasoning step.",
            },
        },
        "required": ["query", "description"],
    },
}

# Tool definition for loading full paper text on demand
LOAD_FULL_TEXT_TOOL: dict[str, Any] = {
    "name": "load_full_text",
    "description": (
        "Load the complete extracted text of a specific paper from the database. "
        "Use this when the abstract and summary are insufficient to answer the question — "
        "for example, when the user asks about specific methods, equations, experimental "
        "details, pseudocode, or hyperparameters that are only in the full paper body. "
        "paper_id must be a UUID from the pre-loaded paper context. "
        "Call this at most 3 times per query."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "paper_id": {
                "type": "string",
                "description": "The UUID id of the paper to load (from the pre-loaded context).",
            },
            "reason": {
                "type": "string",
                "description": "One sentence explaining why the full text is needed.",
            },
        },
        "required": ["paper_id", "reason"],
    },
}

# Tool definition for listing a paper's extracted figures
LIST_FIGURES_TOOL: dict[str, Any] = {
    "name": "list_figures",
    "description": (
        "List the figures extracted from a paper's PDF: figure number, page, caption and "
        "the image URL to embed in the answer as ![caption](image_url). Use it when a "
        "figure of a library paper would show what the answer explains."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "paper_id": {"type": "string", "description": "The UUID id of the paper."},
        },
        "required": ["paper_id"],
    },
}

LIBRARY_TOOLS = (CYPHER_TOOL, SEMANTIC_SEARCH_TOOL, LOAD_FULL_TEXT_TOOL, LIST_FIGURES_TOOL)

# Regex to block write operations
_CYPHER_WRITE_RE = re.compile(
    r"\b(CREATE|MERGE|SET\s+\w|DELETE|DETACH\s+DELETE|REMOVE|DROP)\b",
    re.IGNORECASE,
)


def _safe_value(v: Any) -> Any:
    """Convert a Neo4j driver value to a JSON-serialisable Python object."""
    try:
        from neo4j.graph import Node, Relationship, Path
        if isinstance(v, Node):
            return {k: _safe_value(val) for k, val in v.items() if k != "raw_text"}
        if isinstance(v, (Relationship, Path)):
            return str(v)
    except ImportError:
        pass
    if isinstance(v, list):
        return [_safe_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _safe_value(val) for k, val in v.items() if k != "raw_text"}
    return v


def _run_cypher_safe(driver: Any, query: str) -> list[dict[str, Any]]:
    """Execute *query* against Neo4j with safety constraints.

    Blocks write operations, enforces a result LIMIT of 50, and strips
    ``raw_text`` properties from every returned value.
    Returns a list of row dicts or a single-element error list.
    """
    if _CYPHER_WRITE_RE.search(query):
        return [{"error": "Write operations are not permitted in Knowledge Chat."}]

    # Append LIMIT if not present
    if not re.search(r"\bLIMIT\s+\d+", query, re.IGNORECASE):
        query = query.rstrip().rstrip(";") + " LIMIT 50"

    try:
        with driver.session() as session:
            result = session.run(query)
            rows = []
            for record in result:
                row = {k: _safe_value(v) for k, v in record.items() if k != "raw_text"}
                rows.append(row)
            return rows[:50]
    except Exception as exc:
        return [{"error": str(exc)}]


def _condense_paper_for_budget(title: str, raw_text: str, target_tokens: int) -> str:
    """Use Claude Haiku to condense *raw_text* to approximately *target_tokens* tokens.

    Preserves equations, numerical results, and method details while dropping
    boilerplate sections (intro motivation, related work, conclusion restatements).
    """
    target_words = max(300, target_tokens * 3)
    prompt = (
        f"Create a dense technical summary of the following paper in approximately {target_words} words.\n"
        "Preserve: all mathematical formulas (in LaTeX notation), specific numerical results and "
        "metrics (AUC, RMSE, accuracy, etc.), method names, architecture details, training "
        "procedures, dataset names and sizes, hyperparameters.\n"
        "Omit: introduction motivation, related work discussion, conclusion restatements, "
        "acknowledgements, references list.\n\n"
        f"Title: {title}\n\nText:\n{raw_text[:80000]}"
    )
    if _subscription_instead_of_key():
        from services.claude_code_chat import complete_claude_code
        return complete_claude_code("", prompt, model="haiku")
    msg = _personal_client().messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=min(4096, target_tokens + 200),
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text.strip()


def execute_library_tool(name: str, args: dict[str, Any], driver: Any) -> tuple[dict[str, Any], str] | None:
    """Run one of the Knowledge Chat library tools.

    Returns ``(step_event, result_text)``, where ``step_event`` is the UI
    reasoning-step dict and ``result_text`` is what goes back to the model, or
    None when *name* is not a library tool. Shared by the API-key loop and the
    Claude Code (subscription) path in ``services.claude_code_chat``.
    """
    desc: str = args.get("description", "Running tool")

    if name == "run_cypher":
        query: str = args.get("query", "")
        rows = _run_cypher_safe(driver, query) if driver else [{"error": "No DB driver available"}]
        step = {
            "type": "step",
            "kind": "cypher",
            "description": desc,
            "cypher": query,
            "count": len(rows) if not (len(rows) == 1 and "error" in rows[0]) else None,
        }
        return step, json.dumps(rows)

    if name == "semantic_search":
        sem_query: str = args.get("query", "")
        limit: int = min(int(args.get("limit", 10)), 20)
        if driver and sem_query:
            try:
                from services.embeddings import embed_text as _embed_text
                emb = _embed_text(sem_query)
                with driver.session() as _sess:
                    _result = _sess.run(
                        "CALL db.index.vector.queryNodes('paper_embeddings', $k, $emb) "
                        "YIELD node AS p, score "
                        "WHERE score > 0.60 "
                        "RETURN p.id AS id, p.title AS title, p.year AS year, "
                        "p.abstract AS abstract, p.summary AS summary, score "
                        "ORDER BY score DESC",
                        k=limit,
                        emb=emb,
                    )
                    sem_rows = [
                        {k: _safe_value(v) for k, v in r.items() if k != "raw_text"}
                        for r in _result
                    ][:limit]
            except Exception as exc:
                log.warning("semantic_search tool failed | %s", exc)
                sem_rows = [{"error": str(exc)}]
        else:
            sem_rows = [{"error": "Vector search unavailable"}]
        step = {
            "type": "step",
            "kind": "search",
            "description": desc,
            "cypher": f"[vector search] {sem_query}",
            "count": len(sem_rows) if not (len(sem_rows) == 1 and "error" in sem_rows[0]) else None,
            "papers": [
                {"id": r["id"], "title": r.get("title"), "year": r.get("year")}
                for r in sem_rows if r.get("id")
            ],
        }
        return step, json.dumps(sem_rows)

    if name == "load_full_text":
        lft_paper_id: str = args.get("paper_id", "")
        lft_title = lft_paper_id  # fallback label
        if driver and lft_paper_id:
            try:
                with driver.session() as _sess:
                    row = _sess.run(
                        "MATCH (p:Paper {id: $id}) RETURN p.raw_text AS raw_text, p.title AS title",
                        id=lft_paper_id,
                    ).single()
                if row and row["raw_text"]:
                    raw = row["raw_text"]
                    lft_title = row["title"] or lft_paper_id
                    raw_tokens = estimate_tokens(raw)
                    budget_tokens = 15_000
                    if raw_tokens <= budget_tokens:
                        lft_content = raw
                        tok_label = f"{raw_tokens:,} tokens"
                    else:
                        lft_content = _condense_paper_for_budget(lft_title, raw, budget_tokens)
                        tok_label = f"condensed to ~{estimate_tokens(lft_content):,} tokens"
                else:
                    lft_content = "[Full text not available for this paper]"
                    tok_label = "no text stored"
            except Exception as exc:
                log.warning("load_full_text tool failed | %s", exc)
                lft_content = f"[Error loading full text: {exc}]"
                tok_label = "error"
        else:
            lft_content = "[Full text unavailable — no database connection]"
            tok_label = "unavailable"
        step = {
            "type": "step",
            "kind": "fulltext",
            "description": f"Loading full text: {lft_title[:60]} ({tok_label})",
            "cypher": None,
            "count": None,
            "papers": [{"id": lft_paper_id, "title": lft_title}] if lft_title != lft_paper_id else [],
        }
        return step, lft_content

    if name == "list_figures":
        fig_paper_id: str = args.get("paper_id", "")
        figures: list[dict[str, Any]] = []
        if driver and fig_paper_id:
            from db.queries.figures import list_figures as _list_figures
            try:
                figures = [
                    {
                        "figure_number": f.get("figure_number"),
                        "page": f.get("page_number"),
                        "caption": (f.get("caption") or "")[:600],
                        "image_url": f"/papers/{fig_paper_id}/figures/{f['id']}/image",
                    }
                    for f in _list_figures(driver, fig_paper_id)
                    if f.get("drive_file_id")
                ]
            except Exception as exc:
                log.warning("list_figures tool failed | %s", exc)
        step = {
            "type": "step",
            "kind": "figures",
            "description": f"Listing figures of a paper ({len(figures)} found)",
            "cypher": None,
            "count": len(figures),
        }
        return step, json.dumps(figures) if figures else "[No extracted figures for this paper]"

    return None


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    return max(1, len(text) // 4)


def knowledge_chat_stream(
    question: str,
    history: list[dict[str, Any]],
    papers: list[dict[str, Any]],
    model: str = "claude",
    use_web: bool = True,
    driver: Any = None,
):
    """Agentic generator for knowledge-chat with live Cypher tool access.

    Yields event dicts consumed directly by the SSE router:
      {"type": "status",  "text": str}
      {"type": "step",    "description": str, "cypher": str|None, "count": int|None}
      {"type": "token",   "text": str}

    The model may call ``run_cypher`` zero or more times before composing
    its final answer.  Each tool call is executed against Neo4j, yielded as
    a step event so the frontend can display the reasoning trace, and its
    results are fed back into the conversation before the next call.
    """
    def _paper_block(p: dict) -> str:
        parts = [f"### {p.get('title', 'Untitled')}", f"id: {p.get('id')}" + (f" · year: {p['year']}" if p.get("year") else "")]
        if p.get("_attached"):
            parts.append("(attached by the user to this question)")
        if p.get("abstract"):
            parts.append(f"Abstract: {p['abstract']}")
        if p.get("summary"):
            parts.append(f"Summary: {p['summary']}")
        if p.get("_note"):
            parts.append(f"My note on this paper:\n{p['_note']}")
        if p.get("_conversations"):
            parts.append(f"Previous chat history about this paper:\n{p['_conversations']}")
        return "\n".join(parts)

    # ── Claude Code (subscription) path ──────────────────────────────────────
    if model == "claude" and _subscription_instead_of_key():
        model = "claude-code"
    if model == "claude-code":
        from services.claude_code_chat import knowledge_chat_claude_code
        papers_block = "\n\n".join(_paper_block(p) for p in papers)
        system = _load_prompt("knowledge_chat_system.txt").replace("{papers_block}", papers_block)
        yield from knowledge_chat_claude_code(system, history, question, driver, use_web)
        return

    # ── Web pre-search ────────────────────────────────────────────────────────
    web_context = ""
    if use_web:
        yield {"type": "status", "text": "Searching the web..."}
        try:
            web_context = _fetch_web_context(question, history)
        except Exception as exc:
            log.warning("Knowledge chat web pre-search failed (non-fatal) | %s", exc)
        yield {"type": "status", "text": ""}

    # ── Build system prompt ───────────────────────────────────────────────────
    papers_block = "\n\n".join(_paper_block(p) for p in papers)
    system = _load_prompt("knowledge_chat_system.txt").replace("{papers_block}", papers_block)
    if web_context:
        system += f"\n\n## Recent Web Context\n{web_context}"

    # ── LiteLLM (self-hosted model): one completion, no library tools ─────────
    if model in ("litellm", "ollama"):
        from services.litellm_client import chat_completion
        yield {"type": "status", "text": "Asking the LiteLLM model..."}
        text = chat_completion(
            [{"role": "system", "content": system}, *history, {"role": "user", "content": question}],
            timeout=300,
        )
        yield {"type": "status", "text": ""}
        for i in range(0, len(text), 40):
            yield {"type": "token", "text": text[i:i + 40]}
        return

    # ── Select client ─────────────────────────────────────────────────────────
    if model == "claude-work":
        cfg = get_effective_ai_config()
        work_key = (cfg.get("anthropic_work_api_key") or "").strip()
        if not work_key:
            raise ValueError("Work API key not configured for this user.")
        work_base = (cfg.get("anthropic_work_base_url") or "").strip()
        client = anthropic.Anthropic(
            api_key=work_key,
            base_url=work_base or None,
            default_headers={"Authorization": f"Bearer {work_key}"},
            http_client=anthropic.DefaultHttpxClient(verify=_ssl_verify()),
        )
    else:
        client = _personal_client()

    # ── Model routing: use Opus when context is large ────────────────────────
    estimated_ctx = (
        estimate_tokens(system)
        + sum(estimate_tokens(m.get("content", "")) for m in history)
        + estimate_tokens(question)
    )
    if model == "claude" and estimated_ctx > 40_000:
        claude_model = "claude-opus-4-6"
        log.info("knowledge_chat: routing to claude-opus-4-6 (estimated ctx=%d tokens)", estimated_ctx)
    else:
        claude_model = "claude-sonnet-4-6"

    tools = list(LIBRARY_TOOLS) if driver is not None else []

    # ── Agentic tool-use loop (non-streaming) ─────────────────────────────────
    # Phase 1: let Claude call run_cypher / semantic_search as many times as
    # it needs.  Each tool call is executed, the result is fed back, and a step
    # event is yielded so the frontend can show the reasoning trace.  The loop
    # exits when Claude returns stop_reason != "tool_use".
    messages: list[dict[str, Any]] = list(history)
    messages.append({"role": "user", "content": question})

    had_tool_calls = False

    while True:
        response = client.messages.create(
            model=claude_model,
            max_tokens=16000,
            system=system,
            messages=messages,
            tools=tools if tools else anthropic.NOT_GIVEN,
        )

        if response.stop_reason != "tool_use":
            # No more tool calls — Claude is ready to write its final answer.
            if not had_tool_calls:
                # No tool calls at all → stream for better responsiveness
                with client.messages.stream(
                    model=claude_model,
                    max_tokens=16000,
                    system=system,
                    messages=messages,
                ) as stream:
                    for text in stream.text_stream:
                        yield {"type": "token", "text": text}
            else:
                # Tool calls happened → chunk the already-computed final text
                CHUNK = 40
                final_text = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        final_text = block.text
                        break
                for i in range(0, len(final_text), CHUNK):
                    yield {"type": "token", "text": final_text[i : i + CHUNK]}
            break

        # ── Execute tool calls ────────────────────────────────────────────────
        had_tool_calls = True
        tool_results: list[dict[str, Any]] = []

        for block in response.content:
            if block.type != "tool_use":
                continue
            executed = execute_library_tool(block.name, block.input, driver)
            if executed is None:
                continue
            step, content = executed
            yield step
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": content,
            })

        if not tool_results:
            # No recognised tools in this response — break to avoid infinite loop
            break

        # Feed tool results back into the conversation and loop
        messages = list(messages)
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})


def summarize_chapter(title: str, text: str, model: str | None = None) -> str:
    """Return a markdown summary of a book/lecture chapter.

    Routes to work gateway when model=='claude-work', personal Anthropic when
    model starts with 'claude-', otherwise LiteLLM.
    """
    if not text or not text.strip():
        return "_No text available for this chapter._"

    effective_model = resolve_chat_model(model)
    use_claude = effective_model == "claude-work" or effective_model.startswith("claude-")
    prompt = _load_prompt("chapter_summary.txt").format(
        title=title or "(untitled chapter)",
        text=text[:20000] if use_claude else text[:8000],
    )

    if effective_model == "claude-work":
        work_client = _work_client()
        message = work_client.messages.create(
            model="claude-opus-4-6",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text
    elif effective_model.startswith("claude-"):
        if _subscription_instead_of_key():
            from services.claude_code_chat import complete_claude_code
            return complete_claude_code("", prompt)
        client = _personal_client()
        message = client.messages.create(
            model=effective_model,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text
    else:
        return chat_completion(
            messages=[{"role": "user", "content": prompt}],
            model=effective_model,
        )


def chat_with_chapter(
    chapter_title: str,
    chapter_text: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Answer *question* about a specific chapter using Gemma."""
    system = _load_prompt("chapter_chat_system.txt").format(
        title=chapter_title or "(untitled chapter)",
        text=chapter_text[:24000],
    )
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": question})
    return chat_completion(
        messages=messages,
        max_tokens=1024,
    )


def detect_chapters_with_ai(title: str, text: str) -> list[dict]:
    """
    Use LiteLLM to propose a chapter structure from a book/lecture PDF text.
    Returns a list of top-level (logical) chapters: [{number, title, level}, ...].

    Sub-chapters / sub-sections are intentionally NOT returned — only the main
    logical chapters of the book. Falls back to [] on any error.
    """
    import json, re

    if not text or not text.strip():
        return []

    prompt = (
        "You are a book indexer. Given the following text from a book or lecture deck, "
        "identify ONLY the main, top-level logical chapters of the document. "
        "Do NOT include sub-chapters, sub-sections, or numbered sub-divisions "
        "(e.g. '2.1', '2.1.3', or a subsection nested under a chapter) — list a "
        "chapter only once at its highest level. "
        "Return a JSON object with key 'chapters', each item having: "
        "number (int), title (str), level (always 1).\n\n"
        f"Document title: {title or '(unknown)'}\n\n"
        f"Document text (first 6000 words):\n{text[:15000]}"
    )
    raw_text = chat_completion(messages=[{"role": "user", "content": prompt}])
    match = re.search(r'\{.*\}', raw_text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group())
        chapters = data.get("chapters") or []
        # Keep only top-level chapters — drop anything the model still tags as a
        # sub-chapter (level >= 2) or whose title looks like a numbered subsection
        # such as "2.1 Foo" or "3.4.1 Bar".
        result: list[dict] = []
        for c in chapters:
            raw_title = str(c.get("title", "")).strip()
            if not raw_title:
                continue
            if int(c.get("level", 1)) >= 2:
                continue
            if re.match(r"^\d+\.\d+", raw_title):
                continue
            result.append({
                "number": len(result) + 1,
                "title": raw_title,
                "level": 1,
            })
        return result
    except Exception:
        return []


def extract_affiliations_with_litellm(author_names: list[str], text: str) -> dict[str, str | None]:
    """Use LiteLLM to extract institutional affiliations for authors from paper text.
    Returns {author_name: affiliation_or_None}.
    """
    import json as _json

    if not author_names:
        return {}

    prompt = _load_prompt("author_affiliations.txt").format(
        author_names="\n".join(f"- {n}" for n in author_names),
        text=text[:4000],  # first 4000 chars — affiliations are always in the header
    )
    try:
        raw = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            json_mode=True,
        )
        parsed = _json.loads(raw)
        result: dict[str, str | None] = {}
        for entry in parsed.get("affiliations") or []:
            name = entry.get("name", "").strip()
            aff = entry.get("affiliation") or None
            if name:
                result[name] = aff
        return result
    except Exception as exc:
        log.warning("LiteLLM affiliation extraction failed: %s", exc)
        return {}


extract_affiliations_with_ollama = extract_affiliations_with_litellm


# ── Blog post AI ───────────────────────────────────────────────────────────────

def summarize_blog_post(content: str, title: str = "") -> str:
    """Summarize a blog post using Claude Haiku (fast, cheap)."""
    if not content or not content.strip():
        return "_No content available to summarize._"

    prompt = (
        f"Summarize the following blog post concisely in 3-5 bullet points. "
        f"Focus on the key ideas, insights, and takeaways. "
        f"Use markdown formatting.\n\n"
        f"Title: {title or '(unknown)'}\n\n"
        f"Content:\n{content[:24000]}"
    )

    return chat_completion(
        messages=[{"role": "user", "content": prompt}],
        max_tokens=800,
    )


def chat_with_blog_post(
    content: str,
    title: str,
    question: str,
    history: list[dict[str, Any]] | None = None,
) -> str:
    """Answer a question about a blog post using its content as context."""
    system = (
        f"You are an expert assistant helping the user understand a blog post.\n\n"
        f"Blog post title: {title or '(unknown)'}\n\n"
        f"Blog post content:\n{content[:24000]}\n\n"
        f"Answer the user's questions about this blog post concisely and accurately. "
        f"If the answer is not in the blog post, say so."
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": question})

    return chat_completion(
        messages=messages,
        max_tokens=1024,
    )


# ── Research Gap Finder (T29) ─────────────────────────────────────────────────

def find_research_gaps(
    topic: str,
    papers: list[dict],   # list of {title, abstract, summary, year}
    model: str = "litellm",
) -> str:
    """
    Analyze research gaps using the specified model with web_search tool enabled.
    Returns markdown analysis string.
    
    Args:
        topic: Research topic or question
        papers: List of papers with title, abstract, summary, year
        model: "claude" (personal), "claude-work", or "litellm"
    """
    def _paper_block(p: dict) -> str:
        parts = [f"- **{p.get('title', 'Untitled')}** ({p.get('year', '?')})"]
        if p.get("abstract"):
            parts.append(f"  {p['abstract'][:300]}")
        return "\n".join(parts)

    papers_block = "\n".join(_paper_block(p) for p in papers) or "(no papers in library for this topic)"
    system_prompt = _load_prompt("research_gaps.txt").format(
        topic=topic,
        n=len(papers),
        papers_block=papers_block,
    )
    
    # Without a LiteLLM proxy, "Gemma" runs on Claude like everywhere else, so give it the web too.
    if model in ("litellm", "ollama") and not litellm_configured():
        model = "claude"

    # Route to appropriate model
    if model == "claude-work":
        client = _work_client()
        return _run_claude_with_tools(
            client,
            "claude-opus-4-6",
            "You are a research strategist with web search capabilities.",
            [{"role": "user", "content": system_prompt}],
            max_tokens=2048,
        )
    elif model in ("litellm", "ollama"):
        return chat_completion(
            messages=[
                {"role": "system", "content": "You are a research strategist analyzing research gaps. Provide structured analysis with sections: Coverage Summary, Identified Gaps, Recommended Next Reads, and Open Questions."},
                {"role": "user", "content": system_prompt},
            ],
        )
    else:  # "claude" (personal)
        if _subscription_instead_of_key():
            from services.claude_code_chat import complete_claude_code
            return complete_claude_code(
                "You are a research strategist with web search capabilities.", system_prompt,
                model="opus", use_web=True,
            )
        client = _personal_client()
        return _run_claude_with_tools(
            client,
            "claude-opus-4-6",
            "You are a research strategist with web search capabilities.",
            [{"role": "user", "content": system_prompt}],
            max_tokens=2048,
        )


def extract_claims(text: str, title: str, model: str | None = None) -> list[dict]:
    """
    Extract claims from paper text using Claude Haiku or LiteLLM.
    Routes to Anthropic when model starts with 'claude-', otherwise LiteLLM.
    Returns list of {"text": str, "type": str}.
    Returns [] on any error (non-fatal — called best-effort on upload).
    """
    import json, re
    if not text or not text.strip():
        return []
    
    effective_model = resolve_chat_model(model)
    prompt = _load_prompt("claims.txt").format(
        title=title or "(unknown)",
        text=text[:40000] if effective_model.startswith("claude-") else text[:12000],
    )
    
    try:
        if effective_model.startswith("claude-") and _subscription_instead_of_key():
            from services.claude_code_chat import complete_claude_code
            raw = complete_claude_code("", prompt)
        elif effective_model.startswith("claude-"):
            client = _personal_client()
            message = client.messages.create(
                model=effective_model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = message.content[0].text.strip()
        else:
            raw = chat_completion(
                messages=[{"role": "user", "content": prompt}],
                model=effective_model,
                json_mode=True,
            )
        
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return []
        data = json.loads(match.group())
        return [c for c in (data.get("claims") or []) if c.get("text")]
    except Exception as exc:
        log.warning("extract_claims failed (non-fatal) | model=%s | %s", effective_model, exc)
        return []



def _generate_search_queries(question: str, history: list[dict]) -> list[str]:
    """
    Use Claude Haiku to extract up to 3 search queries from the user's question.
    Returns [] if the question is clearly answerable from library context alone
    (e.g. 'summarise paper X', 'what do my papers say about Y').
    """
    import json, re
    
    prompt = f"""Given this research question, suggest up to 3 web search queries
that would find relevant recent papers, blog posts, or news. If no web
search is needed (the question is about the user's own library), return an empty list.
Return JSON: {{"queries": ["...", "..."]}}

Question: {question}"""
    
    try:
        raw = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=256,
            json_mode=True,
        ).strip()
        match = re.search(r'\{.*\}', raw, re.DOTALL)
        if not match:
            return []
        data = json.loads(match.group())
        queries = data.get("queries") or []
        return [q.strip() for q in queries if q.strip()][:3]
    except Exception as exc:
        log.warning("_generate_search_queries failed | %s", exc)
        return []


def _fetch_web_context(question: str, history: list[dict]) -> str:
    """
    Runs _generate_search_queries(), executes each via search_web(),
    formats results with format_results_for_prompt().
    Returns empty string if no queries generated or all searches fail.
    """
    from services.web_search import search_web, format_results_for_prompt
    
    queries = _generate_search_queries(question, history)
    if not queries:
        return ""
    
    all_results = []
    for query in queries:
        results = search_web(query, max_results=5)
        all_results.extend(results)
    
    if not all_results:
        return ""
    
    return format_results_for_prompt(all_results)


def synthesize_papers(
    papers: list[dict],        # list of {title, abstract, summary, raw_text (optional)}
    question: str,
    use_web: bool = True,
) -> str:
    """
    Builds a synthesis prompt from the selected papers.
    Each paper contributes its abstract + summary (not full raw_text — too large).
    Optionally uses web search via _run_claude_with_tools().
    Returns markdown synthesis string.
    """
    def _paper_block(p: dict) -> str:
        parts = [f"### {p.get('title', 'Untitled')}"]
        if p.get("year"):
            parts[0] += f" ({p['year']})"
        if p.get("abstract"):
            parts.append(f"**Abstract:** {p['abstract'][:1500]}")
        if p.get("summary"):
            parts.append(f"**Summary:** {p['summary'][:2000]}")
        return "\n".join(parts)

    papers_block = "\n\n".join(_paper_block(p) for p in papers)
    prompt = _load_prompt("synthesis.txt").format(
        n=len(papers),
        question=question,
        papers_block=papers_block,
    )

    if _subscription_instead_of_key():
        from services.claude_code_chat import complete_claude_code
        return complete_claude_code("You are a research synthesis expert.", prompt, model="opus", use_web=use_web)
    client = _personal_client()
    if use_web:
        return _run_claude_with_tools(
            client, "claude-opus-4-6",
            "You are a research synthesis expert.", 
            [{"role": "user", "content": prompt}],
            max_tokens=2048,
        )
    else:
        return chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=2048,
        )
