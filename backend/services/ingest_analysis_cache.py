"""Disk-backed cache for the heavy LLM analysis done during the upload queue.

When a PDF enters the queue the frontend calls /papers/preanalyze, which runs
metadata + summary + topics + claims + references + tag suggestions ONCE in a
background thread and caches the result on disk (keyed by SHA-256 of the bytes).
When the user finally confirms the upload, /papers/upload reuses the cached
analysis instead of recomputing it, so clicking through the queue is instant.

Mirrors ingest_preprocess_cache.py (single-worker design; RLock; status polling).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

TTL_SECONDS = 24 * 3600
_CACHE_ROOT = Path(os.environ.get("INGEST_ANALYSIS_DIR", "/tmp/papermanager_analysis"))

# Reentrant: ensure_started() holds this lock and then calls _event_for(), which
# re-acquires it. A plain Lock would self-deadlock the calling thread.
_lock = threading.RLock()
_events: dict[str, threading.Event] = {}

# Serialize the heavy LLM work. The library runs against a single-GPU LiteLLM
# proxy, so running every queued file's analysis at once just thrashes the GPU
# and nothing finishes. Limiting concurrency lets the FIRST file complete (and
# turn green) quickly while the rest wait their turn.
_analysis_sem = threading.Semaphore(int(os.environ.get("PREANALYZE_CONCURRENCY", "1")))


def analysis_cache_key(pdf_bytes: bytes) -> str:
    return hashlib.sha256(pdf_bytes).hexdigest()


# Identifies this app process in status files (see _read_status).
_BOOT = uuid.uuid4().hex


def _entry_dir(key: str) -> Path:
    return _CACHE_ROOT / key


def _status_path(key: str) -> Path:
    return _entry_dir(key) / "status.json"


def _result_path(key: str) -> Path:
    return _entry_dir(key) / "result.json"


def _read_status(key: str) -> dict[str, Any] | None:
    path = _status_path(key)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        created = float(data.get("created_at", 0))
        if time.time() - created > TTL_SECONDS:
            return None
        # A job left pending/running by an earlier process (e.g. one killed for running out of
        # memory) will never finish; report it missing so the queue starts it again.
        if data.get("status") in ("pending", "running") and data.get("boot") != _BOOT:
            log.warning("Stale %s job from a previous app run | key=%s", data.get("status"), key[:12])
            return None
        return data
    except Exception:
        return None


def _write_status(key: str, status: str, *, error: str | None = None) -> None:
    entry = _entry_dir(key)
    entry.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "status": status,
        "boot": _BOOT,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    if error:
        payload["error"] = error
    _status_path(key).write_text(json.dumps(payload), encoding="utf-8")


def get_status(key: str) -> dict[str, Any]:
    """Return {status: pending|running|ready|error|missing, ...}."""
    st = _read_status(key)
    if not st:
        return {"analysis_key": key, "status": "missing"}
    return {"analysis_key": key, **st}


def _event_for(key: str) -> threading.Event:
    with _lock:
        if key not in _events:
            _events[key] = threading.Event()
        return _events[key]


def _run_analysis(key: str) -> None:
    """Background worker: compute the full LLM analysis and cache it on disk."""
    pdf_bytes = _pending_bytes.pop(key, None)
    if pdf_bytes is None:
        _write_status(key, "error", error="missing pdf bytes")
        _event_for(key).set()
        return

    from services.pdf_parser import extract_metadata
    from services.ai import summarize_paper, suggest_topics, extract_claims, extract_affiliations_with_litellm
    from services.references import extract_references
    from services.tag_suggester import suggest_tags_litellm
    from db.connection import get_driver
    from db.queries.tags import list_tags

    # Serialize against other queued analyses so the single GPU isn't thrashed
    # by many concurrent full pipelines (which makes them all stall). Files wait
    # here in "pending" until it's their turn, then flip to "running".
    with _analysis_sem:
        try:
            _write_status(key, "running")

            meta = extract_metadata(pdf_bytes)
            raw_text = meta.get("raw_text", "") or ""
            title = meta.get("title", "") or ""
            abstract = meta.get("abstract", "") or ""

            summary = None
            if raw_text:
                try:
                    summary = summarize_paper(raw_text, title, None)
                except Exception as exc:
                    log.warning("Preanalyze summary failed | key=%s | %s", key[:12], exc)

            ai_topics: list[str] = []
            try:
                ai_topics = suggest_topics(title=title, abstract=abstract, summary=summary or "") or []
            except Exception as exc:
                log.warning("Preanalyze topics failed | key=%s | %s", key[:12], exc)

            claims: list[dict] = []
            if raw_text:
                try:
                    claims = extract_claims(raw_text, title, model="litellm") or []
                except Exception as exc:
                    log.warning("Preanalyze claims failed | key=%s | %s", key[:12], exc)

            references: list[dict] = []
            if raw_text:
                try:
                    references = extract_references(raw_text, meta.get("doi")) or []
                except Exception as exc:
                    log.warning("Preanalyze references failed | key=%s | %s", key[:12], exc)

            # Author affiliations for any author the metadata source didn't
            # already resolve — this is a real LLM call, so precompute it here
            # rather than at upload time.
            affiliations: dict[str, str | None] = {}
            authors_detail = meta.get("authors_detail") or []
            aff_map = {d["name"]: d.get("affiliation") for d in authors_detail}
            missing = [n for n in (meta.get("authors") or []) if n and not aff_map.get(n)]
            if missing and raw_text:
                try:
                    affiliations = extract_affiliations_with_litellm(missing, raw_text) or {}
                except Exception as exc:
                    log.warning("Preanalyze affiliations failed | key=%s | %s", key[:12], exc)

            tag_suggestions: dict | None = None
            try:
                existing_tags = [t["name"] for t in list_tags(get_driver())]
                tag_suggestions = suggest_tags_litellm(title, abstract, existing_tags)
            except Exception as exc:
                log.warning("Preanalyze tags failed | key=%s | %s", key[:12], exc)

            result = {
                "meta": meta,
                "summary": summary,
                "ai_topics": ai_topics,
                "claims": claims,
                "references": references,
                "affiliations": affiliations,
                "tag_suggestions": tag_suggestions or {"existing": [], "new": [], "all_tags": []},
            }
            _result_path(key).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            _write_status(key, "ready")
            log.info(
                "Preanalyze ready | key=%s | summary=%s | topics=%d | claims=%d | refs=%d",
                key[:12], "yes" if summary else "no", len(ai_topics), len(claims), len(references),
            )
        except Exception as exc:
            log.exception("Preanalyze failed | key=%s", key[:12])
            _write_status(key, "error", error=str(exc))
        finally:
            _event_for(key).set()
            # Result is on disk; the PDF bytes and full raw text can go back to the OS.
            from services.mem import trim_memory

            trim_memory(f"preanalyze {key[:12]}")


# Bytes are handed to the worker thread in-memory (avoids re-reading the upload).
_pending_bytes: dict[str, bytes] = {}


def ensure_started(pdf_bytes: bytes) -> dict[str, Any]:
    """
    Start the LLM analysis if not already running/ready for this PDF hash.
    Returns {analysis_key, status}.
    """
    key = analysis_cache_key(pdf_bytes)
    with _lock:
        st = _read_status(key)
        if st and st.get("status") in ("running", "ready"):
            return {"analysis_key": key, "status": st["status"]}
        if st and st.get("status") == "pending":
            return {"analysis_key": key, "status": "pending"}

        _event_for(key).clear()
        _pending_bytes[key] = pdf_bytes
        _write_status(key, "pending")
        thread = threading.Thread(
            target=_run_analysis,
            args=(key,),
            name=f"preanalyze-{key[:8]}",
            daemon=True,
        )
        thread.start()
    return {"analysis_key": key, "status": "pending"}


def load_result(key: str) -> dict[str, Any] | None:
    """Load the ready analysis result, or None if not ready/missing."""
    st = _read_status(key)
    if not st or st.get("status") != "ready":
        return None
    path = _result_path(key)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def wait_for_result(key: str, timeout: float = 180.0) -> dict[str, Any] | None:
    """Block until the analysis is ready or failed. Returns result dict or None."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = _read_status(key)
        if not st:
            return None
        status = st.get("status")
        if status == "ready":
            return load_result(key)
        if status == "error":
            log.warning("Preanalyze error for %s: %s", key[:12], st.get("error"))
            return None
        if status in ("pending", "running"):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _event_for(key).wait(timeout=min(2.0, remaining))
            continue
        break
    log.warning("Preanalyze wait timed out | key=%s", key[:12])
    return None


def consume_result(key: str) -> dict[str, Any] | None:
    """Load and delete the cached entry (cleanup after a successful upload)."""
    result = load_result(key)
    if result is None:
        return None
    try:
        import shutil
        shutil.rmtree(_entry_dir(key), ignore_errors=True)
    except Exception:
        pass
    with _lock:
        _events.pop(key, None)
        _pending_bytes.pop(key, None)
    return result
