"""Disk-backed cache for Docling figure/table extraction during upload queue.

Each PDF is keyed by SHA-256 of its bytes. Docling runs at most once per key while
the entry is pending or ready (within TTL). Upload waits for an in-flight job or
reads the cached result.
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
_CACHE_ROOT = Path(os.environ.get("INGEST_PREPROCESS_DIR", "/tmp/papermanager_preprocess"))

# Reentrant: ensure_started() holds this lock and then calls _event_for(), which
# re-acquires it. A plain Lock would self-deadlock the calling thread (and, since
# /preprocess runs ensure_started on the event loop, the whole server).
_lock = threading.RLock()
_events: dict[str, threading.Event] = {}

# On-demand Docling allows only ONE instance — concurrent starts get HTTP 409
# from the inference manager. Serialize so each queued PDF runs Docling in turn
# instead of conflicting and falling back to pypdf.
_docling_sem = threading.Semaphore(int(os.environ.get("DOCLING_CONCURRENCY", "1")))


def pdf_cache_key(pdf_bytes: bytes) -> str:
    return hashlib.sha256(pdf_bytes).hexdigest()


# Identifies this app process in status files (see _read_status).
_BOOT = uuid.uuid4().hex


def _entry_dir(key: str) -> Path:
    return _CACHE_ROOT / key


def _status_path(key: str) -> Path:
    return _entry_dir(key) / "status.json"


def _result_path(key: str) -> Path:
    return _entry_dir(key) / "result.json"


def _figures_dir(key: str) -> Path:
    return _entry_dir(key) / "figures"


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


def _write_status(key: str, status: str, *, error: str | None = None, caption_method: str | None = None) -> None:
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
    if caption_method:
        payload["caption_method"] = caption_method
    _status_path(key).write_text(json.dumps(payload), encoding="utf-8")


def get_status(key: str) -> dict[str, Any]:
    """Return {status: pending|running|ready|error|missing, ...}."""
    st = _read_status(key)
    if not st:
        return {"preprocess_key": key, "status": "missing"}
    return {"preprocess_key": key, **st}


def _event_for(key: str) -> threading.Event:
    with _lock:
        if key not in _events:
            _events[key] = threading.Event()
        return _events[key]


def _run_docling(key: str, pdf_bytes: bytes, caption_method: str) -> None:
    from services.figure_extractor import extract_figures

    # Serialize Docling so concurrent on-demand starts don't collide (HTTP 409).
    with _docling_sem:
        try:
            _write_status(key, "running", caption_method=caption_method)
            result = extract_figures(pdf_bytes, caption_method=caption_method or "docling")
            figures = result.get("figures") or []
            tables = result.get("tables") or []

            fig_dir = _figures_dir(key)
            fig_dir.mkdir(parents=True, exist_ok=True)
            figure_meta = []
            for i, fig in enumerate(figures):
                png_path = fig_dir / f"{i}.png"
                png_path.write_bytes(fig["image_bytes"])
                figure_meta.append({
                    "page_number": fig.get("page_number"),
                    "figure_number": fig.get("figure_number"),
                    "caption": fig.get("caption"),
                    "file": f"figures/{i}.png",
                })

            _result_path(key).write_text(
                json.dumps({"figures": figure_meta, "tables": tables}, ensure_ascii=False),
                encoding="utf-8",
            )
            _write_status(key, "ready", caption_method=caption_method)
            log.info(
                "Preprocess ready | key=%s | figures=%d | tables=%d",
                key[:12], len(figure_meta), len(tables),
            )
        except Exception as exc:
            log.exception("Preprocess failed | key=%s", key[:12])
            _write_status(key, "error", error=str(exc), caption_method=caption_method)
        finally:
            _event_for(key).set()
            # Figures are on disk now, so nothing from this job needs to stay
            # resident. Hand the freed arenas back to the OS.
            from services.mem import trim_memory

            trim_memory(f"preprocess {key[:12]}")


def ensure_started(pdf_bytes: bytes, caption_method: str = "docling") -> dict[str, Any]:
    """
    Start Docling extraction if not already running/ready for this PDF hash.
    Returns {preprocess_key, status}.
    """
    key = pdf_cache_key(pdf_bytes)
    with _lock:
        st = _read_status(key)
        if st and st.get("status") in ("running", "ready"):
            return {"preprocess_key": key, "status": st["status"]}
        if st and st.get("status") == "pending":
            return {"preprocess_key": key, "status": "pending"}

        _event_for(key).clear()
        _write_status(key, "pending", caption_method=caption_method)
        thread = threading.Thread(
            target=_run_docling,
            args=(key, pdf_bytes, caption_method),
            name=f"preprocess-{key[:8]}",
            daemon=True,
        )
        thread.start()
    return {"preprocess_key": key, "status": "pending"}


def wait_for_result(key: str, timeout: float = 600.0) -> dict[str, Any] | None:
    """
    Block until preprocess is ready or failed. Returns extraction dict with
    figure image_bytes populated, or None if missing/error/timeout.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = _read_status(key)
        if not st:
            return None
        status = st.get("status")
        if status == "ready":
            return load_result(key)
        if status == "error":
            log.warning("Preprocess error for %s: %s", key[:12], st.get("error"))
            return None
        if status in ("pending", "running"):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ev = _event_for(key)
            ev.wait(timeout=min(2.0, remaining))
            continue
        break
    log.warning("Preprocess wait timed out | key=%s", key[:12])
    return None


def load_result(key: str) -> dict[str, Any] | None:
    """Load ready result; returns {figures: [...], tables: [...]} with image_bytes."""
    st = _read_status(key)
    if not st or st.get("status") != "ready":
        return None
    path = _result_path(key)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

    entry = _entry_dir(key)
    figures_out = []
    for fig in data.get("figures") or []:
        rel = fig.get("file")
        if not rel:
            continue
        png_path = entry / rel
        if not png_path.is_file():
            continue
        figures_out.append({
            "page_number": fig.get("page_number"),
            "figure_number": fig.get("figure_number"),
            "caption": fig.get("caption"),
            "image_bytes": png_path.read_bytes(),
        })
    return {"figures": figures_out, "tables": data.get("tables") or []}


def consume_result(key: str) -> dict[str, Any] | None:
    """Load and delete cached entry (optional cleanup after upload)."""
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
    return result
