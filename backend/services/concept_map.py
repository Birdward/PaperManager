"""Project concept map: the key concepts of every paper and how they relate.

Gemma (via LiteLLM) reads each paper's summary, abstract and claims and returns its
concepts plus typed relations between them. Concepts are shared across papers: a
name is reduced to a key (lower case, alphanumerics only, crude singular), and a
new concept whose name or alias key matches an existing concept's key or alias
joins that concept instead of creating a new one. The model also sees the names
already in the project's map, so it reuses them rather than inventing variants.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from services.ai import _load_prompt
from services.litellm_client import chat_completion, litellm_configured

# Paper text per extraction: more for Claude (Opus, 1M window) than for a LiteLLM model.
_TEXT_CHARS = 12000 if litellm_configured() else 120_000

log = logging.getLogger(__name__)

KINDS = ("method", "model", "task", "dataset", "metric", "theory", "phenomenon", "tool", "domain")
ROLES = ("introduces", "extends", "uses", "evaluates", "critiques", "background")
RELATIONS = (
    "is_a", "part_of", "uses", "extends", "improves_on", "alternative_to",
    "evaluated_on", "causes", "addresses", "related_to",
)
MAX_CONCEPTS = 18
MAX_RELATIONS = 25
VOCABULARY_SIZE = 250
# A healthy call returns in ~10 s; the proxy sometimes drops a request and it then
# hangs until the timeout. Fail fast and resend rather than wait out a lost request;
# the retries also cover the minute a cold start can take.
CALL_TIMEOUT_S = 75
CALL_RETRIES = 4
JSON_ATTEMPTS = 3


class ConceptMapError(RuntimeError):
    pass


def concept_key(name: str) -> str:
    """Matching key for a concept name: 'Diffusion Models' and 'diffusion-model' agree."""
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    if words and len(words[-1]) > 4 and words[-1].endswith("s") and not words[-1].endswith("ss"):
        words[-1] = words[-1][:-1]
    return "".join(words)


def _context(paper: dict, claims: list[str]) -> str:
    parts = []
    if paper.get("abstract"):
        parts.append(f"Abstract:\n{paper['abstract'][:3000]}")
    if paper.get("summary"):
        parts.append(f"Summary:\n{paper['summary'][:6000]}")
    if claims:
        parts.append("Claims:\n" + "\n".join(f"- {c}" for c in claims[:30]))
    if not parts and paper.get("raw_text"):
        parts.append(f"Text (beginning):\n{paper['raw_text'][:_TEXT_CHARS]}")
    return "\n\n".join(parts)


def _parse_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ConceptMapError("model returned no JSON object")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ConceptMapError(f"model returned invalid JSON: {exc}") from exc


def _pick(value: Any, allowed: tuple[str, ...], default: str) -> str:
    v = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return v if v in allowed else default


def clean_extraction(raw: dict[str, Any]) -> dict[str, list[dict]]:
    """Validate the model output: known kinds/roles/relations, relations between listed concepts."""
    concepts: list[dict] = []
    seen: dict[str, str] = {}  # key of name or alias -> canonical key in this paper
    for c in (raw.get("concepts") or [])[:MAX_CONCEPTS]:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()[:120]
        key = concept_key(name)
        if not key or key in seen:
            continue
        # Aliases merge concepts across papers, so keep only single-token ones
        # (FEP, CFG, AF3): the model also lists broader phrases ("generative
        # model" for a diffusion model) that would merge distinct concepts.
        raw_aliases = c.get("abbreviations", c.get("aliases")) or []
        if isinstance(raw_aliases, str):
            raw_aliases = raw_aliases.split(",")
        aliases = [
            str(a).strip()[:80] for a in raw_aliases
            if isinstance(a, str) and a.strip() and len(a.split()) == 1
        ]
        alias_keys = sorted({concept_key(a) for a in aliases} - {key, ""})
        concepts.append({
            "name": name,
            "key": key,
            "aliases": aliases[:8],
            "alias_keys": alias_keys[:8],
            "kind": _pick(c.get("kind"), KINDS, "method"),
            "definition": str(c.get("definition") or "").strip()[:600],
            "in_paper": str(c.get("in_paper") or "").strip()[:600],
            "role": _pick(c.get("role"), ROLES, "uses"),
        })
        seen[key] = key
        for ak in alias_keys:
            seen.setdefault(ak, key)

    relations: list[dict] = []
    done: set[tuple[str, str, str]] = set()
    for r in raw.get("relations") or []:
        if not isinstance(r, dict) or len(relations) >= MAX_RELATIONS:
            continue
        src = seen.get(concept_key(str(r.get("source") or "")))
        tgt = seen.get(concept_key(str(r.get("target") or "")))
        rtype = _pick(r.get("type"), RELATIONS, "related_to")
        if not src or not tgt or src == tgt or (src, tgt, rtype) in done:
            continue
        done.add((src, tgt, rtype))
        relations.append({
            "source": src, "target": tgt, "type": rtype,
            "evidence": str(r.get("evidence") or "").strip()[:300],
        })
    return {"concepts": concepts, "relations": relations}


def extract_paper_concepts(paper: dict, authors: list[str], claims: list[str], vocabulary: list[str]) -> dict:
    """Ask Gemma for one paper's concepts and relations; raise ConceptMapError on failure."""
    context = _context(paper, claims)
    if not context:
        raise ConceptMapError("paper has no abstract, summary, claims or text")
    vocab = ", ".join(vocabulary[:VOCABULARY_SIZE]) or "(empty: this is the first paper)"
    prompt = _load_prompt("concept_map.txt").format(
        vocabulary=vocab,
        title=paper.get("title") or "(untitled)",
        year=paper.get("year") or "n.d.",
        authors=", ".join(authors[:12]) or "unknown",
        context=context,
    )
    # Gemma occasionally garbles a key mid-object; a fresh sample is usually fine.
    error: ConceptMapError | None = None
    for _ in range(JSON_ATTEMPTS):
        try:
            text = chat_completion(
                messages=[{"role": "user", "content": prompt}],
                json_mode=True,
                max_tokens=4096,
                timeout=CALL_TIMEOUT_S,
                max_retries=CALL_RETRIES,
                claude_model="opus",
            )
        except Exception as exc:  # noqa: BLE001 — surfaced per paper in the job status
            raise ConceptMapError(f"LLM call failed: {type(exc).__name__}: {exc}") from exc
        try:
            result = clean_extraction(_parse_json(text))
        except ConceptMapError as exc:
            error = exc
            continue
        if result["concepts"]:
            return result
        error = ConceptMapError("model returned no concepts")
    raise error
