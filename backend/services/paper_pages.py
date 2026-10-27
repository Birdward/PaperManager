"""A paper's text by PDF page, for chats that can't take a whole long document at once.

Pages are the PDF's own (1-based, as in the viewer and the PDF's bookmarks). Long documents
(theses, books) are read in part: the chat gets the opening pages plus the PDF's outline, and
reads further pages or searches through read_pages / search. PaperDocument records every page
it hands out, so the UI can say which parts an answer was based on.
"""
from __future__ import annotations

import io
import logging
import re
import threading
from functools import lru_cache

log = logging.getLogger(__name__)

# Characters of a paper given to a chat up front (about 25k tokens): whole normal papers, the
# start of a thesis.
INLINE_CHARS = 100_000
# Characters one read_pages call may return.
READ_CHARS = 60_000
_OUTLINE_CHARS = 6_000

# How a chat can read beyond what it was given, by which tools it has.
HOW_PAPER_CHAT = ("Read other parts with the read_pages tool (a page range) or find passages with "
                  "search_paper (a word or phrase); do so before answering about any part you haven't read.")
HOW_KNOWLEDGE_CHAT = ("Call load_full_text again with `pages` (e.g. \"59-75\") or `query` (a word or "
                      "phrase) to read other parts before answering about them.")
HOW_NONE = "Other parts are not available to you: say so when a question needs them."


@lru_cache(maxsize=16)
def _pdf_pages(drive_file_id: str) -> tuple[tuple[str, ...], tuple[tuple[int, str, int], ...]]:
    """(text of each page, outline as (level, title, page)) of a stored PDF; cached per file."""
    from pypdf import PdfReader
    from services.drive import download_pdf

    reader = PdfReader(io.BytesIO(download_pdf(drive_file_id)))
    pages = tuple((p.extract_text() or "") for p in reader.pages)
    outline: list[tuple[int, str, int]] = []

    def walk(items, level: int) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
                continue
            try:
                outline.append((level, str(item.title).strip(), reader.get_destination_page_number(item) + 1))
            except Exception:
                pass

    try:
        walk(reader.outline, 0)
    except Exception as exc:
        log.debug("No PDF outline | %s", exc)
    return pages, tuple(outline)


def _ranges(pages: set[int]) -> str:
    """{1, 2, 3, 7} -> "1-3, 7"."""
    out, run = [], []
    for p in sorted(pages):
        if run and p == run[-1] + 1:
            run.append(p)
            continue
        if run:
            out.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
        run = [p]
    if run:
        out.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
    return ", ".join(out)


class PaperDocument:
    """One paper's pages, what was handed to the chat, and how to read more."""

    def __init__(self, pages: list[str], outline: list[tuple[int, str, int]] | None = None):
        self.pages = pages
        self.outline = outline or []
        self.read: set[int] = set()
        self._lock = threading.Lock()

    @classmethod
    def for_paper(cls, paper: dict) -> "PaperDocument":
        """From the stored PDF when there is one, else the stored text in page-sized parts."""
        if paper.get("drive_file_id"):
            try:
                pages, outline = _pdf_pages(paper["drive_file_id"])
                if any(p.strip() for p in pages):
                    return cls(list(pages), list(outline))
            except Exception as exc:
                log.warning("Could not read PDF pages; using stored text | %s", exc)
        text = paper.get("raw_text") or ""
        return cls([text[i:i + 3000] for i in range(0, len(text), 3000)] or [""])

    @property
    def total_pages(self) -> int:
        return len(self.pages)

    @property
    def total_chars(self) -> int:
        return sum(len(p) for p in self.pages)

    @property
    def is_long(self) -> bool:
        return self.total_chars > INLINE_CHARS

    @property
    def complete(self) -> bool:
        return len(self.read) >= self.total_pages

    def _take(self, start: int, end: int, budget: int) -> str:
        """Pages start..end (1-based, inclusive) with page markers, within *budget* characters."""
        parts, used = [], 0
        for n in range(max(1, start), min(end, self.total_pages) + 1):
            page = f"--- page {n} ---\n{self.pages[n - 1].strip()}\n"
            if used + len(page) > budget and parts:
                break
            parts.append(page)
            used += len(page)
            with self._lock:
                self.read.add(n)
        return "".join(parts)

    def outline_text(self) -> str:
        if not self.outline:
            return ""
        lines = [f"{'  ' * lvl}- {title} (p.{page})" for lvl, title, page in self.outline]
        text = "\n".join(lines)
        if len(text) > _OUTLINE_CHARS:  # keep the top levels
            text = "\n".join(f"- {t} (p.{p})" for lvl, t, p in self.outline if lvl == 0)[:_OUTLINE_CHARS]
        return text

    def context_text(self, how: str, budget: int = INLINE_CHARS) -> str:
        """The paper for a chat: all of it if it fits *budget*, else its opening pages, the
        outline and a note saying exactly what is included and (*how*) how to read more."""
        if self.total_chars <= budget:
            return self._take(1, self.total_pages, budget + 10_000)
        opening = self._take(1, self.total_pages, budget)
        included = _ranges(self.read)
        head = (f"[This document is long: {self.total_pages} PDF pages. Only pages {included} are "
                f"included below. {how} Page numbers are PDF pages, as in the outline and the "
                f"reader's highlights.]\n")
        outline = self.outline_text()
        return head + (f"\nOutline (PDF bookmarks):\n{outline}\n" if outline else "") + "\n" + opening

    def read_pages(self, start: int, end: int) -> str:
        if self.total_pages == 0:
            return "[No text]"
        start, end = max(1, int(start)), min(self.total_pages, int(end))
        if start > end:
            return f"[No such pages: the document has {self.total_pages} pages]"
        text = self._take(start, end, READ_CHARS)
        last = max(n for n in self.read if start <= n <= end)
        if last < end:
            text += f"\n[Stopped at page {last} to stay within the size limit; read from page {last + 1} next.]"
        return text

    def search(self, query: str, max_hits: int = 8) -> str:
        """Pages containing *query* (or most of its words), with a snippet around each hit."""
        phrase = re.sub(r"\s+", " ", query.lower()).strip()
        words = [w for w in re.findall(r"\w+", phrase) if len(w) > 2] or [phrase]
        needed = max(1, round(len(words) * 0.6))
        scored = []
        for n, page in enumerate(self.pages, start=1):
            flat = re.sub(r"\s+", " ", page.lower())
            present = [w for w in words if w in flat]
            if phrase in flat:  # the exact phrase ranks first
                scored.append((100 + len(present), n, flat, flat.find(phrase)))
            elif len(present) >= needed:
                scored.append((len(present), n, flat, min(flat.find(w) for w in present)))
        if not scored:
            return f'[No pages match "{query}"]'
        out = []
        for _, n, flat, at in sorted(scored, key=lambda s: (-s[0], s[1]))[:max_hits]:
            out.append(f"p.{n}: …{flat[max(0, at - 300):at + 500]}…")
        return f'Pages matching "{query}" (read the pages you need in full by page range):\n' + "\n\n".join(out)

    def coverage(self) -> dict:
        """What the chat was given, for the UI flag."""
        return {"total_pages": self.total_pages, "pages_read": _ranges(self.read), "complete": self.complete}
