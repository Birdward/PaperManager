"""The reader's notes and highlights for the chats: grouping, colour meanings, budgets, the tool."""
from services import my_notes
from services.ai import execute_library_tool


class _Record(dict):
    def data(self):
        return dict(self)


class FakeDriver:
    """Answers read_my_notes' two queries (highlights, notes) from fixed rows."""

    def __init__(self, highlights, notes):
        self.highlights, self.notes = highlights, notes

    def session(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def run(self, query, params=None, **kw):
        rows = self.highlights if "HAS_ANNOTATION" in query else self.notes
        return [_Record(r) for r in rows]


HIGHLIGHTS = [
    {"paper_id": "p1", "title": "Thesis", "page_number": 12, "color": "red",
     "highlighted_text": "Why does the pose fail?", "note": "Check against PoseBusters."},
    {"paper_id": "p1", "title": "Thesis", "page_number": 30, "color": "yellow",
     "highlighted_text": "Physics checks matter", "note": None},
]
NOTES = [{"paper_id": "p1", "title": "Thesis", "content": "My overall thoughts."}]


def test_notes_and_highlights_with_colour_meanings():
    # Highlights store the viewer's 0-based pageIndex; the chats see PDF pages (index 12 = p.13).
    text, found = my_notes.read_my_notes(FakeDriver(HIGHLIGHTS, NOTES))
    assert found == 3
    assert "red = Question" in text  # the key
    assert "## Thesis (id: p1)" in text and "My note:\nMy overall thoughts." in text
    assert '- p.13 [Question (red)]: "Why does the pose fail?"\n  My comment: Check against PoseBusters.' in text
    assert '- p.31 [Key insight (yellow)]: "Physics checks matter"' in text
    assert "more items not shown" not in text


def test_budget_cuts_and_says_what_is_missing():
    many = [dict(HIGHLIGHTS[0], page_number=i, highlighted_text="x" * 500) for i in range(50)]
    text, found = my_notes.read_my_notes(FakeDriver(many, []), max_chars=3000)
    assert found == 50
    assert len(text) < 3600
    assert "more items not shown. Narrow the request with paper_id, colors or query." in text


def test_long_items_are_cut_individually():
    long = [dict(HIGHLIGHTS[0], highlighted_text="y" * 5000, note="z" * 5000)]
    text, _ = my_notes.read_my_notes(FakeDriver(long, []))
    assert "[…4400 more characters]" in text and "[…3500 more characters]" in text


def test_paper_notes_block_is_empty_without_notes():
    assert my_notes.paper_notes_block(FakeDriver([], []), "p1") == ""
    block = my_notes.paper_notes_block(FakeDriver(HIGHLIGHTS, NOTES), "p1")
    assert block.startswith("## The reader's own notes and highlights on this paper")


def test_read_my_notes_tool_step():
    step, text = execute_library_tool("read_my_notes", {"colors": ["red"]}, FakeDriver(HIGHLIGHTS[:1], []))
    assert step["kind"] == "notes" and step["count"] == 1
    assert "Why does the pose fail?" in text
