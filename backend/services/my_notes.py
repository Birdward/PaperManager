"""The reader's own notes and PDF highlights, formatted for the chats.

A highlight's colour carries a meaning, shown as the key above the PDF (PaperDetail.tsx).
COLOR_MEANINGS is the server-side copy, used by the chats and the Markdown export.

Notes and highlights vary a lot in length, so everything here works to a character budget:
long items are cut, and the text says what was left out and how to narrow the request.
"""
from __future__ import annotations

from typing import Any

from neo4j import Driver

COLOR_MEANINGS = {
    "yellow": "Key insight",
    "green": "Evidence",
    "blue": "Context",
    "red": "Question",
    "purple": "Follow-up",
}
COLOR_KEY = ", ".join(f"{c} = {m}" for c, m in COLOR_MEANINGS.items())

_HIGHLIGHT_CHARS = 600   # per highlighted passage
_COMMENT_CHARS = 1500    # per comment written on a highlight
_NOTE_CHARS = 8000       # per paper note


def color_meaning(color: str | None) -> str:
    color = (color or "yellow").lower()
    return COLOR_MEANINGS.get(color, color.capitalize())


def _cut(text: str | None, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + f" […{len(text) - limit} more characters]"


def format_highlight(a: dict[str, Any]) -> str:
    color = (a.get("color") or "yellow").lower()
    # The viewer stores pageIndex (0-based); show the PDF page.
    page = a["page_number"] + 1 if isinstance(a.get("page_number"), int) else "?"
    line = f'- p.{page} [{color_meaning(color)} ({color})]: "{_cut(a.get("highlighted_text"), _HIGHLIGHT_CHARS)}"'
    if (a.get("note") or "").strip():
        line += f"\n  My comment: {_cut(a['note'], _COMMENT_CHARS)}"
    return line


def read_my_notes(
    driver: Driver,
    *,
    paper_id: str | None = None,
    colors: list[str] | None = None,
    query: str | None = None,
    include_notes: bool = True,
    max_chars: int = 24_000,
) -> tuple[str, int]:
    """Notes and highlights matching the filters, grouped by paper, as text of at most about
    *max_chars*. Returns (text, number of items found). Without *paper_id* it searches the library.
    """
    colors = [c.lower() for c in colors] if colors else None
    q = (query or "").strip().lower() or None
    params = {"pid": paper_id or None, "colors": colors, "q": q}
    with driver.session() as session:
        highlights = [r.data() for r in session.run(
            """
            MATCH (p:Paper)-[:HAS_ANNOTATION]->(a:Annotation)
            WHERE ($pid IS NULL OR p.id = $pid)
              AND ($colors IS NULL OR toLower(coalesce(a.color, 'yellow')) IN $colors)
              AND ($q IS NULL OR toLower(coalesce(a.highlighted_text, '') + ' ' + coalesce(a.note, '')) CONTAINS $q)
            RETURN p.id AS paper_id, p.title AS title, a.page_number AS page_number, a.color AS color,
                   a.highlighted_text AS highlighted_text, a.note AS note
            ORDER BY title, page_number, a.created_at
            """, params)]
        notes = [r.data() for r in session.run(
            """
            MATCH (p:Paper)-[:HAS_NOTE]->(n:Note)
            WHERE ($pid IS NULL OR p.id = $pid) AND trim(coalesce(n.content, '')) <> ''
              AND ($q IS NULL OR toLower(n.content) CONTAINS $q)
            RETURN p.id AS paper_id, p.title AS title, n.content AS content
            ORDER BY title
            """, params)] if include_notes else []

    papers: dict[str, dict[str, Any]] = {}
    for n in notes:
        papers.setdefault(n["paper_id"], {"title": n["title"], "note": None, "highlights": []})["note"] = n["content"]
    for h in highlights:
        papers.setdefault(h["paper_id"], {"title": h["title"], "note": None, "highlights": []})["highlights"].append(h)

    found = len(notes) + len(highlights)
    if not found:
        return "[No notes or highlights match.]", 0

    out: list[str] = [f"Highlight colour key: {COLOR_KEY}."]
    used = len(out[0])
    shown = 0

    def add(text: str) -> bool:
        """Append *text* unless it would exceed the budget (the first item always fits)."""
        nonlocal used
        if used + len(text) > max_chars and shown:
            return False
        out.append(text)
        used += len(text) + 1
        return True

    full = True
    for pid, p in papers.items():
        if not add(f"\n## {p['title']} (id: {pid})"):
            break
        if p["note"]:
            if not add(f"My note:\n{_cut(p['note'], _NOTE_CHARS)}"):
                break
            shown += 1
        if p["highlights"] and not add("My highlights:"):
            break
        for h in p["highlights"]:
            if not (full := add(format_highlight(h))):
                break
            shown += 1
        if not full:
            break
    if shown < found:
        out.append(f"\n[{found - shown} more items not shown. Narrow the request with paper_id, colors or query.]")
    return "\n".join(out), found


def paper_notes_block(driver: Driver, paper_id: str, max_chars: int = 24_000) -> str:
    """The reader's note and highlights on one paper, for the paper chat's system prompt."""
    text, found = read_my_notes(driver, paper_id=paper_id, max_chars=max_chars)
    if not found:
        return ""
    return (
        "## The reader's own notes and highlights on this paper\n"
        "Use them when they are relevant: when asked about their notes, highlights, comments or "
        "questions (red highlights are questions to answer), when the question is about a "
        "highlighted passage, or to tailor the answer to what they found important. Do not recite "
        "them unprompted.\n\n" + text
    )


def highlight_counts(driver: Driver, paper_ids: list[str]) -> dict[str, str]:
    """Per paper, a short summary of its highlights by meaning, e.g. "2 Question, 1 Context"."""
    if not paper_ids:
        return {}
    with driver.session() as session:
        rows = session.run(
            """
            MATCH (p:Paper)-[:HAS_ANNOTATION]->(a:Annotation) WHERE p.id IN $ids
            RETURN p.id AS id, toLower(coalesce(a.color, 'yellow')) AS color, count(a) AS n
            """, ids=paper_ids)
        counts: dict[str, list[str]] = {}
        for r in rows:
            counts.setdefault(r["id"], []).append(f"{r['n']} {color_meaning(r['color'])}")
    return {pid: ", ".join(sorted(parts)) for pid, parts in counts.items()}
