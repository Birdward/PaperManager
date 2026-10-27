"""Long documents are given to the chats in part, with an outline, page tools and coverage."""
from services import paper_pages
from services.paper_pages import HOW_NONE, HOW_PAPER_CHAT, PaperDocument


def _doc(n_pages=100, chars=2000):
    pages = [f"Page {i} text. " + ("filler " * (chars // 7)) for i in range(1, n_pages + 1)]
    pages[59] = "4 Mining the PDB. Binding mode conservation increases with similarity. " + pages[59]
    return PaperDocument(pages, [(0, "1 Introduction", 1), (0, "4 Mining the PDB", 60), (1, "4.3 Results", 64)])


def test_short_paper_is_given_whole():
    doc = PaperDocument(["short page one", "short page two"])
    text = doc.context_text(HOW_PAPER_CHAT)
    assert "--- page 1 ---" in text and "--- page 2 ---" in text and "only pages" not in text.lower()
    assert doc.coverage() == {"total_pages": 2, "pages_read": "1-2", "complete": True}


def test_long_paper_gets_opening_pages_outline_and_a_note(monkeypatch):
    monkeypatch.setattr(paper_pages, "INLINE_CHARS", 20_000)
    doc = _doc()
    text = doc.context_text(HOW_PAPER_CHAT, budget=20_000)
    assert text.startswith("[This document is long: 100 PDF pages. Only pages 1-")
    assert "read_pages" in text and "- 4 Mining the PDB (p.60)" in text and "  - 4.3 Results (p.64)" in text
    assert "--- page 60 ---" not in text
    cov = doc.coverage()
    assert not cov["complete"] and cov["pages_read"].startswith("1-")


def test_without_tools_the_note_says_other_parts_are_unavailable():
    text = _doc().context_text(HOW_NONE, budget=20_000)
    assert "Other parts are not available to you" in text and "read_pages" not in text


def test_read_pages_records_coverage_and_stops_at_the_limit(monkeypatch):
    doc = _doc()
    doc.context_text(HOW_PAPER_CHAT, budget=20_000)
    text = doc.read_pages(60, 62)
    assert "--- page 60 ---" in text and "--- page 62 ---" in text
    assert "60-62" in doc.coverage()["pages_read"]
    monkeypatch.setattr(paper_pages, "READ_CHARS", 5_000)
    assert "[Stopped at page 64" in doc.read_pages(63, 90)
    assert "[No such pages" in doc.read_pages(500, 600)


def test_search_finds_the_page():
    out = _doc().search("binding mode conservation")
    assert out.startswith('Pages matching "binding mode conservation"') and "p.60:" in out
    assert _doc().search("zebrafish") == '[No pages match "zebrafish"]'


def test_ranges():
    assert paper_pages._ranges({1, 2, 3, 7, 9, 10}) == "1-3, 7, 9-10"
