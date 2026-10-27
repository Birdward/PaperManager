"""Knowledge Chat — cross-library graph-aware chat with SSE streaming."""
from __future__ import annotations
import contextvars
import json
import logging
import re
import threading
from typing import Any, Generator

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from db.connection import get_driver
from db.queries.conversations import (
    create_conversation, add_message, list_conversations,
    get_messages, compact_conversation, compact_conversation_sliding_window,
    delete_conversation, get_paper_context_snippets, get_message,
    set_message_concepts, fork_conversation, rename_conversation,
    set_branch_label_if_empty, set_message_error,
)
from models.schemas import KnowledgeChatRequest, ConversationOut, MessageOut
from services.ai import knowledge_chat_stream, estimate_tokens, summarize_paper, CONTEXT_WINDOW
from services.auth import get_current_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/knowledge-chat", tags=["knowledge-chat"], dependencies=[Depends(get_current_user)])

# ── SSE helpers ────────────────────────────────────────────────────────────────

# A paper's note goes into Knowledge Chat context in full up to this length, then cut.
_NOTE_INLINE_CHARS = 1500


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


_HEARTBEAT_S = 15
_MAX_SILENCE_S = 600
_END = object()


def _with_heartbeat(events, every: float = _HEARTBEAT_S, max_silence: float = _MAX_SILENCE_S):
    """Yield *events*, and ``None`` whenever none arrived for *every* seconds.

    After *max_silence* seconds without an event the model is taken to be stuck
    and ``TimeoutError`` is raised, so the chat shows an error instead of
    waiting forever.

    The model can think or run tools for minutes without a token; the proxies in
    front of the backend close a response that stays silent for a minute. The
    caller turns ``None`` into an SSE comment, which keeps the stream open and is
    ignored by the browser. The producer runs in a thread with the request's
    context (the current user decides the model routing).
    """
    import queue

    q: queue.Queue = queue.Queue()

    def produce() -> None:
        try:
            for ev in events:
                q.put(ev)
        except Exception as exc:  # re-raised in the consumer
            q.put(exc)
        finally:
            q.put(_END)

    ctx = contextvars.copy_context()
    threading.Thread(target=ctx.run, args=(produce,), daemon=True).start()
    return _drain(q, every, max_silence)


def _drain(q, every: float, max_silence: float):
    import queue

    silent = 0.0
    while True:
        try:
            item = q.get(timeout=every)
        except queue.Empty:
            silent += every
            if silent >= max_silence:
                raise TimeoutError(f"The model sent nothing for {int(max_silence // 60)} minutes; try again.")
            yield None
            continue
        silent = 0.0
        if item is _END:
            return
        if isinstance(item, Exception):
            raise item
        yield item


# ── @mention parsing ──────────────────────────────────────────────────────────

_MENTION_RE = re.compile(
    r"@(project|tag|topic|paper|blog|person):(?:\"([^\"]+)\"|'([^']+)'|([^\s@,]+))",
    re.IGNORECASE,
)

# Paper colour palette for context bar (cycled)
_PAPER_COLORS = [
    "#7c3aed", "#2563eb", "#0891b2", "#059669",
    "#d97706", "#dc2626", "#7c3aed", "#9333ea",
]


def _parse_mentions(text: str) -> list[tuple[str, str]]:
    """Return list of (type, value) tuples from @mentions in text."""
    mentions: list[tuple[str, str]] = []
    for m in _MENTION_RE.finditer(text):
        value = m.group(2) or m.group(3) or m.group(4)
        if value:
            mentions.append((m.group(1).lower(), value))
    return mentions


def _fetch_papers_for_mention(
    session, mention_type: str, value: str
) -> tuple[list[dict], str, str]:
    """
    Run the appropriate Cypher query for a mention type.
    Returns (papers, cypher_query, description).
    Papers are dicts with keys: id, title, abstract, summary.
    """
    value_clean = value.replace("-", " ").lower()

    if mention_type == "tag":
        cypher = (
            "MATCH (p:Paper)-[:TAGGED]->(:Tag {name: $val}) "
            "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
            "LIMIT 20"
        )
        desc = f"Fetching papers tagged '{value}'"
        result = session.run(cypher, val=value)

    elif mention_type == "topic":
        cypher = (
            "MATCH (p:Paper)-[:ABOUT]->(:Topic) WHERE toLower(t.name) CONTAINS $val "
            "WITH p LIMIT 20 "
            "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary"
        )
        # Simpler approach: exact name match first, then fallback to contains
        cypher = (
            "MATCH (p:Paper)-[:ABOUT]->(t:Topic) "
            "WHERE toLower(t.name) CONTAINS $val "
            "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
            "LIMIT 20"
        )
        desc = f"Fetching papers about topic '{value}'"
        result = session.run(cypher, val=value_clean)

    elif mention_type == "project":
        cypher = (
            "MATCH (p:Paper)-[:IN_PROJECT]->(proj:Project) "
            "WHERE toLower(proj.name) CONTAINS $val "
            "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
            "LIMIT 30"
        )
        desc = f"Fetching papers in project '{value}'"
        result = session.run(cypher, val=value_clean)

    elif mention_type == "paper":
        cypher = (
            "MATCH (p:Paper) "
            "WHERE toLower(p.title) CONTAINS $val "
            "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
            "LIMIT 5"
        )
        desc = f"Fetching paper matching '{value}'"
        result = session.run(cypher, val=value_clean)

    elif mention_type == "blog":
        cypher = (
            "MATCH (bp:BlogPost)-[:FROM_BLOG]->(b:Blog) "
            "WHERE toLower(b.name) CONTAINS $val OR toLower(bp.title) CONTAINS $val "
            "RETURN bp.id AS id, bp.title AS title, bp.description AS abstract, bp.summary AS summary "
            "LIMIT 20"
        )
        desc = f"Fetching blog posts matching '{value}'"
        result = session.run(cypher, val=value_clean)

    elif mention_type == "person":
        # value can be a tag name (e.g. "known-personally") or a person's name
        # First try as a tag on Person nodes → get their papers
        # Then try as a person name match
        cypher = (
            "MATCH (paper:Paper)-[:AUTHORED_BY|INVOLVES]->(person:Person) "
            "WHERE (person)-[:TAGGED]->(:Tag {name: $val}) "
            "   OR toLower(person.name) CONTAINS $name_val "
            "RETURN DISTINCT paper.id AS id, paper.title AS title, paper.year AS year, "
            "       paper.abstract AS abstract, paper.summary AS summary "
            "LIMIT 30"
        )
        desc = f"Fetching papers by people matching '{value}'"
        result = session.run(cypher, val=value, name_val=value_clean)

    else:
        return [], "", ""

    papers = [dict(r) for r in result]
    return papers, cypher, desc


def _fallback_all_papers(session, question: str = "") -> list[dict]:
    """When no @mentions, retrieve papers via hybrid retrieval.

    Primary: semantic vector search on the user's question (top 10 by cosine similarity).
    Secondary: 10 most recently added papers (recency fallback).
    Blog posts: 5 most recently imported posts.
    All three sets are merged and deduplicated by id.
    """
    papers_by_id: dict[str, dict] = {}

    # Semantic retrieval — best effort, falls back silently if embeddings unavailable
    if question:
        try:
            from services.embeddings import embed_text as _embed_text
            emb = _embed_text(question)
            result = session.run(
                "CALL db.index.vector.queryNodes('paper_embeddings', 10, $emb) "
                "YIELD node AS p, score "
                "WHERE score > 0.55 "
                "AND NOT (p)-[:TAGGED]->(:Tag {name: 'from-references'}) "
                "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
                "ORDER BY score DESC",
                emb=emb,
            )
            for r in result:
                row = dict(r)
                papers_by_id[row["id"]] = row
        except Exception as exc:
            log.debug("Semantic pre-fetch failed (non-fatal) | %s", exc)

    # Recency fallback — fills gaps when vector index is cold or sparse
    cypher_papers = (
        "MATCH (p:Paper) WHERE NOT (p)-[:TAGGED]->(:Tag {name: 'from-references'}) "
        "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary "
        "ORDER BY p.created_at DESC LIMIT 10"
    )
    for r in session.run(cypher_papers):
        row = dict(r)
        if row["id"] not in papers_by_id:
            papers_by_id[row["id"]] = row

    # Blog posts
    cypher_posts = (
        "MATCH (bp:BlogPost) WHERE bp.imported = true "
        "RETURN bp.id AS id, bp.title AS title, bp.description AS abstract, bp.summary AS summary "
        "ORDER BY bp.created_at DESC LIMIT 5"
    )
    posts = [dict(r) for r in session.run(cypher_posts)]

    return list(papers_by_id.values()) + posts


# ── SSE stream generator ──────────────────────────────────────────────────────

def _stream(body: KnowledgeChatRequest) -> Generator[str, None, None]:
    driver = get_driver()

    # Step 1: parse mentions
    mentions = _parse_mentions(body.question)
    yield _sse({"type": "step", "description": "Parsing @mentions in your question",
                "cypher": None, "count": len(mentions)})

    # Step 2: fetch papers per mention
    papers_by_id: dict[str, dict] = {}
    with driver.session() as session:
        if mentions:
            for mtype, mval in mentions:
                papers, cypher, desc = _fetch_papers_for_mention(session, mtype, mval)
                yield _sse({
                    "type": "step",
                    "description": desc,
                    "cypher": cypher,
                    "count": len(papers),
                })
                for p in papers:
                    if p["id"] not in papers_by_id:
                        papers_by_id[p["id"]] = p
        else:
            yield _sse({
                "type": "step",
                "description": "No scope given: choosing papers by semantic search and recency",
                "cypher": None,
                "count": None,
            })
            papers = _fallback_all_papers(session, question=body.question)
            for p in papers:
                papers_by_id[p["id"]] = p

    # Papers attached in the composer always come first, whatever the mentions found.
    if body.paper_ids:
        with driver.session() as session:
            attached = [dict(r) for r in session.run(
                "UNWIND $ids AS pid MATCH (p:Paper {id: pid}) "
                "RETURN p.id AS id, p.title AS title, p.year AS year, p.abstract AS abstract, p.summary AS summary",
                ids=body.paper_ids[:20],
            )]
        yield _sse({"type": "step", "kind": "attach", "description": "Adding the papers you attached",
                    "cypher": None, "count": len(attached),
                    "papers": [{"id": p["id"], "title": p["title"], "year": p.get("year")} for p in attached]})
        for p in attached:
            p["_attached"] = True
        rest = {k: v for k, v in papers_by_id.items() if k not in {p["id"] for p in attached}}
        papers_by_id = {p["id"]: p for p in attached} | rest

    all_papers = list(papers_by_id.values())

    # Step 3: compute token estimates
    sys_tokens = estimate_tokens(
        open(__import__("pathlib").Path(__file__).parent.parent.parent / "prompts" /
             "knowledge_chat_system.txt").read()
    ) + 200  # buffer for papers_block header

    history_tokens = sum(estimate_tokens(m.content) for m in body.history)
    question_tokens = estimate_tokens(body.question)

    # Enrich papers with their notes + conversation summaries. Long notes are cut here and
    # highlights only counted, so context stays bounded however much the reader has written;
    # the model reads the rest with the read_my_notes tool.
    from services.my_notes import highlight_counts
    highlights = highlight_counts(driver, [p["id"] for p in all_papers])
    with driver.session() as session:
        for p in all_papers:
            snippets = get_paper_context_snippets(driver, p["id"])
            note = (snippets.get("note") or "").strip()
            if note:
                p["_note"] = note if len(note) <= _NOTE_INLINE_CHARS else (
                    note[:_NOTE_INLINE_CHARS] + f" […{len(note) - _NOTE_INLINE_CHARS} more characters: read_my_notes]")
            if highlights.get(p["id"]):
                p["_highlights"] = highlights[p["id"]]
            if snippets.get("conversations"):
                conv_texts = []
                for conv in snippets["conversations"]:
                    msgs = conv.get("messages") or []
                    if not msgs:
                        continue
                    if conv.get("compacted") and msgs:
                        conv_texts.append(f"[Conversation: {conv['title']}]\n{msgs[0]['content']}")
                    else:
                        excerpt = "\n".join(
                            f"{m['role'].upper()}: {m['content'][:400]}"
                            for m in msgs[-6:]  # last 3 exchanges
                        )
                        conv_texts.append(f"[Conversation: {conv['title']}]\n{excerpt}")
                if conv_texts:
                    p["_conversations"] = "\n\n".join(conv_texts)

    paper_infos = []
    for i, p in enumerate(all_papers):
        text_parts = [p.get("title"), p.get("abstract"), p.get("summary"),
                      p.get("_note"), p.get("_conversations")]
        text = " ".join(filter(None, text_parts))
        tok = estimate_tokens(text)
        paper_infos.append({
            "id": p["id"],
            "title": p.get("title") or "Untitled",
            "year": p.get("year"),
            "attached": bool(p.get("_attached")),
            "tokens": tok,
            "color": _PAPER_COLORS[i % len(_PAPER_COLORS)],
            "has_note": bool(p.get("_note")),
            "has_conversations": bool(p.get("_conversations")),
        })

    papers_tokens = sum(pi["tokens"] for pi in paper_infos)
    total_tokens = sys_tokens + papers_tokens + history_tokens + question_tokens

    yield _sse({
        "type": "context",
        "papers": paper_infos,
        "token_totals": {
            "system": sys_tokens,
            "papers": papers_tokens,
            "history": history_tokens,
            "question": question_tokens,
            "total": total_tokens,
            "limit": CONTEXT_WINDOW,
        },
    })

    # Step 4: create/load conversation, save user message
    conv_id = body.conversation_id
    if not conv_id:
        title = body.question[:60] + ("…" if len(body.question) > 60 else "")
        conv = create_conversation(driver, title)
        conv_id = conv["id"]

    paper_ids = [p["id"] for p in all_papers]
    user_msg = add_message(driver, conv_id, "user", body.question, paper_ids, question_tokens)
    set_branch_label_if_empty(driver, conv_id, body.question[:80])

    def answer() -> Generator[dict, None, None]:
        """Model call and save in one producer: it runs to the end even if the
        browser disconnects, so a dropped connection never loses the answer
        (the page then finds it by polling the conversation)."""
        full_answer = ""
        try:
            for event in knowledge_chat_stream(
                question=body.question,
                history=[{"role": m.role, "content": m.content} for m in body.history],
                papers=all_papers,
                model=body.model,
                use_web=body.use_web,
                driver=driver,
            ):
                if event.get("type") == "token":
                    full_answer += event.get("text", "")
                yield event
        except Exception as exc:
            log.error("knowledge_chat_stream error | %s", exc)
            set_message_error(driver, user_msg["id"], str(exc)[:1000])
            yield {"type": "error", "message": str(exc)}
            return
        # Step 6: save assistant message and emit done
        msg = add_message(driver, conv_id, "assistant", full_answer, paper_ids, estimate_tokens(full_answer))
        yield {"type": "done", "conversation_id": conv_id, "message_id": msg["id"]}

    # The producer starts now, before anything else is sent: from here on the
    # answer is written and saved whether or not the browser stays connected.
    events = _with_heartbeat(answer())
    yield _sse({"type": "conversation", "conversation_id": conv_id, "user_message_id": user_msg["id"]})
    yield _sse({"type": "step", "description": "Sending to Claude…", "cypher": None, "count": None})
    try:
        for event in events:
            yield ": keep-alive\n\n" if event is None else _sse(event)
    except TimeoutError as exc:
        set_message_error(driver, user_msg["id"], str(exc))
        yield _sse({"type": "error", "message": str(exc)})


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/stream")
def stream_chat(body: KnowledgeChatRequest):
    return StreamingResponse(
        _stream(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/conversations", response_model=list[ConversationOut])
def get_conversations():
    return list_conversations(get_driver())


@router.get("/conversations/{conv_id}/messages", response_model=list[MessageOut])
def get_conv_messages(conv_id: str):
    msgs = get_messages(get_driver(), conv_id)
    if msgs is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return msgs


@router.post("/conversations/{conv_id}/compact", response_model=MessageOut)
def compact(conv_id: str):
    """Sliding-window compaction: keep the last 6 messages verbatim and replace
    older messages with a structured working-memory JSON block + prose summary.
    This preserves specific paper titles, numbers, and claims that a pure
    prose summary would elide."""
    import json as _json
    import re as _re
    from services.ai import _personal_client, _load_prompt

    msgs = get_messages(get_driver(), conv_id)
    if not msgs:
        raise HTTPException(status_code=404, detail="Conversation not found or empty")

    # Build a compact transcript of the messages to be summarised (all but last 6)
    msgs_to_summarise = msgs[:-6] if len(msgs) > 6 else msgs
    transcript = "\n\n".join(
        f"{m['role'].upper()}: {m['content'][:600]}" for m in msgs_to_summarise
    )

    # Extract structured working memory via Claude Haiku
    extraction_prompt = (
        "Extract a structured working memory from this research conversation. "
        "Return a JSON object with exactly these keys:\n"
        '  "papers_discussed": [list of paper titles mentioned],\n'
        '  "key_findings": [specific empirical claims or numbers noted],\n'
        '  "open_questions": [unresolved questions or threads],\n'
        '  "decisions": [conclusions or directions agreed upon]\n'
        "Return only the JSON object, no other text.\n\n"
        f"Conversation:\n{transcript[:8000]}"
    )
    prose_prompt = (
        "Write a 3-5 sentence summary of the following research conversation, "
        "focusing on what was established and what remains open.\n\n"
        f"Conversation:\n{transcript[:8000]}"
    )

    try:
        from services.litellm_client import chat_completion

        wm_text = chat_completion(
            messages=[{"role": "user", "content": extraction_prompt}],
            max_tokens=512,
            json_mode=True,
        ).strip()
        # Validate JSON; fall back to empty structure on parse failure
        match = _re.search(r"\{.*\}", wm_text, _re.DOTALL)
        working_memory_json = match.group() if match else "{}"
        _json.loads(working_memory_json)  # validate

        prose_summary = chat_completion(
            messages=[{"role": "user", "content": prose_prompt}],
            max_tokens=256,
        ).strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Compaction failed: {exc}")

    return compact_conversation_sliding_window(
        get_driver(), conv_id,
        working_memory_json=working_memory_json,
        prose_summary=prose_summary,
        keep_last_n=6,
    )


@router.delete("/conversations/{conv_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conv(conv_id: str):
    delete_conversation(get_driver(), conv_id)


class RenameBody(BaseModel):
    title: str


@router.patch("/conversations/{conv_id}", response_model=ConversationOut)
def rename_conv(conv_id: str, body: RenameBody):
    title = body.title.strip()[:200]
    if not title:
        raise HTTPException(status_code=422, detail="Title must not be empty")
    conv = rename_conversation(get_driver(), conv_id, title)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {**conv, "message_count": 0}


# ── Forks ("strands") ─────────────────────────────────────────────────────────

class ForkBody(BaseModel):
    # Questions to inherit (with their answers); 0 forks before the first one.
    keep: int
    # "strand" continues after an answer, "edit" re-asks a question differently.
    kind: str = "strand"


@router.post("/conversations/{conv_id}/fork", response_model=ConversationOut)
def fork_conv(conv_id: str, body: ForkBody):
    if body.keep < 0 or body.kind not in ("strand", "edit"):
        raise HTTPException(status_code=422, detail="Bad fork request")
    try:
        return fork_conversation(get_driver(), conv_id, body.keep, body.kind)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Concept cards on answers ──────────────────────────────────────────────────
# One background job per answer; the cards are stored on the Message node, so
# the frontend polls GET .../concepts until the status leaves "running".

_concept_jobs: set[str] = set()
_concept_lock = threading.Lock()


class ConceptsState(BaseModel):
    status: str | None = None          # None (never run) | running | done | failed
    error: str | None = None
    concepts: list[dict] | None = None


def _answer_or_404(msg_id: str) -> dict:
    msg = get_message(get_driver(), msg_id)
    if not msg or msg["role"] != "assistant":
        raise HTTPException(status_code=404, detail="Answer not found")
    return msg


def _state(msg: dict) -> dict:
    status_ = msg.get("concepts_status")
    if status_ == "running" and msg["id"] not in _concept_jobs:
        # The job died with the process (a restart); let the user start again.
        status_, msg["concepts_error"] = "failed", "Interrupted; start it again."
    return {"status": status_, "error": msg.get("concepts_error"), "concepts": msg.get("concepts")}


def _run_concepts(msg: dict) -> None:
    from services.chat_concepts import visualise_answer

    driver = get_driver()
    try:
        cards = visualise_answer(msg["content"], title=msg.get("question", "")[:200])
        set_message_concepts(driver, msg["id"], cards, "done")
    except Exception as exc:
        log.warning("Answer concepts failed for %s: %s", msg["id"], exc)
        set_message_concepts(driver, msg["id"], None, "failed", str(exc)[:500])
    finally:
        with _concept_lock:
            _concept_jobs.discard(msg["id"])


@router.post("/messages/{msg_id}/visualise", response_model=ConceptsState)
def visualise_answer_route(msg_id: str):
    """Detect concepts in an answer and generate their cards in the background."""
    msg = _answer_or_404(msg_id)
    with _concept_lock:
        if msg_id in _concept_jobs:
            return _state(msg)
        _concept_jobs.add(msg_id)
    set_message_concepts(get_driver(), msg_id, None, "running")
    # The request user (a contextvar) decides whether Claude Code may be used.
    ctx = contextvars.copy_context()
    threading.Thread(target=ctx.run, args=(_run_concepts, msg), daemon=True).start()
    return {"status": "running", "error": None, "concepts": msg.get("concepts")}


@router.get("/messages/{msg_id}/concepts", response_model=ConceptsState)
def get_answer_concepts(msg_id: str):
    return _state(_answer_or_404(msg_id))


class RepairBody(BaseModel):
    error: str


@router.post("/messages/{msg_id}/concepts/{index}/repair", response_model=ConceptsState)
def repair_answer_concept(msg_id: str, index: int, body: RepairBody):
    """Regenerate one card whose animation or graph failed in the browser."""
    from services.chat_concepts import repair_concept
    from services.concepts import ConceptsError

    msg = _answer_or_404(msg_id)
    cards = list(msg.get("concepts") or [])
    if not 0 <= index < len(cards):
        raise HTTPException(status_code=404, detail="Concept not found")
    try:
        cards[index] = repair_concept(cards[index], body.error[:2000], title=msg.get("question", "")[:200])
    except (ConceptsError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    set_message_concepts(get_driver(), msg_id, cards, "done")
    return {"status": "done", "error": None, "concepts": cards}


# ── 3D structures (```structure blocks) ───────────────────────────────────────

@router.get("/structures")
def get_structure(pdb: str | None = Query(None), afdb: str | None = Query(None)):
    """Coordinates for the 3D viewer: an RCSB entry or an AlphaFold DB model, cached."""
    from services.structures import StructureError, alphafold_model, rcsb_entry

    try:
        if pdb:
            return rcsb_entry(pdb)
        if afdb:
            return alphafold_model(afdb)
    except StructureError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # network trouble
        log.warning("Structure fetch failed (%s / %s): %s", pdb, afdb, exc)
        raise HTTPException(status_code=502, detail="Could not fetch the structure.")
    raise HTTPException(status_code=422, detail="Give ?pdb=<PDB id> or ?afdb=<UniProt accession>")
