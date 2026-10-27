"""Neo4j queries for Conversation and Message nodes."""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone
from neo4j import Driver


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def estimate_tokens_approx(text: str) -> int:
    return max(1, len(text) // 4)


def create_conversation(driver: Driver, title: str) -> dict:
    now = _now()
    with driver.session() as session:
        result = session.run(
            """
            CREATE (c:Conversation {
                id: $id, title: $title,
                created_at: $now, updated_at: $now,
                compacted: false
            }) RETURN c
            """,
            id=str(uuid.uuid4()), title=title, now=now,
        )
        return dict(result.single()["c"])


def update_conversation_timestamp(driver: Driver, conv_id: str) -> None:
    with driver.session() as session:
        session.run(
            "MATCH (c:Conversation {id: $id}) SET c.updated_at = $now",
            id=conv_id, now=_now(),
        )


def add_message(
    driver: Driver,
    conv_id: str,
    role: str,
    content: str,
    paper_ids: list[str],
    tokens_used: int = 0,
) -> dict:
    now = _now()
    msg_id = str(uuid.uuid4())
    with driver.session() as session:
        # Create message and link to conversation
        result = session.run(
            """
            MATCH (c:Conversation {id: $conv_id})
            CREATE (m:Message {
                id: $msg_id, role: $role, content: $content,
                tokens_used: $tokens, created_at: $now
            })
            CREATE (c)-[:HAS_MESSAGE]->(m)
            RETURN m
            """,
            conv_id=conv_id, msg_id=msg_id, role=role,
            content=content, tokens=tokens_used, now=now,
        )
        msg = dict(result.single()["m"])

        # Link to referenced papers
        for pid in paper_ids:
            session.run(
                """
                MATCH (m:Message {id: $mid}), (p:Paper {id: $pid})
                MERGE (m)-[:REFERENCES]->(p)
                """,
                mid=msg_id, pid=pid,
            )

    update_conversation_timestamp(driver, conv_id)
    msg["paper_refs"] = paper_ids
    return msg


def list_conversations(driver: Driver) -> list[dict]:
    """Knowledge Chat conversations, newest first; per-paper chats are listed on their paper."""
    with driver.session() as session:
        result = session.run(
            """
            MATCH (c:Conversation)
            WHERE coalesce(properties(c).type, '') <> 'paper'
            OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:Message)
            RETURN c, count(m) AS message_count
            ORDER BY c.updated_at DESC
            """
        )
        rows = []
        for r in result:
            d = dict(r["c"])
            d["message_count"] = r["message_count"]
            rows.append(d)
        return rows


def _message_row(m: dict, papers: list[dict] | None = None) -> dict:
    """A Message node as the API returns it: concept specs parsed, cited papers attached."""
    d = dict(m)
    raw = d.pop("concepts_json", None)
    try:
        d["concepts"] = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        d["concepts"] = None
    papers = [p for p in (papers or []) if p and p.get("id")]
    d["paper_refs"] = [p["id"] for p in papers]
    d["papers"] = papers
    return d


def get_messages(driver: Driver, conv_id: str) -> list[dict]:
    with driver.session() as session:
        result = session.run(
            """
            MATCH (c:Conversation {id: $id})-[:HAS_MESSAGE]->(m:Message)
            OPTIONAL MATCH (m)-[:REFERENCES]->(p:Paper)
            WITH m, collect({id: p.id, title: p.title, year: p.year}) AS papers
            ORDER BY m.created_at ASC
            RETURN m, papers
            """,
            id=conv_id,
        )
        return [_message_row(dict(r["m"]), r["papers"]) for r in result]


def get_message(driver: Driver, msg_id: str) -> dict | None:
    """One message with the id of its conversation and the question it answers."""
    with driver.session() as session:
        row = session.run(
            """
            MATCH (c:Conversation)-[:HAS_MESSAGE]->(m:Message {id: $id})
            OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(q:Message {role: 'user'})
            WHERE q.created_at < m.created_at
            WITH c, m, q ORDER BY q.created_at DESC
            WITH c, m, collect(q.content)[0] AS question
            RETURN m, c.id AS conversation_id, question
            """,
            id=msg_id,
        ).single()
    if not row:
        return None
    d = _message_row(dict(row["m"]))
    d["conversation_id"] = row["conversation_id"]
    d["question"] = row["question"] or ""
    return d


def set_message_concepts(
    driver: Driver,
    msg_id: str,
    concepts: list[dict] | None,
    status: str,
    error: str | None = None,
) -> None:
    """Store an answer's concept cards (JSON) and the state of their generation.

    ``concepts=None`` leaves the stored cards alone (e.g. while a job starts).
    """
    with driver.session() as session:
        session.run(
            """
            MATCH (m:Message {id: $id})
            SET m.concepts_status = $status, m.concepts_error = $error
            WITH m
            WHERE $json IS NOT NULL
            SET m.concepts_json = $json
            """,
            id=msg_id, status=status, error=error,
            json=json.dumps(concepts) if concepts is not None else None,
        )


def set_message_error(driver: Driver, msg_id: str, error: str) -> None:
    """Mark a question whose answer failed, so a page that lost the stream can tell."""
    with driver.session() as session:
        session.run("MATCH (m:Message {id: $id}) SET m.answer_error = $error", id=msg_id, error=error)


def fork_conversation(driver: Driver, conv_id: str, keep: int, kind: str = "strand") -> dict:
    """Copy a conversation up to and including the answer to question *keep* (1-based).

    The copy records ``parent_id`` and ``fork_at`` (questions inherited), so the
    chat list can nest it under its parent and the lane can draw where it left.
    ``keep=0`` forks before the first question. The original is untouched.
    """
    msgs = get_messages(driver, conv_id)
    if msgs is None:
        raise ValueError("Conversation not found")
    kept: list[dict] = []
    questions = 0
    for m in msgs:
        if m["role"] == "user":
            if questions == keep:
                break
            questions += 1
        kept.append(m)
    now = _now()
    new_id = str(uuid.uuid4())
    with driver.session() as session:
        parent = session.run("MATCH (c:Conversation {id: $id}) RETURN c", id=conv_id).single()
        if not parent:
            raise ValueError("Conversation not found")
        parent_c = dict(parent["c"])
        session.run(
            """
            CREATE (c:Conversation {
                id: $id, title: $title, created_at: $now, updated_at: $now,
                compacted: $compacted, parent_id: $parent, fork_at: $at, fork_kind: $kind
            })
            """,
            id=new_id, title=parent_c.get("title") or "Untitled", now=now,
            compacted=bool(parent_c.get("compacted")), parent=conv_id, at=questions, kind=kind,
        )
        for m in kept:
            props = {
                "id": str(uuid.uuid4()), "role": m["role"], "content": m["content"],
                "tokens_used": m.get("tokens_used") or 0, "created_at": m["created_at"],
            }
            if m.get("concepts") is not None:
                props["concepts_json"] = json.dumps(m["concepts"])
                props["concepts_status"] = m.get("concepts_status") or "done"
            session.run(
                """
                MATCH (c:Conversation {id: $conv})
                CREATE (m:Message) SET m = $props
                CREATE (c)-[:HAS_MESSAGE]->(m)
                WITH m
                UNWIND $papers AS pid
                MATCH (p:Paper {id: pid})
                MERGE (m)-[:REFERENCES]->(p)
                """,
                conv=new_id, props=props, papers=m.get("paper_refs") or [],
            )
    return {
        "id": new_id, "title": parent_c.get("title") or "Untitled", "created_at": now, "updated_at": now,
        "compacted": bool(parent_c.get("compacted")), "message_count": len(kept),
        "parent_id": conv_id, "fork_at": questions, "fork_kind": kind, "branch_label": None,
    }


def set_branch_label_if_empty(driver: Driver, conv_id: str, label: str) -> None:
    """Name a fork after the first question asked in it."""
    with driver.session() as session:
        session.run(
            """
            MATCH (c:Conversation {id: $id})
            WHERE properties(c).parent_id IS NOT NULL AND properties(c).branch_label IS NULL
            SET c.branch_label = $label
            """,
            id=conv_id, label=label,
        )


def compact_conversation(driver: Driver, conv_id: str, summary_content: str) -> dict:
    """Replace all messages with a single system summary message (legacy path)."""
    now = _now()
    msg_id = str(uuid.uuid4())
    with driver.session() as session:
        session.run(
            "MATCH (c:Conversation {id: $id})-[:HAS_MESSAGE]->(m:Message) DETACH DELETE m",
            id=conv_id,
        )
        result = session.run(
            """
            MATCH (c:Conversation {id: $conv_id})
            CREATE (m:Message {
                id: $msg_id, role: 'system',
                content: $content, tokens_used: $tokens,
                created_at: $now
            })
            CREATE (c)-[:HAS_MESSAGE]->(m)
            SET c.compacted = true, c.updated_at = $now
            RETURN m
            """,
            conv_id=conv_id, msg_id=msg_id,
            content=summary_content,
            tokens=len(summary_content) // 4,
            now=now,
        )
        msg = dict(result.single()["m"])
        msg["paper_refs"] = []
        return msg


def compact_conversation_sliding_window(
    driver: Driver,
    conv_id: str,
    working_memory_json: str,
    prose_summary: str,
    keep_last_n: int = 6,
) -> dict:
    """Sliding-window compaction: keep the last *keep_last_n* messages verbatim and
    replace all older messages with a single system message containing a structured
    JSON working memory block followed by a prose summary.

    This preserves specific paper titles, numbers, and claims discussed earlier in
    the conversation, which a pure prose summarisation would elide.
    """
    now = _now()
    all_msgs = get_messages(driver, conv_id)
    if not all_msgs:
        return {}

    # Messages to delete: everything except the last keep_last_n
    to_delete = all_msgs[:-keep_last_n] if len(all_msgs) > keep_last_n else []

    system_content = (
        f"## Working memory (structured)\n\n```json\n{working_memory_json}\n```\n\n"
        f"## Summary of earlier conversation\n\n{prose_summary}"
    )
    system_id = str(uuid.uuid4())

    with driver.session() as session:
        # Delete old messages
        for msg in to_delete:
            session.run(
                "MATCH (m:Message {id: $id}) DETACH DELETE m",
                id=msg["id"],
            )
        # Insert the system compaction message at the head of the conversation
        session.run(
            """
            MATCH (c:Conversation {id: $conv_id})
            CREATE (m:Message {
                id: $msg_id, role: 'system',
                content: $content, tokens_used: $tokens,
                created_at: $now
            })
            CREATE (c)-[:HAS_MESSAGE]->(m)
            SET c.compacted = true, c.updated_at = $now
            """,
            conv_id=conv_id, msg_id=system_id,
            content=system_content,
            tokens=len(system_content) // 4,
            now=now,
        )

    # Return the new system message
    result_msg = {
        "id": system_id, "role": "system",
        "content": system_content, "paper_refs": [],
    }
    return result_msg


def delete_conversation(driver: Driver, conv_id: str) -> None:
    with driver.session() as session:
        session.run(
            """
            MATCH (c:Conversation {id: $id})
            OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:Message)
            DETACH DELETE c, m
            """,
            id=conv_id,
        )


def rename_conversation(driver: Driver, conv_id: str, title: str) -> dict:
    with driver.session() as session:
        result = session.run(
            "MATCH (c:Conversation {id: $id}) SET c.title = $title RETURN c",
            id=conv_id, title=title,
        )
        row = result.single()
        return dict(row["c"]) if row else {}


# ── Per-paper conversations ────────────────────────────────────────────────────

def create_paper_conversation(driver: Driver, paper_id: str, title: str) -> dict:
    now = _now()
    with driver.session() as session:
        result = session.run(
            """
            MATCH (p:Paper {id: $paper_id})
            CREATE (c:Conversation {
                id: $id, title: $title, type: 'paper',
                created_at: $now, updated_at: $now,
                compacted: false
            })
            CREATE (c)-[:ABOUT_PAPER]->(p)
            RETURN c
            """,
            id=str(uuid.uuid4()), paper_id=paper_id, title=title, now=now,
        )
        row = result.single()
        if not row:
            raise ValueError(f"Paper {paper_id} not found")
        return dict(row["c"])


def list_paper_conversations(driver: Driver, paper_id: str) -> list[dict]:
    with driver.session() as session:
        result = session.run(
            """
            MATCH (c:Conversation)-[:ABOUT_PAPER]->(p:Paper {id: $paper_id})
            OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:Message)
            OPTIONAL MATCH (u:User)-[:STARTED]->(c)
            RETURN c, count(m) AS message_count, u.name AS started_by
            ORDER BY c.updated_at DESC
            """,
            paper_id=paper_id,
        )
        rows = []
        for r in result:
            d = dict(r["c"])
            d["message_count"] = r["message_count"]
            d["started_by"] = r["started_by"]
            rows.append(d)
        return rows


def get_paper_context_snippets(driver: Driver, paper_id: str) -> dict:
    """Return note content + compacted conversation summaries for a paper (for knowledge chat context)."""
    with driver.session() as session:
        # Note
        note_result = session.run(
            "MATCH (p:Paper {id: $id})-[:HAS_NOTE]->(n:Note) RETURN n.content AS content",
            id=paper_id,
        ).single()
        note = note_result["content"] if note_result else None

        # Conversation summaries (compacted ones) or recent messages
        conv_result = session.run(
            """
            MATCH (c:Conversation)-[:ABOUT_PAPER]->(p:Paper {id: $id})
            OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:Message)
            WITH c, m ORDER BY m.created_at ASC
            WITH c, collect(m) AS messages
            RETURN c.title AS title, c.compacted AS compacted,
                   [msg IN messages | {role: msg.role, content: msg.content}] AS messages
            ORDER BY c.updated_at DESC
            LIMIT 5
            """,
            id=paper_id,
        )
        conversations = [dict(r) for r in conv_result]

    return {"note": note, "conversations": conversations}
