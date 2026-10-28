"""Quick tour of a paper: an overview plus 6–12 stops, each a verbatim passage on a
PDF page with a short explanation, so a reader can jump through the paper.

Sonnet via Claude Code on the owner's subscription only (no API fallback): the
tour reads the whole PDF, which is exactly what the subscription is for. Input is
the stored summary, the paper's concepts from the project concept map, and the
page texts from pypdf; the anchors are checked against those page texts.
"""
from __future__ import annotations

import logging
from typing import Any

from services.ai import _load_prompt
from services.claude_code_chat import claude_code_available, run_structured_claude_code
from services.concepts import normalise

log = logging.getLogger(__name__)

TOUR_MODEL = "opus"
TOUR_EFFORT = "medium"
MAX_PAGES = 60
MAX_PAGE_CHARS = 5000
MAX_STOPS = 14
KINDS = ("problem", "background", "definition", "method", "equation", "result", "figure", "limitation", "takeaway")

TOUR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["overview", "skip", "stops"],
    "properties": {
        "overview": {"type": "string"},
        "skip": {"type": "string"},
        "stops": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["page", "title", "kind", "anchor", "explanation", "concepts"],
                "properties": {
                    "page": {"type": "integer"},
                    "title": {"type": "string"},
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "anchor": {"type": "string"},
                    "explanation": {"type": "string"},
                    "concepts": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}

SUBSCRIPTION_HINT = (
    "The quick tour runs on the Claude subscription, which is not set up on the server: run "
    "`claude setup-token`, put CLAUDE_CODE_OAUTH_TOKEN=<token> in PaperManager's .env and restart the backend."
)


class TourError(RuntimeError):
    pass


def tour_available() -> bool:
    return claude_code_available()


def _find_page(anchor: str, pages: list[str], hint: int) -> int | None:
    """Page whose text contains the anchor (or its head / tail), preferring the model's page."""
    needle = normalise(anchor).lower()
    if len(needle) < 12:
        return None
    probes = [needle, needle[:60], needle[-60:], needle[:30], needle[-30:]]
    order = [hint] + [i for i in range(len(pages)) if i != hint] if 0 <= hint < len(pages) else range(len(pages))
    for probe in probes:
        if len(probe) < 20 and probe != needle:
            continue
        for i in order:
            if probe in pages[i].lower():
                return i
    return None


def clean_tour(raw: dict[str, Any], pages: list[str]) -> dict[str, Any]:
    stops = []
    for s in (raw.get("stops") or [])[:MAX_STOPS]:
        anchor = normalise(str(s.get("anchor") or ""))[:400]
        hint = s.get("page") if isinstance(s.get("page"), int) else -1
        page = _find_page(anchor, pages, hint)
        stops.append({
            "page": page if page is not None else max(0, min(hint, len(pages) - 1)),
            "anchor_found": page is not None,
            "title": str(s.get("title") or "").strip()[:120],
            "kind": s.get("kind") if s.get("kind") in KINDS else "result",
            "anchor": anchor,
            "explanation": str(s.get("explanation") or "").strip()[:1200],
            "concepts": [str(c)[:120] for c in (s.get("concepts") or [])][:6],
        })
    if not stops:
        raise TourError("the model returned no stops")
    return {
        "overview": str(raw.get("overview") or "").strip()[:2000],
        "skip": str(raw.get("skip") or "").strip()[:600],
        "stops": stops,
    }


def build_tour(paper: dict, concepts: list[dict], pages: list[str]) -> dict[str, Any]:
    """Generate the tour; raise TourError on any failure."""
    if not tour_available():
        raise TourError(SUBSCRIPTION_HINT)
    used = pages[:MAX_PAGES]
    page_block = "\n\n".join(f"[page {i}]\n{t[:MAX_PAGE_CHARS]}" for i, t in enumerate(used) if t)
    if not page_block:
        raise TourError("the PDF has no extractable text")
    concept_block = "\n".join(
        f"- {c['name']} ({c.get('role') or 'uses'}): {c.get('in_paper') or c.get('definition') or ''}"
        for c in concepts
    ) or "(none extracted yet)"
    prompt = _load_prompt("paper_tour.txt").format(
        title=paper.get("title") or "(untitled)",
        summary=(paper.get("summary") or paper.get("abstract") or "(no summary)")[:8000],
        concepts=concept_block,
        pages=page_block,
    )
    system = "You write precise, concrete reading guides for research papers. Answer only with the requested JSON."
    try:
        raw = run_structured_claude_code(system, prompt, TOUR_SCHEMA, model=TOUR_MODEL, effort=TOUR_EFFORT)
    except Exception as exc:  # noqa: BLE001
        raise TourError(f"Claude Code failed: {exc}") from exc
    if not isinstance(raw, dict):
        raise TourError("Claude Code returned no structured output")
    return clean_tour(raw, used)
