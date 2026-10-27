"""Local Docling converts long PDFs in page chunks; jobs left running by a dead process are stale."""
import io
import json

from pypdf import PdfWriter

from services import figure_extractor, ingest_analysis_cache, ingest_preprocess_cache


def _pdf(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=100, height=100)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


class FakeConverter:
    def __init__(self):
        self.ranges = []

    def convert(self, path, page_range=None):
        self.ranges.append(page_range)
        return type("Result", (), {"document": page_range})()


def test_long_pdf_is_converted_in_chunks(monkeypatch):
    monkeypatch.setattr(figure_extractor, "DOCLING_CHUNK_PAGES", 20)
    conv = FakeConverter()
    docs = list(figure_extractor.docling_documents(conv, _pdf(45)))
    assert conv.ranges == [(1, 20), (21, 40), (41, 45)]
    assert docs == conv.ranges


def test_short_pdf_is_converted_whole():
    conv = FakeConverter()
    list(figure_extractor.docling_documents(conv, _pdf(5)))
    assert conv.ranges == [None]


def test_chunk_results_are_merged(monkeypatch):
    monkeypatch.setattr(figure_extractor, "DOCLING_CHUNK_PAGES", 20)
    monkeypatch.setattr(figure_extractor, "_collect_figures_tables_from_doc",
                        lambda doc, method: {"figures": [{"page_number": doc[0]}], "tables": [{"page_number": doc[1]}]})
    out = figure_extractor._extract_figures_docling(FakeConverter(), _pdf(45), "docling")
    assert [f["page_number"] for f in out["figures"]] == [1, 21, 41]
    assert [t["page_number"] for t in out["tables"]] == [20, 40, 45]


def test_running_job_from_previous_process_is_missing(tmp_path, monkeypatch):
    for cache in (ingest_preprocess_cache, ingest_analysis_cache):
        monkeypatch.setattr(cache, "_CACHE_ROOT", tmp_path / cache.__name__)
        cache._write_status("k" * 64, "running")
        assert cache.get_status("k" * 64)["status"] == "running"
        status_file = cache._status_path("k" * 64)
        data = json.loads(status_file.read_text())
        data["boot"] = "an-earlier-process"
        status_file.write_text(json.dumps(data))
        assert cache.get_status("k" * 64)["status"] == "missing"
        # Finished results stay valid across restarts.
        data["status"] = "ready"
        status_file.write_text(json.dumps(data))
        assert cache.get_status("k" * 64)["status"] == "ready"


def test_thesis_style_figure_and_table_numbers():
    norm = figure_extractor._normalize_figure_number
    assert norm("3") == 3
    assert norm("S2") == "S2"
    assert norm("3.1") == "3.1"
    assert norm("4.11") == "4.11"
    assert norm("B.14") == "B.14"
    assert norm("b14") == "B14"
    assert norm("Figure") is None
    import re
    for caption, expected in [("Figure 3.1: PDBbind General 2020", "3.1"), ("Figure B.14: Minimum distances", "B.14"),
                              ("Fig. 2. Overview", 2), ("Figure S3: Extra", "S3"), ("Table 5.2: Results", "5.2")]:
        m = re.search(r"(?:Figure|Fig\.?|Table)\s+" + figure_extractor._NUMBER, caption, re.IGNORECASE)
        assert norm(m.group(1)) == expected, caption
