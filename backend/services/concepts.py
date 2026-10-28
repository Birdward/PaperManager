"""Interactive concepts: find the ideas on each PDF page that a picture would
explain, and generate a visualisation spec for one on demand.

Ported from Get It. (github.com/beltromatti/get-it, Apache-2.0): the batched
detection agent, the per-type visualisation prompts and their JSON shapes.
Changes from the original: prompts aimed at research papers rather than school
textbooks; no "3d" type; "graph" carries data points instead of a JavaScript
expression, so the only model-written code left is the "2d-anim" body, which
the frontend runs in a sandboxed iframe.

Model routing: Claude Code on the owner's subscription (Sonnet) when the user
may use it, otherwise the personal API key with ``CONCEPTS_API_MODEL``.
"""
from __future__ import annotations

import contextvars
import io
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from services.ai import _load_prompt, _personal_client
from services.claude_code_chat import claude_code_available, run_structured_claude_code

log = logging.getLogger(__name__)

VIZ_TYPES = ("formula", "graph", "2d-text", "2d-anim")
CHART_TYPES = ("lines", "points", "bars")

CONCEPTS_CLAUDE_CODE_MODEL = "opus"
CONCEPTS_API_MODEL = "claude-sonnet-5-5"

PAGES_PER_BATCH = 5
DETECT_CONCURRENCY = 3
MAX_PAGES = 80
MAX_PAGE_CHARS = 6000
MAX_CONCEPTS_PER_PAGE = 3

# Effort per call: detection is skimming, specs need correct maths, animation
# code has to run first time.
EFFORT_DETECT = "low"
EFFORT_SPEC = "medium"
EFFORT_CODE = "high"


class ConceptsError(RuntimeError):
    """A model call failed or returned something unusable."""


# ── Schemas ──────────────────────────────────────────────────────────────────
# Structured outputs reject length and numeric constraints, so the schemas only
# fix shape and enums; sizes are enforced in ``_clean_*`` below.

DETECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["concepts"],
    "properties": {
        "concepts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["page", "label", "type", "anchor", "context"],
                "properties": {
                    "page": {"type": "integer"},
                    "label": {"type": "string"},
                    "type": {"type": "string", "enum": list(VIZ_TYPES)},
                    "anchor": {"type": "string"},
                    "context": {"type": "string"},
                },
            },
        },
    },
}

_TITLE_CAPTION = {"title": {"type": "string"}, "caption": {"type": "string"}}

SPEC_SCHEMAS: dict[str, dict[str, Any]] = {
    "formula": {
        "type": "object",
        "additionalProperties": False,
        "required": ["type", "title", "caption", "main_latex", "steps"],
        "properties": {
            "type": {"type": "string", "const": "formula"},
            **_TITLE_CAPTION,
            "main_latex": {"type": "string"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["latex", "explanation"],
                    "properties": {"latex": {"type": "string"}, "explanation": {"type": "string"}},
                },
            },
        },
    },
    "graph": {
        "type": "object",
        "additionalProperties": False,
        "required": ["type", "title", "caption", "chart_type", "x_label", "y_label", "data_json"],
        "properties": {
            "type": {"type": "string", "const": "graph"},
            **_TITLE_CAPTION,
            "chart_type": {"type": "string", "enum": list(CHART_TYPES)},
            "x_label": {"type": "string"},
            "y_label": {"type": "string"},
            "data_json": {"type": "string"},
        },
    },
    "2d-text": {
        "type": "object",
        "additionalProperties": False,
        "required": ["type", "title", "caption", "body_markdown", "citations"],
        "properties": {
            "type": {"type": "string", "const": "2d-text"},
            **_TITLE_CAPTION,
            "body_markdown": {"type": "string"},
            "citations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["label", "source", "url"],
                    "properties": {
                        "label": {"type": "string"},
                        "source": {"type": "string"},
                        "url": {"type": "string"},
                    },
                },
            },
        },
    },
    "2d-anim": {
        "type": "object",
        "additionalProperties": False,
        "required": ["type", "title", "caption", "setup_code"],
        "properties": {
            "type": {"type": "string", "const": "2d-anim"},
            **_TITLE_CAPTION,
            "setup_code": {"type": "string"},
        },
    },
}


# ── Model routing ────────────────────────────────────────────────────────────

def concepts_backend() -> str:
    """'claude-code' when the subscription path is open to this user, else 'api'."""
    return "claude-code" if claude_code_available() else "api"


def _run_json(system: str, prompt: str, schema: dict[str, Any], effort: str) -> dict[str, Any]:
    if concepts_backend() == "claude-code":
        try:
            return run_structured_claude_code(
                system, prompt, schema, model=CONCEPTS_CLAUDE_CODE_MODEL, effort=effort
            )
        except Exception as exc:
            raise ConceptsError(str(exc)) from exc
    return _run_json_api(system, prompt, schema, effort)


def _run_json_api(system: str, prompt: str, schema: dict[str, Any], effort: str) -> dict[str, Any]:
    try:
        client = _personal_client()
    except ValueError as exc:
        raise ConceptsError(str(exc)) from exc
    with client.beta.messages.stream(
        model=CONCEPTS_API_MODEL,
        max_tokens=64000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal":
        raise ConceptsError("The model declined this request.")
    if response.stop_reason == "max_tokens":
        raise ConceptsError("The model ran out of output tokens.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConceptsError(f"Model returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ConceptsError("Model returned JSON that is not an object.")
    return data


# ── Page text ────────────────────────────────────────────────────────────────

def page_texts_from_pdf(pdf_bytes: bytes) -> list[str]:
    """Text of every page, in order, with whitespace collapsed."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    return [normalise(page.extract_text() or "") for page in reader.pages]


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def batch_pages(pages: list[str], size: int = PAGES_PER_BATCH) -> list[list[tuple[int, str]]]:
    """Group non-empty pages into batches of ``(page_index, text)``."""
    indexed = [(i, t) for i, t in enumerate(pages[:MAX_PAGES]) if t]
    return [indexed[i:i + size] for i in range(0, len(indexed), size)]


# ── Detection ────────────────────────────────────────────────────────────────

def _clean_concept(raw: dict[str, Any], pages: dict[int, str]) -> dict[str, Any] | None:
    page = raw.get("page")
    if not isinstance(page, int) or page not in pages:
        return None
    vtype = raw.get("type")
    label = normalise(str(raw.get("label") or ""))[:60]
    context = normalise(str(raw.get("context") or ""))[:800]
    anchor = normalise(str(raw.get("anchor") or ""))[:200]
    if vtype not in VIZ_TYPES or len(label) < 2 or len(context) < 10:
        return None
    return {
        "page": page,
        "label": label,
        "type": vtype,
        "anchor": anchor,
        "anchor_found": bool(anchor) and anchor.lower() in pages[page].lower(),
        "context": context,
    }


def _detect_batch(batch: list[tuple[int, str]], title: str) -> list[dict[str, Any]]:
    body = "\n\n".join(f"===== PAGE_INDEX {i} =====\n{t[:MAX_PAGE_CHARS]}" for i, t in batch)
    prompt = f"PAPER: {title or '(untitled)'}\n\n--- PAGES ---\n{body}\n--- END PAGES ---"
    data = _run_json(_load_prompt("concept_detect.txt"), prompt, DETECTION_SCHEMA, EFFORT_DETECT)
    pages = dict(batch)
    kept: list[dict[str, Any]] = []
    per_page: dict[int, int] = {}
    seen: set[tuple[int, str]] = set()
    for raw in data.get("concepts") or []:
        concept = _clean_concept(raw, pages) if isinstance(raw, dict) else None
        if not concept:
            continue
        key = (concept["page"], concept["label"].lower())
        if key in seen or per_page.get(concept["page"], 0) >= MAX_CONCEPTS_PER_PAGE:
            continue
        seen.add(key)
        per_page[concept["page"]] = per_page.get(concept["page"], 0) + 1
        kept.append(concept)
    return kept


def detect_concepts(pages: list[str], title: str = "") -> list[dict[str, Any]]:
    """Detect concepts across the first ``MAX_PAGES`` pages, sorted by page.

    Batches run concurrently. A failed batch is logged and skipped as long as
    another batch succeeded; if every batch fails the first error is raised.
    """
    batches = batch_pages(pages)
    if not batches:
        return []
    results: list[dict[str, Any]] = []
    errors: list[Exception] = []
    with ThreadPoolExecutor(max_workers=DETECT_CONCURRENCY) as pool:
        # Each batch runs in a copy of the caller's context: the request user
        # (a contextvar) decides whether Claude Code may be used.
        futures = [pool.submit(contextvars.copy_context().run, _detect_batch, b, title) for b in batches]
        for future in futures:
            try:
                results.extend(future.result())
            except Exception as exc:  # one bad batch should not lose the rest
                log.warning("Concept detection batch failed: %s", exc)
                errors.append(exc)
    if errors and not results:
        raise ConceptsError(f"Concept detection failed: {errors[0]}")
    return sorted(results, key=lambda c: c["page"])


# ── Visualisation specs ──────────────────────────────────────────────────────

def _clean_graph_data(spec: dict[str, Any]) -> None:
    try:
        data = json.loads(spec.get("data_json") or "")
    except json.JSONDecodeError as exc:
        raise ConceptsError(f"Graph data_json is not valid JSON: {exc}") from exc
    chart = spec.get("chart_type")
    ok = isinstance(data, dict) and (
        (chart == "lines" and isinstance(data.get("series"), list) and data["series"])
        or (chart == "points" and isinstance(data.get("points"), list) and data["points"])
        or (chart == "bars" and isinstance(data.get("bars"), list) and data["bars"])
    )
    if not ok:
        raise ConceptsError(f"Graph data_json does not match chart_type {chart!r}.")


def trim_sentences(text: str, limit: int) -> str:
    """Shorten *text* to at most *limit* characters, ending on a whole sentence when one fits."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end >= limit // 2:
        return cut[:end + 1]
    return cut[:limit - 1].rsplit(" ", 1)[0] + "…"


def clean_spec(vtype: str, spec: dict[str, Any]) -> dict[str, Any]:
    """Check a generated spec against its type and trim oversized fields."""
    if spec.get("type") != vtype:
        raise ConceptsError(f"Expected a {vtype} spec, got {spec.get('type')!r}.")
    spec["title"] = normalise(str(spec.get("title") or ""))[:120]
    spec["caption"] = trim_sentences(normalise(str(spec.get("caption") or "")), 400)
    if vtype == "formula":
        if not str(spec.get("main_latex") or "").strip():
            raise ConceptsError("Formula spec has no main_latex.")
        spec["steps"] = [s for s in spec.get("steps") or [] if isinstance(s, dict)][:8]
    elif vtype == "graph":
        if spec.get("chart_type") not in CHART_TYPES:
            raise ConceptsError(f"Unknown chart_type {spec.get('chart_type')!r}.")
        _clean_graph_data(spec)
    elif vtype == "2d-text":
        if not str(spec.get("body_markdown") or "").strip():
            raise ConceptsError("Text spec has no body.")
        spec["citations"] = [c for c in spec.get("citations") or [] if isinstance(c, dict)][:6]
        for c in spec["citations"]:
            if not str(c.get("url") or "").startswith(("https://", "http://")):
                c["url"] = ""
    elif vtype == "2d-anim":
        code = str(spec.get("setup_code") or "").strip()
        code = re.sub(r"^```(?:js|javascript)?\s*", "", code)
        code = re.sub(r"```\s*$", "", code).strip()
        if len(code) < 30:
            raise ConceptsError("Animation spec has no setup_code.")
        spec["setup_code"] = code
    return spec


def _viz_prompt(concept: dict[str, Any], title: str, previous: dict[str, Any] | None) -> str:
    prompt = (
        f"CONCEPT: {concept['label']}\n"
        f"PAPER: {title or '(untitled)'}\n"
        f"CONTEXT: {concept['context']}\n\n"
        "Reply with the JSON object only."
    )
    if previous:
        code = previous["spec"].get("setup_code")
        prompt += (
            "\n\nTHIS IS A REPAIR ATTEMPT. The previous object you produced was rendered "
            f"and failed with this error:\n\n  {previous['error'][:1000]}\n\n"
            + (f"--- PREVIOUS setup_code ---\n{code}\n--- END ---\n\n" if code else "")
            + "Diagnose the cause and return a corrected object with the same intent."
        )
    return prompt


def generate_spec(
    concept: dict[str, Any],
    title: str = "",
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Visualisation spec for *concept*; *previous* = {"spec", "error"} repairs one."""
    vtype = concept["type"]
    if vtype not in VIZ_TYPES:
        raise ConceptsError(f"Unknown visualisation type {vtype!r}.")
    effort = EFFORT_CODE if vtype == "2d-anim" or previous else EFFORT_SPEC
    system = _load_prompt(f"concept_viz_{vtype.replace('-', '_')}.txt")
    data = _run_json(system, _viz_prompt(concept, title, previous), SPEC_SCHEMAS[vtype], effort)
    return clean_spec(vtype, data)
