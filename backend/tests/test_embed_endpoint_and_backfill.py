"""Embeddings use EMBED_ENDPOINT when set; the figures backfill saves extract_figures' dict result."""
from config import settings
from services import litellm_client


def test_embed_client_uses_embed_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "embed_endpoint", "http://ollama:11434")
    monkeypatch.setattr(settings, "embed_api_key", "")
    client = litellm_client._embed_client()
    assert str(client.base_url).rstrip("/") == "http://ollama:11434/v1"


def test_embed_client_falls_back_to_litellm(monkeypatch):
    monkeypatch.setattr(settings, "embed_endpoint", "")
    sentinel = object()
    monkeypatch.setattr(litellm_client, "get_litellm_client", lambda: sentinel)
    assert litellm_client._embed_client() is sentinel


def test_backfill_figures_saves_figures_and_tables(monkeypatch):
    import db.queries.figures
    import services.drive
    import services.figure_extractor
    import services.ingest_assets
    from routers import backfill

    extraction = {"figures": [{"page_number": 1, "image_bytes": b"png"}], "tables": [{"page_number": 2}]}
    saved = []
    monkeypatch.setattr(backfill, "get_driver", lambda: None)
    monkeypatch.setattr(backfill, "list_papers", lambda *a, **k: [
        {"id": "p1", "drive_file_id": "local-x.pdf"},
        {"id": "stub"},  # no PDF: skipped
    ])
    monkeypatch.setattr(db.queries.figures, "list_figures", lambda driver, pid: [])
    monkeypatch.setattr(services.drive, "download_pdf", lambda fid: b"%PDF")
    monkeypatch.setattr(services.figure_extractor, "extract_figures", lambda pdf, caption_method: extraction)
    monkeypatch.setattr(services.ingest_assets, "save_figures_and_tables",
                        lambda driver, pid, ex: saved.append((pid, ex)) or (1, 1))

    assert backfill.backfill_figures() == {"processed": 1, "skipped": 1, "errors": 0}
    assert saved == [("p1", extraction)]
