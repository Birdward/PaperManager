"""Service for detecting and extracting chapters from book/lecture PDFs.

Primary method: Docling-based structural detection (page numbers come directly
from Docling's provenance data — no regex page-matching needed).

Fallback: regex on raw text (legacy, used when no PDF is available).
"""
from __future__ import annotations

import io
import re
import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

# ── Regex fallback patterns ───────────────────────────────────────────────────

_CHAPTER_WORD_RE = re.compile(
    r"^[ \t]*(?:chapter)\s+(\d+)[:\.\s]*([^\n]{0,80})",
    re.IGNORECASE | re.MULTILINE,
)
_SUB_SECTION_RE = re.compile(
    r"^[ \t]*(\d{1,3})\.(\d{1,3})\.?\s+([A-Z][^\n]{3,80})",
    re.MULTILINE,
)
_NUMBERED_SECTION_RE = re.compile(
    r"^[ \t]*(\d{1,3})[\.:\s]\s+([A-Z][^\n]{3,80})",
    re.MULTILINE,
)
_FALLBACK_HEADING_RE = re.compile(
    r"^[ \t]*([A-Z][A-Z\s\d\-:]{4,60}[A-Z\d])\s*$",
    re.MULTILINE,
)

MAX_CHAPTER_CHARS = 6_000


@dataclass
class ChapterCandidate:
    number: float
    title: str
    level: int             # 1 = chapter, 2 = sub-chapter
    start_char: int
    end_char: int = -1
    text: str = field(default="", repr=False)


# ── Heading normalisation ─────────────────────────────────────────────────────

def _clean_heading(text: str) -> tuple[str, int]:
    """
    Strip leading section numbers from a heading and return (clean_title, level).

    Examples:
      "1 Introduction"           → ("Introduction", 1)
      "2.1 Background"           → ("Background", 2)
      "3.1.2 Details"            → ("Details", 2)
      "Chapter 3 Methods"        → ("Methods", 1)
      "Chapter 3: Methods"       → ("Methods", 1)
      "Acknowledgments"          → ("Acknowledgments", 1)
    """
    t = text.strip()

    # "Chapter N [: ] Title"
    m = re.match(r"(?i)^chapter\s+\d+[:\s.]*(.*)$", t)
    if m:
        title = m.group(1).strip() or t
        return title, 1

    # "N.M[.K...] [: ] Title"  → sub-chapter
    m = re.match(r"^(\d+)\.(\d+)(?:\.\d+)*[\s:.]*(.*)$", t)
    if m:
        title = m.group(3).strip() or t
        return title, 2

    # "N. Title" or "N Title"   → top-level chapter
    m = re.match(r"^(\d+)[.\s]\s*(.+)$", t)
    if m:
        title = m.group(2).strip()
        return title, 1

    return t, 1


def _ollama_reclassify_headings(raw_chapters: list[dict]) -> list[dict]:
    """
    Ask Ollama to review the detected heading list, fix level assignments
    (chapter vs sub-chapter) and clean up titles.

    Returns the same list with 'title' and 'level' fields potentially updated.
    Falls back to the original list on any error.
    """
    import json
    from services.litellm_client import chat_completion, resolve_chat_model
    from config import settings

    if not raw_chapters:
        return raw_chapters

    lines = "\n".join(
        f"{i}: (level {ch['level']}) {ch['title']}"
        for i, ch in enumerate(raw_chapters)
    )
    prompt = (
        "You are a book indexer. Below are section headings detected from a PDF, "
        "with their current level assignment. Fix any wrong levels and strip any "
        "leading section numbers (like '2.1 ' or '3. ') from titles.\n"
        "Rules:\n"
        "  - level 1 = top-level chapter (e.g. 'Introduction', 'Methods', 'Chapter 3')\n"
        "  - level 2 = sub-chapter (e.g. anything with a decimal like '2.1', '3.2.1')\n"
        "Return ONLY a JSON array, no explanation. Each element: "
        "{\"idx\": <original index>, \"title\": \"<clean title>\", \"level\": <1 or 2>}\n\n"
        f"Headings:\n{lines}"
    )

    try:
        raw = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            model=resolve_chat_model(settings.litellm_model),
        )
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if not match:
            return raw_chapters
        data = json.loads(match.group())
        by_idx = {int(item["idx"]): item for item in data if "idx" in item}
        for i, ch in enumerate(raw_chapters):
            if i in by_idx:
                ch["title"] = str(by_idx[i].get("title", ch["title"])).strip()
                ch["level"] = int(by_idx[i].get("level", ch["level"]))
        log.info("Ollama reclassified %d/%d chapter headings", len(by_idx), len(raw_chapters))
    except Exception as exc:
        log.warning("Ollama heading reclassification failed (non-fatal): %s", exc)

    return raw_chapters


# ── Monotonicity enforcement ──────────────────────────────────────────────────

def _enforce_monotone_pages(chapters: list[dict], total_pages: int) -> list[dict]:
    """
    Ensure start_pages are strictly increasing (drop chapters that go backwards)
    and assign end_pages with a maximum 1-page overlap at chapter boundaries.

    Rules:
    - Drop any chapter whose start_page <= previous chapter's start_page
    - end_page = next_chapter's start_page   (1-page boundary overlap allowed)
    - Last chapter gets end_page = total_pages
    """
    # Filter out chapters with no start_page or non-monotone start_page
    clean: list[dict] = []
    last_start = 0
    for ch in chapters:
        sp = ch.get("start_page")
        if sp is None:
            clean.append(ch)  # keep page-less chapters; assign later
            continue
        if sp > last_start:
            clean.append(ch)
            last_start = sp
        else:
            log.debug("Dropping non-monotone chapter '%s' start_page=%s (prev=%s)",
                      ch.get("title", "?"), sp, last_start)

    # Assign end pages: allow next chapter's first page to overlap
    for i, ch in enumerate(clean):
        if i + 1 < len(clean):
            next_sp = clean[i + 1].get("start_page")
            if next_sp is not None:
                # end = next chapter's start (1-page overlap); clamp to total_pages
                ch["end_page"] = min(next_sp, total_pages)
            elif ch.get("start_page") is not None:
                ch["end_page"] = total_pages
        else:
            if ch.get("start_page") is not None:
                ch["end_page"] = total_pages

    return clean


# ── Density-based chapter merging ─────────────────────────────────────────────

def _merge_overcrowded_chapters(
    raw_chapters: list[dict], total_pages: int, max_per_page: float = 3.0
) -> list[dict]:
    """Merge chapters that share the same page into their first chapter on that page.

    When the chapter detector returns an unrealistic number of chapters (e.g.
    every sub-section heading treated as a chapter), this function groups them
    by their start page and keeps only the first heading on each page as a
    real chapter, folding subsequent headings' text into it.

    After merging, if the density is *still* too high, we keep only the
    chapters that span at least 2 pages (i.e. large enough to be real
    chapters).
    """
    if not raw_chapters:
        return raw_chapters

    # Pass 1: group by start_page — keep first heading per page as parent
    merged: list[dict] = []
    for ch in raw_chapters:
        sp = ch.get("start_page")
        if merged and sp is not None and merged[-1].get("start_page") == sp:
            # Same page as previous chapter — fold in as sub-content
            merged[-1]["_text_parts"].extend(
                [ch.get("title", "")] + ch.get("_text_parts", [])
            )
        else:
            merged.append(ch)

    # Pass 2: if still too dense, keep only chapters spanning ≥ 2 pages
    if total_pages > 0 and len(merged) / total_pages > max_per_page:
        wide = []
        for i, ch in enumerate(merged):
            sp = ch.get("start_page")
            next_sp = merged[i + 1].get("start_page") if i + 1 < len(merged) else total_pages + 1
            if sp is not None and next_sp is not None and next_sp - sp >= 2:
                wide.append(ch)
            elif wide:
                # Fold into previous real chapter
                wide[-1]["_text_parts"].extend(
                    [ch.get("title", "")] + ch.get("_text_parts", [])
                )
            else:
                wide.append(ch)
        merged = wide

    log.info(
        "Chapter merge: %d → %d chapters (total_pages=%d)",
        len(raw_chapters), len(merged), total_pages,
    )
    return merged


# ── Primary: Docling-based detection ─────────────────────────────────────────

def _chapters_from_docling_document(doc) -> list[dict]:
    """Build chapter list from an in-memory DoclingDocument."""
    total_pages = len(doc.pages) if doc.pages else 0
    log.info("Docling conversion done: %d pages", total_pages)
    return _chapters_from_docling_items(doc.iterate_items(), total_pages)


def _chapters_from_docling_items(items, total_pages: int) -> list[dict]:
    """Build chapter list from DoclingDocument items in document order (one or more documents)."""
    from docling.datamodel.base_models import DocItemLabel

    # Collect headings and text in document order
    raw_chapters: list[dict] = []
    current: dict | None = None

    for item, _level in items:
        if not hasattr(item, "label"):
            continue

        # Get page number from provenance (first occurrence)
        page_no: int | None = None
        if item.prov:
            page_no = item.prov[0].page_no

        item_text: str = getattr(item, "text", "") or ""

        if item.label == DocItemLabel.SECTION_HEADER:
            # Strip leading numbers and infer level from the number pattern
            clean_title, level = _clean_heading(item_text)

            # If Docling provides its own level, use it to override
            docling_level = getattr(item, "level", None)
            if docling_level is not None:
                level = 1 if docling_level <= 1 else 2

            if level == 1:
                # Top-level chapter — save previous and start new
                if current is not None:
                    raw_chapters.append(current)
                current = {
                    "title": clean_title,
                    "level": 1,
                    "start_page": page_no,
                    "end_page": None,
                    "_text_parts": [],
                    "summary": None,
                }
            else:
                # Sub-chapter — fold heading text into the current chapter
                if current is not None:
                    current["_text_parts"].append(item_text)

        elif current is not None and item_text.strip():
            current["_text_parts"].append(item_text)

    if current is not None:
        raw_chapters.append(current)

    if not raw_chapters:
        log.info("Docling found no section headers in this PDF")
        return []

    # Sanity check: more than 3 chapters per page is unrealistic — the
    # detector is likely treating sub-sections as top-level chapters.
    # Merge the excess chapters back into their preceding real chapter.
    if total_pages > 0:
        chapters_per_page = len(raw_chapters) / total_pages
        if chapters_per_page > 3:
            log.warning(
                "Chapter density too high (%.1f chapters/page, %d chapters in %d pages) "
                "— merging likely sub-chapters back into parent chapters",
                chapters_per_page, len(raw_chapters), total_pages,
            )
            raw_chapters = _merge_overcrowded_chapters(raw_chapters, total_pages)

    # Finalise text
    for ch in raw_chapters:
        ch["text"] = "\n\n".join(ch.pop("_text_parts", []))

    # Assign sequential numbers
    for i, ch in enumerate(raw_chapters):
        ch["number"] = i + 1

    # Enforce strictly increasing page numbers and assign end_pages
    chapters = _enforce_monotone_pages(raw_chapters, total_pages)

    log.info("Docling chapter detection: %d chapters found", len(chapters))
    return chapters


def detect_chapters_docling(pdf_bytes: bytes) -> list[dict]:
    """
    Use Docling to detect chapters from PDF bytes.

    Uses on-demand docling-serve on hermione when ``docling_mode=on_demand``,
    otherwise in-process Docling (requires the docling package).
    """
    from config import settings

    if (settings.docling_mode or "").strip().lower() == "off":
        log.info("Docling is off; skipping Docling chapter detection")
        return []

    try:
        if settings.docling_serve_url.strip():
            from services.docling_remote import convert_pdf, load_document_from_response

            payload = convert_pdf(pdf_bytes, settings.docling_serve_url.strip())
            doc = load_document_from_response(payload)
            return _chapters_from_docling_document(doc)

        if (settings.docling_mode or "local").strip().lower() == "on_demand":
            from services.on_demand_docling import on_demand_docling
            from services.docling_remote import convert_pdf, load_document_from_response

            with on_demand_docling() as manager_url:
                payload = convert_pdf(pdf_bytes, manager_url, via_manager_proxy=True)
                doc = load_document_from_response(payload)
                return _chapters_from_docling_document(doc)

        import docling  # noqa: F401  (is local Docling installed?)
    except ImportError:
        log.warning("Docling not available; cannot do Docling-based detection")
        return []

    try:
        from pypdf import PdfReader
        from services.figure_extractor import _get_converter, docling_documents

        log.info("Running Docling PDF conversion for chapter detection...")
        # The figure extractor's converter, so its models are loaded once per process, and in page
        # chunks (see figure_extractor.DOCLING_CHUNK_PAGES): a whole thesis at once runs out of memory.
        docs = docling_documents(_get_converter(), pdf_bytes)
        items = (item for doc in docs for item in doc.iterate_items())
        return _chapters_from_docling_items(items, len(PdfReader(io.BytesIO(pdf_bytes)).pages))
    except Exception as exc:
        log.warning("Docling conversion failed: %s", exc)
        return []


# ── Fallback: regex-based detection ──────────────────────────────────────────

def _deduplicate(candidates: list[ChapterCandidate]) -> list[ChapterCandidate]:
    seen: set[str] = set()
    result: list[ChapterCandidate] = []
    for c in candidates:
        norm = re.sub(r"\s+", " ", c.title.lower()).strip()
        if norm and norm not in seen:
            seen.add(norm)
            result.append(c)
    return result


def detect_chapters(raw_text: str) -> list[ChapterCandidate]:
    """Detect chapter/section boundaries in raw_text (regex fallback)."""
    if not raw_text or not raw_text.strip():
        return []

    candidates: list[ChapterCandidate] = []

    for m in _CHAPTER_WORD_RE.finditer(raw_text):
        num = float(m.group(1))
        title_part = m.group(2).strip().lstrip(":.- ")
        title = title_part if title_part else f"Chapter {int(num)}"
        candidates.append(ChapterCandidate(number=num, title=title, level=1, start_char=m.start()))

    for m in _SUB_SECTION_RE.finditer(raw_text):
        num = float(f"{m.group(1)}.{m.group(2)}")
        title = m.group(3).strip()
        candidates.append(ChapterCandidate(number=num, title=title, level=2, start_char=m.start()))

    if not any(c.level == 1 for c in candidates):
        for m in _NUMBERED_SECTION_RE.finditer(raw_text):
            num = float(m.group(1))
            title = m.group(2).strip()
            if re.match(r"^(figure|table|fig\.|tab\.)", title, re.IGNORECASE):
                continue
            candidates.append(ChapterCandidate(number=num, title=title, level=1, start_char=m.start()))

    if not candidates:
        for m in _FALLBACK_HEADING_RE.finditer(raw_text):
            title = m.group(1).strip().title()
            candidates.append(ChapterCandidate(
                number=float(len(candidates) + 1),
                title=title,
                level=1,
                start_char=m.start(),
            ))

    if not candidates:
        return []

    candidates.sort(key=lambda c: c.start_char)
    candidates = _deduplicate(candidates)

    for i, cand in enumerate(candidates):
        next_start = candidates[i + 1].start_char if i + 1 < len(candidates) else len(raw_text)
        cand.end_char = next_start
        cand.text = raw_text[cand.start_char:next_start].strip()

    return candidates


def split_long_chapter(chapter: ChapterCandidate, max_chars: int = MAX_CHAPTER_CHARS) -> list[ChapterCandidate]:
    if len(chapter.text) <= max_chars:
        return [chapter]

    paragraphs = re.split(r"\n{2,}", chapter.text)
    sub_chapters: list[ChapterCandidate] = []
    buf = ""
    sub_num = 1

    for para in paragraphs:
        if len(buf) + len(para) > max_chars and buf:
            sub_chapters.append(ChapterCandidate(
                number=round(chapter.number + sub_num * 0.01, 2),
                title=f"{chapter.title} (part {sub_num})",
                level=2,
                start_char=0,
                text=buf.strip(),
            ))
            buf = para
            sub_num += 1
        else:
            buf += ("\n\n" if buf else "") + para

    if buf.strip():
        sub_chapters.append(ChapterCandidate(
            number=round(chapter.number + sub_num * 0.01, 2),
            title=f"{chapter.title} (part {sub_num})",
            level=2,
            start_char=0,
            text=buf.strip(),
        ))

    if not sub_chapters or len(sub_chapters) == 1:
        return [chapter]

    return sub_chapters


def extract_chapters_with_splits(raw_text: str) -> list[dict]:
    """Regex-based entry point: detect + split long chapters (top-level only)."""
    candidates = detect_chapters(raw_text)

    # Keep only top-level chapters; merge subchapter text back into parent
    top_level: list[ChapterCandidate] = []
    for cand in candidates:
        if cand.level == 1:
            top_level.append(cand)
        elif top_level:
            # Append subchapter text to the last top-level chapter
            top_level[-1].text = (top_level[-1].text + "\n\n" + cand.text).strip()

    result: list[dict] = []
    seq = 1
    for cand in top_level:
        parts = split_long_chapter(cand)
        for part in parts:
            result.append({
                "number": seq,
                "title": part.title,
                "level": 1,
                "text": part.text,
                "summary": None,
            })
            seq += 1

    return result


def assign_page_numbers(chapters: list[dict], pdf_bytes: bytes) -> list[dict]:
    """
    Assign start_page/end_page to regex-detected chapters using pypdf page text search.
    Used as fallback when Docling is not available.
    """
    try:
        from pypdf import PdfReader  # type: ignore
        from io import BytesIO

        reader = PdfReader(BytesIO(pdf_bytes))
        page_texts = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        log.warning("PDF page parsing failed; skipping page number assignment | %s", exc)
        return chapters

    total_pages = len(page_texts)
    if total_pages == 0:
        return chapters

    def _find_page_for_text(heading: str) -> int | None:
        norm = re.sub(r"\s+", " ", heading.strip().lower())
        for i, pt in enumerate(page_texts):
            if norm in re.sub(r"\s+", " ", pt.lower()):
                return i + 1
        return None

    for ch in chapters:
        page = _find_page_for_text(ch.get("title", ""))
        if page is not None:
            ch["start_page"] = page

    # Enforce monotonicity and assign end pages
    chapters = _enforce_monotone_pages(chapters, total_pages)
    return chapters
