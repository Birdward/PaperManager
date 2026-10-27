import logging
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Header, status
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional

log = logging.getLogger(__name__)
from db.connection import get_driver
from db.queries.papers import (
    create_paper, merge_paper_by_doi, get_paper, list_papers, update_paper,
    delete_paper, find_duplicate, random_paper, merge_reference_stubs_into_paper,
)
from db.queries.notes import get_paper_note, upsert_note, set_mentions
from db.queries.people import get_or_create_person, get_or_create_person_with_affiliation, link_author
from db.queries.topics import get_or_create_topic, link_paper_topic
from db.queries.tags import tag_paper
from db.queries.projects import add_paper_to_project
from db.queries.users import link_paper_added_by, link_conversation_started_by, link_note_written_by
from db.queries.conversations import (
    create_paper_conversation, list_paper_conversations, get_messages,
    add_message, compact_conversation, delete_conversation, rename_conversation,
    estimate_tokens_approx,
)
from db.queries.references import create_or_link_reference, get_references, get_cited_by
from db.queries.figures import list_figures, delete_figures_for_paper
from services.note_parser import parse_mentions
from services.pdf_parser import extract_metadata
from services.metadata_from_url import resolve_url
from services.metadata_lookup import get_related_papers
from services.drive import upload_pdf, get_file_url, delete_file, download_pdf
from services.ai import (
    summarize_paper,
    suggest_topics,
    chat_with_paper,
    chat_with_paper_work,
    chat_with_paper_litellm,
    extract_affiliations_with_litellm,
    extract_claims,
)
from services.claude_code_chat import chat_with_paper_claude_code
from services.references import extract_references
from services.figure_extractor import extract_figures
from services.drive import upload_image
from db.queries.figures import create_figure
from db.queries.claims import create_claims
from models.schemas import PaperCreate, PaperUpdate, PaperOut, NoteBody, NoteOut, IngestOut, IngestFromUrlBody, ChatRequest, ChatResponse, ReferencesBody

router = APIRouter(prefix="/papers", tags=["papers"])


@router.get("/check-duplicate")
def check_duplicate(doi: Optional[str] = None, title: Optional[str] = None):
    """Return {duplicate: paper | null} — used by the frontend before confirming upload."""
    if not doi and not title:
        return {"duplicate": None}
    driver = get_driver()
    existing = find_duplicate(driver, doi=doi or None, title=title or None)
    if existing:
        if existing.get("drive_file_id"):
            try:
                moved = merge_reference_stubs_into_paper(
                    driver,
                    keep_id=existing["id"],
                    doi=doi or existing.get("doi"),
                    title=title or existing.get("title", ""),
                )
                if moved:
                    log.info(
                        "Duplicate check cleanup merged reference stubs | keep=%s moved=%d",
                        existing["id"],
                        moved,
                    )
            except Exception as exc:
                log.warning("Duplicate check cleanup failed (non-fatal) | %s", exc)
        existing.pop("raw_text", None)
        return {"duplicate": existing}
    return {"duplicate": None}


@router.post("/parse")
async def parse_pdf(file: UploadFile = File(...)):
    """Extract metadata from a PDF without saving anything.
    Used by the frontend confirmation modal before the real upload."""
    from fastapi.concurrency import run_in_threadpool

    pdf_bytes = await file.read()
    # Queue preflight must stay fast and must NOT hold a worker thread on a
    # multi-second LLM call: sync endpoints (login, /users/identify) share the
    # same AnyIO threadpool, and a burst of dropped PDFs running Gemma here
    # would starve auth requests (502/504 "can't login"). So the preview uses
    # heuristics only (allow_llm=False) and reads just the first 2 pages. The
    # full Gemma-backed extraction runs later in POST /papers/upload.
    meta = await run_in_threadpool(
        extract_metadata, pdf_bytes, allow_llm=False, max_pages=2
    )
    meta.pop("raw_text", None)  # too large for JSON
    return meta


@router.post("/preprocess")
async def preprocess_pdf(
    file: UploadFile = File(...),
    caption_method: Optional[str] = Form("docling"),
):
    """
    Start Docling figure/table extraction for a queued PDF (runs once per file hash).
    Call when the file enters the upload queue, in parallel with /parse.
    """
    from services.ingest_preprocess_cache import ensure_started
    from fastapi.concurrency import run_in_threadpool

    pdf_bytes = await file.read()
    # Offload hashing + file I/O off the event loop.
    return await run_in_threadpool(
        ensure_started, pdf_bytes, caption_method=caption_method or "docling"
    )


@router.get("/preprocess/{preprocess_key}")
def preprocess_status(preprocess_key: str):
    """Poll preprocess job status (pending | running | ready | error | missing)."""
    from services.ingest_preprocess_cache import get_status

    return get_status(preprocess_key)


@router.post("/preanalyze")
async def preanalyze_pdf(file: UploadFile = File(...)):
    """
    Start the heavy LLM analysis (summary, topics, claims, references, tag
    suggestions) for a queued PDF — runs once per file hash in the background.
    Call when the file enters the upload queue; /upload reuses the cached result.
    """
    from services.ingest_analysis_cache import ensure_started
    from fastapi.concurrency import run_in_threadpool

    pdf_bytes = await file.read()
    return await run_in_threadpool(ensure_started, pdf_bytes)


@router.get("/preanalyze/{analysis_key}")
def preanalyze_status(analysis_key: str):
    """Poll analysis job status; includes tag_suggestions once ready."""
    from services.ingest_analysis_cache import get_status, load_result

    st = get_status(analysis_key)
    if st.get("status") == "ready":
        result = load_result(analysis_key)
        if result:
            st["tag_suggestions"] = result.get("tag_suggestions")
            meta = result.get("meta")
            if isinstance(meta, dict):
                # Keep queued-status payload light while still returning the
                # improved Gemma metadata (title/authors/etc.) for UI upgrades.
                st["meta"] = {k: v for k, v in meta.items() if k != "raw_text"}
    return st


@router.post("", response_model=PaperOut, status_code=status.HTTP_201_CREATED)
def create(body: PaperCreate):
    return create_paper(get_driver(), body.model_dump())


@router.post("/upload", response_model=IngestOut, status_code=status.HTTP_201_CREATED)
def upload(
    file: UploadFile = File(...),
    title_override: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    caption_method: Optional[str] = Form("ollama"),
    summary_instructions: Optional[str] = Form(None),
    document_type: Optional[str] = Form(None),
    published_date: Optional[str] = Form(None),
    claims_model: Optional[str] = Form("litellm"),
    skip_embedding: bool = Form(False),
    preprocess_key: Optional[str] = Form(None),
    analysis_key: Optional[str] = Form(None),
    debug: bool = Form(False),
    x_user_name: Optional[str] = Header(None),
):
    """Full ingestion pipeline: PDF → metadata → Drive → summary → Neo4j.

    Defined as a SYNC endpoint on purpose: the pipeline is entirely blocking
    (LLM calls, Drive upload, Neo4j writes). As a sync def, FastAPI runs it in
    the threadpool instead of on the event loop, so a long upload can't freeze
    the single worker's event loop and starve auth/other requests.

    When document_type is 'book' or 'lecture_deck', references and figure
    extraction are skipped — chapter detection is available separately via
    POST /papers/{id}/chapters/detect.

    A 'news_article' behaves like a paper (summary + claims + embedding +
    topics) but skips academic references and figure extraction, which don't
    apply to news. Scanned newspaper PDFs are OCR'd by Docling like any upload.
    """
    pdf_bytes = file.file.read()

    is_book = document_type in ("book", "lecture_deck")
    is_news = document_type == "news_article"
    # References and figures are academic scaffolding that news articles lack.
    skip_refs_and_figures = is_book or is_news
    log.info("UPLOAD START | filename=%s | bytes=%d | document_type=%s",
             file.filename, len(pdf_bytes), document_type)

    # Step 0: Reuse the queue's precomputed analysis if available (summary,
    # topics, claims, references, metadata) — makes the upload near-instant.
    analysis = None
    if analysis_key:
        from services.ingest_analysis_cache import wait_for_result as _wait_analysis
        analysis = _wait_analysis(analysis_key, timeout=180.0)
        if analysis:
            log.info("UPLOAD using cached analysis | key=%s", analysis_key[:12])

    # Step 1-2: Extract metadata (reuse cached metadata when present)
    if analysis and analysis.get("meta"):
        meta = analysis["meta"]
    else:
        log.info("UPLOAD step 1: extract_metadata (LLM primary)")
        meta = extract_metadata(pdf_bytes)
    raw_text = meta.get("raw_text", "")
    log.info("UPLOAD step 1 done | source=%s | title=%.60s",
             meta.get("metadata_source"), meta.get("title"))

    # Step 3: Apply title override
    if title_override:
        meta["title"] = title_override

    # Step 4: Upload to Drive
    filename = file.filename or f"{meta['title'][:60]}.pdf"
    try:
        drive_file_id = upload_pdf(pdf_bytes, filename)
        log.info("Drive upload OK | file_id=%s | filename=%s", drive_file_id, filename)
    except Exception as exc:
        log.error("Drive upload failed | %s", exc)
        raise HTTPException(status_code=503, detail=f"Drive upload failed: {exc}")

    # Step 5: Generate AI summary (skipped for books/lecture decks)
    summary = None
    if not is_book and raw_text:
        # Reuse the precomputed summary only when the user kept default
        # instructions (the queue precompute always uses defaults).
        if analysis and analysis.get("summary") and not summary_instructions:
            summary = analysis["summary"]
            log.info("Summary reused from cache | title=%.60s", meta.get("title"))
        else:
            try:
                summary = summarize_paper(raw_text, meta.get("title", ""), summary_instructions or None)
                log.info("Summary generated | title=%.60s", meta.get("title"))
            except Exception as exc:
                log.warning("Summary failed (non-fatal) | %s", exc)

    # Step 5b: Generate vector embedding (best-effort — don't fail if Ollama is down)
    from config import settings as _settings
    if not skip_embedding and _settings.litellm_embed_model:
        try:
            from services.embeddings import embed_paper as _embed_paper
            meta["embedding"] = _embed_paper(
                title=meta.get("title", ""),
                abstract=meta.get("abstract", "") or "",
                summary=summary or "",
            )
            log.info("Embedding generated | title=%.60s", meta.get("title"))
        except Exception as exc:
            log.warning("Embedding failed (non-fatal) | %s", exc)

    # Step 6: Save paper to Neo4j — deduplicate by DOI then by title
    driver = get_driver()
    import json as _json

    existing = find_duplicate(driver, doi=meta.get("doi"), title=meta.get("title", ""))
    if existing:
        if existing.get("drive_file_id"):
            # Full paper already in library — block duplicate
            raise HTTPException(
                status_code=409,
                detail=_json.dumps({
                    "message": "Paper already exists in your library",
                    "existing_id": existing["id"],
                    "existing_title": existing.get("title", ""),
                }),
            )
        # Stub (no PDF yet) — enrich the existing node in place so all existing
        # links (e.g. references/citations) remain attached to the same paper.
        log.info("Enriching stub paper %s with uploaded PDF", existing["id"])
        paper = update_paper(driver, existing["id"], {
            "title": meta.get("title") or existing.get("title") or "",
            "year": meta.get("year") if meta.get("year") is not None else existing.get("year"),
            "doi": meta.get("doi") or existing.get("doi"),
            "abstract": meta.get("abstract") or existing.get("abstract"),
            "summary": summary,
            "drive_file_id": drive_file_id,
            "citation_count": meta.get("citation_count") if meta.get("citation_count") is not None else existing.get("citation_count"),
            "metadata_source": meta.get("metadata_source", existing.get("metadata_source") or "heuristic"),
            "raw_text": raw_text,
            "venue": meta.get("venue") or existing.get("venue"),
            "document_type": document_type or existing.get("document_type"),
            "published_date": published_date or existing.get("published_date"),
        })
        if not paper:
            raise HTTPException(status_code=500, detail="Failed to enrich existing paper")
    elif meta.get("doi"):
        # No existing paper but DOI known — use merge to future-proof against race conditions
        paper = merge_paper_by_doi(driver, {
            "title": meta.get("title", ""),
            "year": meta.get("year"),
            "doi": meta.get("doi"),
            "abstract": meta.get("abstract"),
            "summary": summary,
            "drive_file_id": drive_file_id,
            "citation_count": meta.get("citation_count"),
            "metadata_source": meta.get("metadata_source", "heuristic"),
            "raw_text": raw_text,
            "venue": meta.get("venue"),
            "document_type": document_type,
            "published_date": published_date,
        })
    else:
        paper = create_paper(driver, {
            "title": meta.get("title", ""),
            "year": meta.get("year"),
            "doi": meta.get("doi"),
            "abstract": meta.get("abstract"),
            "summary": summary,
            "drive_file_id": drive_file_id,
            "citation_count": meta.get("citation_count"),
            "metadata_source": meta.get("metadata_source", "heuristic"),
            "raw_text": raw_text,
            "venue": meta.get("venue"),
            "document_type": document_type,
            "published_date": published_date,
        })

    log.info("Paper saved | id=%s | title=%.60s", paper["id"], paper.get("title"))

    # Step 5b's embedding: none of the three save paths above stores it.
    if meta.get("embedding"):
        with driver.session() as session:
            session.run("MATCH (p:Paper {id: $id}) SET p.embedding = $emb", id=paper["id"], emb=meta["embedding"])

    # Step 6a: Attribute to user
    if x_user_name:
        try:
            link_paper_added_by(driver, paper["id"], x_user_name)
        except Exception as exc:
            log.warning("User attribution failed (non-fatal) | %s", exc)

    # Step 6b: Apply source tag
    tag_paper(driver, paper["id"], "pdf-upload")
    if is_book:
        tag_paper(driver, paper["id"], document_type or "book")
    if is_news:
        tag_paper(driver, paper["id"], "from-newspaper")
    if debug:
        tag_paper(driver, paper["id"], "debug")

    # Step 7: Link authors (with affiliations and S2 author IDs)
    authors_detail = meta.get("authors_detail") or []
    aff_map = {d["name"]: d.get("affiliation") for d in authors_detail}
    s2_id_map = {d["name"]: d.get("s2_author_id") for d in authors_detail}

    # Ollama fallback for any author still missing an affiliation
    missing = [n for n in meta.get("authors", []) if n and not aff_map.get(n)]
    if missing and raw_text:
        try:
            if analysis and analysis.get("affiliations") is not None:
                litellm_affs = analysis["affiliations"]
                log.info("Affiliations reused from cache | count=%d", len(litellm_affs))
            else:
                litellm_affs = extract_affiliations_with_litellm(missing, raw_text)
                log.info("LiteLLM affiliations extracted | count=%d", len(litellm_affs))
            aff_map.update(litellm_affs)
        except Exception as exc:
            log.warning("Ollama affiliation extraction failed (non-fatal) | %s", exc)

    authors_saved = []
    for name in meta.get("authors", []):
        if not name:
            continue
        person = get_or_create_person_with_affiliation(
            driver, name, aff_map.get(name), s2_id_map.get(name)
        )
        link_author(driver, paper["id"], person["id"])
        authors_saved.append(name)

    # Step 7b: Enrich author profiles from raw_text (ORCID/Scholar link extraction)
    try:
        from services.person_enrichment import enrich_authors_from_paper
        enrich_authors_from_paper(driver, paper["id"], raw_text or "")
    except Exception as _enrich_exc:
        log.warning("Author enrichment failed (non-fatal) | %s", _enrich_exc)

    # Step 8: Link auto-topics (from Semantic Scholar)
    topics_added = []
    for topic_name in meta.get("topics", []):
        if not topic_name:
            continue
        link_paper_topic(driver, paper["id"], topic_name)  # takes the name; creates the topic
        topics_added.append(topic_name)

    # Step 8b: AI topic suggestion (best-effort, supplements Semantic Scholar topics)
    try:
        if analysis and analysis.get("ai_topics") is not None:
            ai_topics = analysis["ai_topics"]
        else:
            ai_topics = suggest_topics(
                title=meta.get("title", ""),
                abstract=meta.get("abstract", "") or "",
                summary=summary or "",
            )
        for topic_name in ai_topics:
            if topic_name and topic_name not in topics_added:
                link_paper_topic(driver, paper["id"], topic_name)
                topics_added.append(topic_name)
        log.info("AI topics added | count=%d | paper_id=%s", len(ai_topics), paper["id"])
    except Exception as exc:
        log.warning("AI topic suggestion failed (non-fatal) | %s", exc)

    # Step 8c: Extract claims (best-effort — skipped for books/lecture decks)
    if not is_book and claims_model:
        try:
            if analysis and analysis.get("claims") is not None:
                claims_data = analysis["claims"]
            else:
                claims_data = extract_claims(raw_text, meta.get("title", ""), model=claims_model)
            if claims_data:
                create_claims(driver, paper["id"], claims_data)
                log.info("Claims extracted | count=%d | paper_id=%s", len(claims_data), paper["id"])
        except Exception as exc:
            log.warning("Claim extraction failed (non-fatal) | %s", exc)

    # Step 9: Link to project if provided
    if project_id:
        try:
            add_paper_to_project(driver, paper_id=paper["id"], project_id=project_id)
        except Exception:
            pass  # project not found — don't fail the whole ingestion

    # Step 10: Extract references (best-effort — skipped for books/lecture decks/news)
    references_found = []
    if not skip_refs_and_figures:
        try:
            if analysis and analysis.get("references") is not None:
                references_found = analysis["references"]
            else:
                references_found = extract_references(raw_text, meta.get("doi"))
            log.info("References extracted | count=%d | paper_id=%s", len(references_found), paper["id"])
        except Exception as exc:
            log.warning("Reference extraction failed (non-fatal) | %s", exc)
    else:
        log.info("Skipping reference extraction for document_type=%s | paper_id=%s", document_type, paper["id"])

    # Step 11: Figures + tables (best-effort — skipped for books/lecture decks/news)
    if not skip_refs_and_figures:
        try:
            from services.ingest_preprocess_cache import wait_for_result, consume_result
            from services.ingest_assets import save_figures_and_tables

            extraction = None
            if preprocess_key:
                # Bound the wait so a slow/stuck Docling job can't park this
                # worker thread for the full 10 min default.
                extraction = wait_for_result(preprocess_key, timeout=300.0)
                if extraction:
                    consume_result(preprocess_key)
                    log.info(
                        "Using queued Docling cache | paper_id=%s | figures=%d | tables=%d",
                        paper["id"],
                        len(extraction.get("figures") or []),
                        len(extraction.get("tables") or []),
                    )
            if extraction is None:
                log.info("Running Docling on upload (no cache) | paper_id=%s", paper["id"])
                extraction = extract_figures(
                    pdf_bytes, caption_method=caption_method or "ollama"
                )
            n_figs, n_tbls = save_figures_and_tables(driver, paper["id"], extraction)
            log.info(
                "Figures/tables saved | figures=%d | tables=%d | paper_id=%s",
                n_figs, n_tbls, paper["id"],
            )
        except Exception as exc:
            log.warning("Figure/table extraction failed (non-fatal) | %s", exc)
    else:
        log.info("Skipping figure extraction for document_type=%s | paper_id=%s", document_type, paper["id"])

    return {
        **paper,
        "drive_url": get_file_url(drive_file_id),
        "authors": authors_saved,
        "topics_auto_added": topics_added,
        "references_found": references_found,
    }


@router.post("/preview-url")
def preview_url(body: IngestFromUrlBody):
    """Resolve metadata from a URL without creating any paper — for the upload confirm modal."""
    meta = resolve_url(body.url)
    if not meta or not meta.get("title"):
        raise HTTPException(status_code=422, detail="Could not resolve metadata from the given URL")
    return {
        "title": meta.get("title", ""),
        "authors": meta.get("authors") or [],
        "year": meta.get("year"),
        "doi": meta.get("doi"),
        "abstract": meta.get("abstract"),
        "metadata_source": meta.get("metadata_source", "unknown"),
    }


@router.post("/preview-url/pdf")
async def preview_url_pdf(body: IngestFromUrlBody):
    """
    Download the PDF for a URL and extract metadata from it — no paper is created.
    Used as a fallback in the upload modal when API metadata is incomplete.
    """
    import asyncio as _asyncio
    from services.metadata_from_url import fetch_pdf_bytes
    from services.pdf_parser import extract_metadata

    try:
        pdf_bytes = await _asyncio.to_thread(fetch_pdf_bytes, body.url)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PDF download failed: {exc}")

    if not pdf_bytes:
        raise HTTPException(status_code=422, detail="No open-access PDF available for this URL (only arXiv and bioRxiv are supported)")

    meta = extract_metadata(pdf_bytes)
    return {
        "title": meta.get("title", ""),
        "authors": meta.get("authors") or [],
        "year": meta.get("year"),
        "doi": meta.get("doi"),
        "abstract": meta.get("abstract"),
        "metadata_source": meta.get("metadata_source", "pdf"),
        "_pdf_bytes_size": len(pdf_bytes),
    }


@router.post("/from-url", response_model=IngestOut, status_code=status.HTTP_201_CREATED)
def ingest_from_url(body: IngestFromUrlBody, x_user_name: Optional[str] = Header(None)):
    """Ingest a paper from a URL (arXiv, DOI, PubMed, bioRxiv) — no PDF needed."""
    meta = resolve_url(body.url)
    if not meta or not meta.get("title"):
        raise HTTPException(status_code=422, detail="Could not resolve metadata from the given URL")

    log.info("Ingest from URL | url=%.80s | title=%.60s", body.url, meta.get("title"))

    # Summarize from abstract if available
    summary = None
    if meta.get("abstract"):
        try:
            summary = summarize_paper(meta["abstract"], meta.get("title", ""))
        except Exception as exc:
            log.warning("Summary failed (non-fatal) | %s", exc)

    driver = get_driver()
    # Use MERGE by DOI so that pulling a reference enriches the existing stub
    # instead of creating a duplicate node.
    paper = merge_paper_by_doi(driver, {
        "title": meta.get("title", ""),
        "year": meta.get("year"),
        "doi": meta.get("doi"),
        "abstract": meta.get("abstract"),
        "summary": summary,
        "drive_file_id": None,
        "citation_count": meta.get("citation_count"),
        "metadata_source": meta.get("metadata_source", "url"),
        "raw_text": "",
        "venue": meta.get("venue"),
    })

    log.info("Paper saved from URL | id=%s | title=%.60s", paper["id"], paper.get("title"))

    if x_user_name:
        try:
            link_paper_added_by(driver, paper["id"], x_user_name)
        except Exception as exc:
            log.warning("User attribution failed (non-fatal) | %s", exc)

    # Apply source tag
    tag_paper(driver, paper["id"], "from-url")
    if body.debug:
        tag_paper(driver, paper["id"], "debug")
        log.info("DEBUG IMPORT (from-url) | id=%s | title=%.80s | meta=%s",
                 paper["id"], paper.get("title"),
                 {k: v for k, v in meta.items() if k != "raw_text"})

    authors_detail = meta.get("authors_detail") or []
    aff_map = {d["name"]: d.get("affiliation") for d in authors_detail}
    s2_id_map = {d["name"]: d.get("s2_author_id") for d in authors_detail}

    authors_saved = []
    for name in meta.get("authors", []):
        if not name:
            continue
        person = get_or_create_person_with_affiliation(
            driver, name, aff_map.get(name), s2_id_map.get(name)
        )
        link_author(driver, paper["id"], person["id"])
        authors_saved.append(name)

    # Enrich author profiles (best-effort, uses raw_text from URL ingest if available)
    try:
        from services.person_enrichment import enrich_authors_from_paper
        enrich_authors_from_paper(driver, paper["id"], meta.get("raw_text") or "")
    except Exception as _enrich_exc:
        log.warning("Author enrichment failed (non-fatal) | %s", _enrich_exc)

    topics_added = []
    for topic_name in meta.get("topics", []):
        if not topic_name:
            continue
        link_paper_topic(driver, paper["id"], topic_name)  # takes the name; creates the topic
        topics_added.append(topic_name)

    # AI topic suggestion (best-effort)
    try:
        ai_topics = suggest_topics(
            title=meta.get("title", ""),
            abstract=meta.get("abstract", "") or "",
            summary=summary or "",
        )
        for topic_name in ai_topics:
            if topic_name and topic_name not in topics_added:
                link_paper_topic(driver, paper["id"], topic_name)
                topics_added.append(topic_name)
    except Exception as exc:
        log.warning("AI topic suggestion failed (non-fatal) | %s", exc)

    if body.project_id:
        try:
            add_paper_to_project(driver, paper_id=paper["id"], project_id=body.project_id)
        except Exception:
            pass

    return {
        **paper,
        "drive_url": None,
        "authors": authors_saved,
        "topics_auto_added": topics_added,
        "references_found": [],
    }


@router.post("/from-url-full", response_model=IngestOut, status_code=status.HTTP_201_CREATED)
async def ingest_from_url_full(body: IngestFromUrlBody, x_user_name: Optional[str] = Header(None)):
    """
    Full ingestion pipeline triggered from a URL.
    - arXiv / bioRxiv / medRxiv: downloads the open-access PDF and runs the complete
      pipeline (Drive upload, full-text summary, figure extraction, reference extraction).
    - PubMed / DOI / other: falls back to metadata-only ingest with abstract summary.
    """
    import asyncio as _asyncio
    from services.metadata_from_url import fetch_pdf_bytes

    # 1. Resolve metadata
    meta = resolve_url(body.url)
    if not meta or not meta.get("title"):
        raise HTTPException(status_code=422, detail="Could not resolve metadata from the given URL")

    # 2. Try to download PDF
    try:
        pdf_bytes = await _asyncio.to_thread(fetch_pdf_bytes, body.url)
    except Exception as exc:
        log.warning("PDF download failed (non-fatal) | url=%s | %s", body.url, exc)
        pdf_bytes = None

    driver = get_driver()

    if pdf_bytes:
        log.info("Full PDF pipeline | url=%.80s | size=%d bytes", body.url, len(pdf_bytes))
        pdf_meta = extract_metadata(pdf_bytes)
        raw_text = pdf_meta.get("raw_text", "")
        # Merge: API metadata wins, but only if it actually has data.
        # Empty list/string from a failed API lookup must NOT override
        # good data extracted from the PDF.
        merged = dict(pdf_meta)
        for k, v in meta.items():
            if k == "raw_text":
                continue
            if v is None:
                continue
            if isinstance(v, (list, str)) and not v:
                continue  # skip empty list / empty string — keep PDF-extracted value
            merged[k] = v
        merged["raw_text"] = raw_text
        if not merged.get("authors") or not merged.get("abstract"):
            log.warning("Metadata still incomplete after merge | authors=%s abstract_len=%d",
                        bool(merged.get("authors")), len(merged.get("abstract") or ""))

        filename = f"{merged.get('title', 'paper')[:60]}.pdf"
        try:
            drive_file_id = upload_pdf(pdf_bytes, filename)
        except Exception as exc:
            log.error("Drive upload failed | %s", exc)
            raise HTTPException(status_code=503, detail=f"Drive upload failed: {exc}")

        summary = None
        try:
            summary = summarize_paper(raw_text, merged.get("title", ""), body.summary_instructions or None)
        except Exception as exc:
            log.warning("Summary failed (non-fatal) | %s", exc)

        existing = find_duplicate(driver, doi=merged.get("doi"), title=merged.get("title", ""))
        if existing and existing.get("drive_file_id"):
            import json as _json
            raise HTTPException(status_code=409, detail=_json.dumps({
                "message": "Paper already exists in your library",
                "existing_id": existing["id"],
                "existing_title": existing.get("title", ""),
            }))

        save_data = {
            "title": merged.get("title", ""),
            "year": merged.get("year"),
            "doi": merged.get("doi"),
            "abstract": merged.get("abstract"),
            "summary": summary,
            "drive_file_id": drive_file_id,
            "citation_count": merged.get("citation_count"),
            "metadata_source": merged.get("metadata_source", "url"),
            "raw_text": raw_text,
            "venue": merged.get("venue"),
        }
        paper = merge_paper_by_doi(driver, save_data) if merged.get("doi") else create_paper(driver, save_data)
        if x_user_name:
            try:
                link_paper_added_by(driver, paper["id"], x_user_name)
            except Exception as exc:
                log.warning("User attribution failed (non-fatal) | %s", exc)
        tag_paper(driver, paper["id"], "from-url")
        if body.debug:
            tag_paper(driver, paper["id"], "debug")
            log.info("DEBUG IMPORT (from-url-full PDF) | id=%s | title=%.80s | meta=%s",
                     paper["id"], paper.get("title"),
                     {k: v for k, v in merged.items() if k not in ("raw_text", "authors_detail")})

        authors_detail = merged.get("authors_detail") or []
        aff_map = {d["name"]: d.get("affiliation") for d in authors_detail}
        s2_id_map = {d["name"]: d.get("s2_author_id") for d in authors_detail}
        missing = [n for n in merged.get("authors", []) if n and not aff_map.get(n)]
        if missing and raw_text:
            try:
                aff_map.update(extract_affiliations_with_litellm(missing, raw_text))
            except Exception:
                pass

        authors_saved = []
        for name in merged.get("authors", []):
            if not name:
                continue
            person = get_or_create_person_with_affiliation(
                driver, name, aff_map.get(name), s2_id_map.get(name)
            )
            link_author(driver, paper["id"], person["id"])
            authors_saved.append(name)

        topics_added = []
        for topic_name in merged.get("topics", []):
            if not topic_name:
                continue
            link_paper_topic(driver, paper["id"], topic_name)  # takes the name; creates the topic
            topics_added.append(topic_name)
        try:
            ai_topics = suggest_topics(title=merged.get("title", ""), abstract=merged.get("abstract", "") or "", summary=summary or "")
            for t in ai_topics:
                if t and t not in topics_added:
                    link_paper_topic(driver, paper["id"], t)
                    topics_added.append(t)
        except Exception:
            pass

        if body.project_id:
            try:
                add_paper_to_project(driver, paper_id=paper["id"], project_id=body.project_id)
            except Exception:
                pass

        references_found = []
        try:
            references_found = extract_references(raw_text, merged.get("doi"))
        except Exception as exc:
            log.warning("Reference extraction failed (non-fatal) | %s", exc)

        try:
            figs = extract_figures(pdf_bytes, caption_method="ollama").get("figures", [])
            for i, fig in enumerate(figs):
                fig_filename = f"{paper['id']}_p{fig['page_number']}_{i+1}.png"
                fig_drive_id = upload_image(fig["image_bytes"], fig_filename)
                create_figure(driver, {
                    "paper_id": paper["id"],
                    "figure_number": fig["figure_number"],
                    "caption": fig["caption"],
                    "drive_file_id": fig_drive_id,
                    "page_number": fig["page_number"],
                })
            log.info("Figures extracted | count=%d | paper_id=%s", len(figs), paper["id"])
        except Exception as exc:
            log.warning("Figure extraction failed (non-fatal) | %s", exc)

        return {
            **paper,
            "drive_url": get_file_url(drive_file_id),
            "authors": authors_saved,
            "topics_auto_added": topics_added,
            "references_found": references_found,
            "pdf_fetched": True,
        }

    else:
        # No PDF available — fall back to metadata-only (same as /from-url)
        log.info("No PDF available, falling back to metadata-only | url=%.80s", body.url)
        summary = None
        if meta.get("abstract"):
            try:
                summary = summarize_paper(meta["abstract"], meta.get("title", ""), body.summary_instructions or None)
            except Exception as exc:
                log.warning("Summary failed (non-fatal) | %s", exc)

        paper = merge_paper_by_doi(driver, {
            "title": meta.get("title", ""),
            "year": meta.get("year"),
            "doi": meta.get("doi"),
            "abstract": meta.get("abstract"),
            "summary": summary,
            "drive_file_id": None,
            "citation_count": meta.get("citation_count"),
            "metadata_source": meta.get("metadata_source", "url"),
            "raw_text": "",
            "venue": meta.get("venue"),
        })
        if x_user_name:
            try:
                link_paper_added_by(driver, paper["id"], x_user_name)
            except Exception as exc:
                log.warning("User attribution failed (non-fatal) | %s", exc)
        tag_paper(driver, paper["id"], "from-url")
        if body.debug:
            tag_paper(driver, paper["id"], "debug")
            log.info("DEBUG IMPORT (from-url-full fallback) | id=%s | title=%.80s | meta=%s",
                     paper["id"], paper.get("title"),
                     {k: v for k, v in meta.items() if k != "raw_text"})

        authors_saved = []
        for name in meta.get("authors", []):
            if not name:
                continue
            # No s2_author_id available in these basic imports
            person = get_or_create_person_with_affiliation(driver, name, None, None)
            link_author(driver, paper["id"], person["id"])
            authors_saved.append(name)

        topics_added = []
        for topic_name in meta.get("topics", []):
            if not topic_name:
                continue
            link_paper_topic(driver, paper["id"], topic_name)  # takes the name; creates the topic
            topics_added.append(topic_name)
        try:
            ai_topics = suggest_topics(title=meta.get("title", ""), abstract=meta.get("abstract", "") or "", summary=summary or "")
            for t in ai_topics:
                if t and t not in topics_added:
                    link_paper_topic(driver, paper["id"], t)
                    topics_added.append(t)
        except Exception:
            pass

        if body.project_id:
            try:
                add_paper_to_project(driver, paper_id=paper["id"], project_id=body.project_id)
            except Exception:
                pass

        references_found = []
        try:
            references_found = extract_references("", meta.get("doi"))
        except Exception as exc:
            log.warning("Reference extraction failed (non-fatal) | %s", exc)

        return {
            **paper,
            "drive_url": None,
            "authors": authors_saved,
            "topics_auto_added": topics_added,
            "references_found": references_found,
            "pdf_fetched": False,
        }


@router.delete("/debug-cleanup")
def debug_cleanup():
    """Delete all papers tagged 'debug' (figures, Drive files, notes, Neo4j nodes)."""
    driver = get_driver()
    with driver.session() as session:
        result = session.run(
            "MATCH (p:Paper)-[:TAGGED]->(t:Tag {name: 'debug'}) "
            "RETURN p.id AS id, p.drive_file_id AS drive_file_id",
        )
        debug_papers = [{"id": r["id"], "drive_file_id": r["drive_file_id"]} for r in result]

    deleted = 0
    figures_deleted = 0
    for p in debug_papers:
        paper_id = p["id"]
        # Delete figures from Drive + Neo4j
        figs = list_figures(driver, paper_id)
        for fig in figs:
            if fig.get("drive_file_id"):
                try:
                    delete_file(fig["drive_file_id"])
                except Exception as exc:
                    log.warning("Figure Drive delete failed | %s", exc)
        if figs:
            delete_figures_for_paper(driver, paper_id)
            figures_deleted += len(figs)
        # Delete note
        with driver.session() as session:
            session.run(
                "MATCH (n:Note)-[:ABOUT]->(p:Paper {id: $id}) DETACH DELETE n",
                id=paper_id,
            )
        # Delete PDF from Drive
        if p.get("drive_file_id"):
            try:
                delete_file(p["drive_file_id"])
            except Exception as exc:
                log.warning("Drive delete failed (non-fatal) | %s", exc)
        # Delete paper node
        delete_paper(driver, paper_id)
        deleted += 1
        log.info("DEBUG cleanup deleted | id=%s", paper_id)

    log.info("Debug cleanup complete | papers=%d | figures=%d", deleted, figures_deleted)
    return {"deleted": deleted, "figures_deleted": figures_deleted}


@router.get("/random", response_model=PaperOut)
def get_random_paper(reading_status: Optional[str] = None):
    """Return a random paper from the library, optionally filtered by reading_status."""
    paper = random_paper(get_driver(), reading_status=reading_status or None)
    if not paper:
        raise HTTPException(status_code=404, detail="No papers found")
    return paper


@router.get("", response_model=list[PaperOut])
def list_all(skip: int = 0, limit: int = 10000):
    return list_papers(get_driver(), skip=skip, limit=limit)


@router.get("/{paper_id}/projects")
def get_paper_projects(paper_id: str):
    from db.queries.visibility import can_see_paper

    driver = get_driver()
    if not can_see_paper(driver, paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    with driver.session() as session:
        result = session.run(
            "MATCH (p:Paper {id: $id})-[:IN_PROJECT]->(proj:Project) RETURN proj",
            id=paper_id,
        )
        return [dict(r["proj"]) for r in result]


@router.get("/{paper_id}", response_model=PaperOut)
def get_one(paper_id: str):
    from db.queries.visibility import can_see_paper

    driver = get_driver()
    if not can_see_paper(driver, paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


@router.patch("/{paper_id}", response_model=PaperOut)
def update(paper_id: str, body: PaperUpdate):
    data = {k: v for k, v in body.model_dump().items() if k in body.model_fields_set}
    paper = update_paper(get_driver(), paper_id, data)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


@router.delete("/{paper_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(paper_id: str):
    """Delete the paper, its note, claims, figures, highlights and PDF (services/paper_delete.py)."""
    from services.paper_delete import delete_paper_completely

    if not delete_paper_completely(get_driver(), paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")


@router.post("/{paper_id}/reextract-metadata")
def reextract_metadata_endpoint(paper_id: str):
    """Re-extract all metadata fields from the stored raw_text using the full pipeline."""
    from services.pdf_parser import (
        find_doi, extract_metadata_with_llm, strip_line_numbers,
        extract_abstract_from_text, extract_abstract_with_ai,
    )
    from services.metadata_lookup import (
        lookup_semantic_scholar, lookup_crossref, search_semantic_scholar_by_title,
    )

    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw_text = paper.get("raw_text") or ""
    if not raw_text.strip():
        raise HTTPException(
            status_code=422,
            detail="No extracted text stored for this paper — upload the PDF first",
        )

    # Layer 1: DOI-based API lookup
    doi = paper.get("doi") or find_doi(raw_text)
    extracted: dict = {}
    if doi:
        extracted = lookup_semantic_scholar(doi) or lookup_crossref(doi) or {}

    # Layer 2: LLM fallback
    if not extracted.get("title"):
        llm = extract_metadata_with_llm(strip_line_numbers(raw_text)[:3000])
        if llm and llm.get("title"):
            extracted = llm
            # Try S2 title upgrade
            s2 = search_semantic_scholar_by_title(llm["title"])
            if s2:
                extracted = s2

    if not extracted:
        raise HTTPException(status_code=422, detail="Could not extract metadata from the stored text")

    # Fill abstract if missing
    if not extracted.get("abstract"):
        extracted["abstract"] = (
            extract_abstract_from_text(raw_text)
            or extract_abstract_with_ai(raw_text[:6000])
        )

    extracted.pop("raw_text", None)
    extracted.pop("authors_detail", None)
    log.info("Metadata re-extracted | paper=%s | source=%s", paper_id, extracted.get("metadata_source"))
    return extracted


@router.post("/{paper_id}/reextract-abstract")
def reextract_abstract(paper_id: str):
    """Re-extract abstract, year, and DOI from the paper's stored raw_text."""
    from services.pdf_parser import extract_abstract_from_text, extract_abstract_with_ai, find_doi, YEAR_RE, _PUBLISHED_YEAR_RE
    from services.metadata_lookup import lookup_semantic_scholar, lookup_crossref

    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw_text = paper.get("raw_text") or ""
    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="No extracted text stored for this paper — upload the PDF first")

    document_type = paper.get("document_type")
    abstract = extract_abstract_from_text(raw_text) or extract_abstract_with_ai(raw_text[:6000], document_type=document_type)
    if not abstract:
        raise HTTPException(status_code=422, detail="Could not extract an abstract from the paper text")

    # Re-detect DOI from first page text (most likely location)
    doi = find_doi(raw_text[:4000]) or paper.get("doi")

    # Resolve year: API lookup is most reliable if we have a DOI
    year: int | None = None
    if doi:
        api = lookup_semantic_scholar(doi) or lookup_crossref(doi)
        if api:
            year = api.get("year")
            # Also prefer API's DOI (it may be cleaner than what we extracted)
            doi = api.get("doi") or doi

    # Fallback: prefer "published online: YYYY" over first year in text
    if not year:
        pub = _PUBLISHED_YEAR_RE.search(raw_text[:3000])
        year_match = pub or YEAR_RE.search(raw_text[:3000])
        year = int((pub.group(1) if pub else year_match.group())) if year_match else None

    patch: dict = {"abstract": abstract}
    if doi:
        patch["doi"] = doi
    if year:
        patch["year"] = year

    updated = update_paper(driver, paper_id, patch)
    return {
        "abstract": updated.get("abstract") if updated else abstract,
        "doi": updated.get("doi") if updated else doi,
        "year": updated.get("year") if updated else year,
    }


@router.post("/{paper_id}/ai-extract-metadata")
def ai_extract_metadata(paper_id: str):
    """Use LLM (Claude Work → Claude personal → Ollama) to extract abstract, year, and DOI."""
    import json as _json
    import anthropic as _anthropic
    import httpx as _httpx
    from config import settings as _settings
    from services.user_ai_config import get_effective_ai_config
    from services.pdf_parser import find_doi, YEAR_RE, _PUBLISHED_YEAR_RE

    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw_text = paper.get("raw_text") or ""
    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="No extracted text stored for this paper — upload the PDF first")

    snippet = raw_text[:5000]
    prompt = (
        "Extract metadata from this academic paper text.\n"
        "Return ONLY valid JSON with exactly these keys:\n"
        "abstract (string or null), year (integer or null), doi (string or null).\n"
        "For the DOI include the full DOI string starting with '10.' (not a URL).\n"
        "If you cannot find a field, return null for that field.\n\n"
        f"Paper text:\n{snippet}"
    )

    def _parse_llm_json(raw: str) -> dict:
        raw = raw.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return _json.loads(raw.strip())

    result: dict | None = None
    _ai_cfg = get_effective_ai_config()
    _work_key = (_ai_cfg.get("anthropic_work_api_key") or "").strip()
    _work_base = (_ai_cfg.get("anthropic_work_base_url") or "").strip()
    _personal_key = (_ai_cfg.get("anthropic_api_key") or "").strip()

    # LiteLLM / Gemma (primary)
    try:
        from services.litellm_client import chat_completion

        raw = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            json_mode=True,
        )
        result = _parse_llm_json(raw)
    except Exception as exc:
        log.debug("LiteLLM ai-extract failed: %s", exc)

    # Fallback: Claude Work
    if result is None and _work_key:
        try:
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            kwargs: dict = {"api_key": _work_key, "http_client": _httpx.Client(verify=False)}
            if _work_base:
                kwargs["base_url"] = _work_base
            client = _anthropic.Anthropic(**kwargs)
            resp = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            result = _parse_llm_json(resp.content[0].text)
        except Exception as exc:
            log.debug("Claude Work ai-extract failed: %s", exc)

    # Fallback: Claude personal
    if result is None and _personal_key:
        try:
            client = _anthropic.Anthropic(api_key=_personal_key)
            resp = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            result = _parse_llm_json(resp.content[0].text)
        except Exception as exc:
            log.debug("Claude personal ai-extract failed: %s", exc)

    if result is None:
        raise HTTPException(status_code=503, detail="All LLM backends failed — check Claude Work, personal API key, and LiteLLM")

    abstract = str(result.get("abstract") or "").strip() or None
    year_raw = result.get("year")
    year: int | None = int(year_raw) if year_raw and str(year_raw).isdigit() else None
    doi_raw = str(result.get("doi") or "").strip()
    doi: str | None = doi_raw if doi_raw.startswith("10.") else None

    # If LLM missed DOI/year, fall back to regex on raw text
    if not doi:
        doi = find_doi(raw_text[:4000]) or paper.get("doi") or None
    if not year:
        pub = _PUBLISHED_YEAR_RE.search(raw_text[:3000])
        ym = pub or YEAR_RE.search(raw_text[:3000])
        year = int((pub.group(1) if pub else ym.group())) if ym else paper.get("year")

    patch: dict = {}
    if abstract:
        patch["abstract"] = abstract
    if doi:
        patch["doi"] = doi
    if year:
        patch["year"] = year

    if patch:
        updated = update_paper(driver, paper_id, patch)
        if updated:
            abstract = updated.get("abstract", abstract)
            doi = updated.get("doi", doi)
            year = updated.get("year", year)

    return {"abstract": abstract, "doi": doi, "year": year}


@router.post("/{paper_id}/regenerate-summary")
def regenerate_summary(paper_id: str):
    """Re-generate the AI summary for a single paper using its stored raw_text."""
    from services.ai import summarize_paper
    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    raw_text = paper.get("raw_text") or ""
    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="No extracted text available for this paper")
    summary = summarize_paper(raw_text, paper.get("title", ""))
    updated = update_paper(driver, paper_id, {"summary": summary})
    return {"summary": updated.get("summary") if updated else summary}


@router.post("/{paper_id}/refetch-pdf")
async def refetch_pdf(paper_id: str):
    """
    Download the PDF for a paper (arXiv / bioRxiv / medRxiv) using its stored DOI,
    run the full extraction pipeline, and update the paper + authors in Neo4j.
    Returns the updated paper with refreshed authors list.
    """
    import asyncio as _asyncio
    from services.metadata_from_url import fetch_pdf_bytes, _ARXIV_ID
    from services.pdf_parser import extract_metadata
    from services.drive import upload_pdf, get_file_url
    from services.ai import summarize_paper
    from db.queries.people import get_or_create_person_with_affiliation, link_author

    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    doi = paper.get("doi") or ""
    if not doi:
        raise HTTPException(status_code=422, detail="Paper has no DOI — cannot locate PDF")

    # Build a URL we can pass to fetch_pdf_bytes
    if doi.lower().startswith("arxiv:"):
        arxiv_id = doi[len("arxiv:"):]
        source_url = f"https://arxiv.org/abs/{arxiv_id}"
    elif doi.startswith("10.1101/"):
        source_url = f"https://www.biorxiv.org/content/{doi}"
    else:
        raise HTTPException(
            status_code=422,
            detail=f"PDF auto-download is only supported for arXiv and bioRxiv papers (DOI: {doi})"
        )

    # Download PDF
    try:
        pdf_bytes = await _asyncio.to_thread(fetch_pdf_bytes, source_url)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PDF download failed: {exc}")

    if not pdf_bytes:
        raise HTTPException(status_code=502, detail="Could not download PDF — source may not provide open-access PDFs")

    log.info("refetch-pdf | paper_id=%s | doi=%s | size=%d bytes", paper_id, doi, len(pdf_bytes))

    # Run full extraction
    pdf_meta = extract_metadata(pdf_bytes)
    raw_text = pdf_meta.get("raw_text", "")

    # Merge: keep existing non-empty paper fields, fill gaps from PDF extraction
    updates: dict = {}
    if not paper.get("abstract") and pdf_meta.get("abstract"):
        updates["abstract"] = pdf_meta["abstract"]
    if not paper.get("venue") and pdf_meta.get("venue"):
        updates["venue"] = pdf_meta["venue"]
    if not paper.get("year") and pdf_meta.get("year"):
        updates["year"] = pdf_meta["year"]

    # Always update raw_text and drive_file_id (re-upload PDF)
    try:
        filename = f"{paper.get('title', 'paper')[:60]}.pdf"
        drive_file_id = upload_pdf(pdf_bytes, filename)
        updates["drive_file_id"] = drive_file_id
    except Exception as exc:
        log.warning("Drive upload failed (non-fatal) | %s", exc)
        drive_file_id = paper.get("drive_file_id")

    updates["raw_text"] = raw_text

    # Summary skipped on PDF re-fetch — generate manually via POST /{id}/regenerate-summary

    updated_paper = update_paper(driver, paper_id, updates)

    # Save authors (PDF extraction may have found them)
    authors_saved = []
    with driver.session() as _sess:
        existing_author_ids = {
            r["person"]["id"]
            for r in _sess.run(
                "MATCH (p:Paper {id:$id})-[:AUTHORED_BY]->(a:Person) RETURN a AS person", id=paper_id
            )
        }
    for name in pdf_meta.get("authors") or []:
        if not name:
            continue
        aff_map = {d["name"]: d.get("affiliation") for d in (pdf_meta.get("authors_detail") or [])}
        s2_id_map = {d["name"]: d.get("s2_author_id") for d in (pdf_meta.get("authors_detail") or [])}
        person = get_or_create_person_with_affiliation(
            driver, name, aff_map.get(name), s2_id_map.get(name)
        )
        if person["id"] not in existing_author_ids:
            link_author(driver, paper_id, person["id"])
        authors_saved.append(name)

    log.info("refetch-pdf done | paper_id=%s | authors=%d | raw_text_len=%d",
             paper_id, len(authors_saved), len(raw_text))

    return {
        **(updated_paper or paper),
        "authors": authors_saved,
        "drive_url": get_file_url(drive_file_id) if drive_file_id else None,
    }


@router.post("/{paper_id}/upload-pdf")
async def upload_pdf_for_paper(paper_id: str, file: UploadFile = File(...)):
    """
    Attach a manually uploaded PDF to an existing paper.
    Runs the full extraction pipeline, uploads to Drive, and enriches the paper record.
    """
    from services.ai import summarize_paper as _summarize

    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")

    log.info("upload-pdf | paper_id=%s | size=%d bytes", paper_id, len(pdf_bytes))

    # Run extraction
    pdf_meta = extract_metadata(pdf_bytes)
    raw_text = pdf_meta.get("raw_text", "")

    # Fill gaps: only update fields that are currently missing on the paper
    updates: dict = {}
    for field in ("abstract", "venue", "year"):
        if not paper.get(field) and pdf_meta.get(field):
            updates[field] = pdf_meta[field]

    # Upload PDF to Drive
    try:
        filename = f"{paper.get('title', 'paper')[:60]}.pdf"
        drive_file_id = upload_pdf(pdf_bytes, filename)
        updates["drive_file_id"] = drive_file_id
    except Exception as exc:
        log.warning("Drive upload failed (non-fatal) | %s", exc)
        drive_file_id = paper.get("drive_file_id")

    updates["raw_text"] = raw_text

    # Summary skipped on PDF attach — generate manually via POST /{id}/regenerate-summary

    update_paper(driver, paper_id, updates)

    # Add any new authors found by PDF extraction
    with driver.session() as _sess:
        existing_author_ids = {
            r["person"]["id"]
            for r in _sess.run(
                "MATCH (p:Paper {id:$id})-[:AUTHORED_BY]->(a:Person) RETURN a AS person", id=paper_id
            )
        }
    authors_added = []
    for name in pdf_meta.get("authors") or []:
        if not name:
            continue
        aff_map = {d["name"]: d.get("affiliation") for d in (pdf_meta.get("authors_detail") or [])}
        s2_id_map = {d["name"]: d.get("s2_author_id") for d in (pdf_meta.get("authors_detail") or [])}
        person = get_or_create_person_with_affiliation(
            driver, name, aff_map.get(name), s2_id_map.get(name)
        )
        if person["id"] not in existing_author_ids:
            link_author(driver, paper_id, person["id"])
            authors_added.append(name)

    log.info("upload-pdf done | paper_id=%s | new_authors=%d | raw_text_len=%d",
             paper_id, len(authors_added), len(raw_text))

    return {
        "drive_url": get_file_url(drive_file_id) if drive_file_id else None,
        "authors_added": authors_added,
        "raw_text_len": len(raw_text),
    }


@router.get("/{paper_id}/note", response_model=NoteOut)
def get_note(paper_id: str):
    note = get_paper_note(get_driver(), paper_id)
    if not note:
        raise HTTPException(status_code=404, detail="No note for this paper")
    return note


@router.post("/{paper_id}/chat", response_model=ChatResponse)
def chat(paper_id: str, body: ChatRequest, x_user_name: Optional[str] = Header(None)):
    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    raw_text = paper.get("raw_text") or ""
    history = [{"role": m.role, "content": m.content} for m in body.history]
    kwargs = dict(paper_text=raw_text, paper_title=paper.get("title", ""), question=body.question, history=history)
    if body.model in ("litellm", "ollama"):
        answer = chat_with_paper_litellm(**kwargs)
    elif body.model == "claude-work":
        answer = chat_with_paper_work(**kwargs)
    elif body.model == "claude-code":
        answer = chat_with_paper_claude_code(**kwargs)
    else:
        answer = chat_with_paper(**kwargs)

    # Persist to Neo4j conversation
    conv_id = body.conversation_id
    try:
        if not conv_id:
            title = body.question[:60] + ("…" if len(body.question) > 60 else "")
            conv = create_paper_conversation(driver, paper_id, title)
            conv_id = conv["id"]
            if x_user_name:
                link_conversation_started_by(driver, conv_id, x_user_name)
        add_message(driver, conv_id, "user", body.question, [paper_id],
                    estimate_tokens_approx(body.question))
        add_message(driver, conv_id, "assistant", answer, [paper_id],
                    estimate_tokens_approx(answer))
    except Exception as exc:
        log.warning("Failed to save chat to Neo4j: %s", exc)

    return {"answer": answer, "conversation_id": conv_id}


# ── Per-paper conversation management ─────────────────────────────────────────

class ConvRenameBody(BaseModel):
    title: str


@router.get("/{paper_id}/conversations")
def list_convs(paper_id: str):
    return list_paper_conversations(get_driver(), paper_id)


@router.get("/{paper_id}/conversations/{conv_id}/messages")
def get_conv_messages(paper_id: str, conv_id: str):
    return get_messages(get_driver(), conv_id)


@router.patch("/{paper_id}/conversations/{conv_id}")
def rename_conv(paper_id: str, conv_id: str, body: ConvRenameBody):
    return rename_conversation(get_driver(), conv_id, body.title)


@router.post("/{paper_id}/conversations/{conv_id}/compact")
def compact_conv(paper_id: str, conv_id: str):
    from services.ai import summarize_paper
    msgs = get_messages(get_driver(), conv_id)
    if not msgs:
        raise HTTPException(status_code=404, detail="Conversation not found or empty")
    full_text = "\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in msgs)
    try:
        summary = summarize_paper(full_text, title="Conversation summary")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Summarisation failed: {exc}")
    return compact_conversation(get_driver(), conv_id, summary)


@router.delete("/{paper_id}/conversations/{conv_id}", status_code=204)
def delete_conv(paper_id: str, conv_id: str):
    delete_conversation(get_driver(), conv_id)


@router.put("/{paper_id}/note", response_model=NoteOut)
def put_note(paper_id: str, body: NoteBody, x_user_name: Optional[str] = Header(None)):
    if not get_paper(get_driver(), paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    note = upsert_note(get_driver(), paper_id, body.content)
    mentions = parse_mentions(body.content)
    set_mentions(get_driver(), note["id"], mentions["people"], mentions["topics"])
    if x_user_name:
        try:
            link_note_written_by(get_driver(), note["id"], x_user_name)
        except Exception as exc:
            log.warning("Note user attribution failed (non-fatal) | %s", exc)
    return note


# ── Reference endpoints ────────────────────────────────────────────────────────

@router.get("/{paper_id}/extract-references")
def extract_refs(paper_id: str):
    """Run reference extraction on the stored raw_text (on-demand, no saving)."""
    paper = get_paper(get_driver(), paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    raw_text = paper.get("raw_text") or ""
    doi = paper.get("doi")
    refs = extract_references(raw_text, doi)
    return {"references": refs}


@router.get("/{paper_id}/ai-extract-references")
def ai_extract_refs(paper_id: str):
    """Extract references using Claude Work → Claude personal → Ollama (forces AI path)."""
    from services.references import extract_references_ai_full
    paper = get_paper(get_driver(), paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    raw_text = paper.get("raw_text") or ""
    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="No extracted text stored for this paper — upload the PDF first")
    refs = extract_references_ai_full(raw_text)
    return {"references": refs}


@router.post("/{paper_id}/references", status_code=status.HTTP_201_CREATED)
def save_references(paper_id: str, body: ReferencesBody):
    """Save a confirmed list of references as CITES relationships."""
    if not get_paper(get_driver(), paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    driver = get_driver()
    saved = []
    for ref in body.references:
        node, created = create_or_link_reference(driver, paper_id, ref)
        if node:
            # Only stubs this call created are citation stubs; an existing paper keeps its tags.
            if created:
                tag_paper(driver, node["id"], "from-references")
            saved.append(node)
    return {"saved": len(saved)}


@router.get("/{paper_id}/references")
def list_references(paper_id: str):
    """Return CITES outgoing (references) and incoming (cited-by) lists."""
    if not get_paper(get_driver(), paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    driver = get_driver()
    return {
        "references": get_references(driver, paper_id),
        "cited_by":   get_cited_by(driver, paper_id),
    }


@router.get("/{paper_id}/pdf")
def stream_pdf(paper_id: str):
    """Proxy the PDF from Google Drive so the browser can render it without third-party cookies."""
    paper = get_paper(get_driver(), paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    file_id = paper.get("drive_file_id")
    if not file_id:
        raise HTTPException(status_code=404, detail="No PDF stored for this paper")
    try:
        pdf_bytes = download_pdf(file_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Drive download failed: {exc}")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": "inline"},
    )


@router.get("/{paper_id}/bibtex")
def paper_bibtex(paper_id: str):
    """Return a BibTeX entry for a single paper."""
    paper = get_paper(get_driver(), paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    driver = get_driver()
    with driver.session() as session:
        result = session.run(
            "MATCH (p:Paper {id: $id})<-[:AUTHORED_BY]-(a:Person) RETURN collect(a.name) AS authors",
            id=paper_id,
        )
        record = result.single()
        authors = record["authors"] if record else []

    key = paper_id[:8]
    title = _bib_escape(paper.get("title") or "")
    year = paper.get("year", "")
    doi = paper.get("doi") or ""
    venue = paper.get("venue") or ""
    author_str = " and ".join(authors)

    lines = [f"@article{{{key},"]
    lines.append(f"  title  = {{{title}}},")
    if author_str:
        lines.append(f"  author = {{{author_str}}},")
    if year:
        lines.append(f"  year   = {{{year}}},")
    if doi:
        lines.append(f"  doi    = {{{doi}}},")
    if venue:
        lines.append(f"  journal = {{{_bib_escape(venue)}}},")
    lines.append("}")

    content = "\n".join(lines) + "\n"
    filename = f"{_safe_filename(paper.get('title') or key)}.bib"
    return Response(
        content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\""},
    )


def _bib_escape(s: str) -> str:
    return s.replace("{", "\\{").replace("}", "\\}")


def _safe_filename(title: str, max_len: int = 40) -> str:
    """Return a filesystem-safe version of *title*, stripped to *max_len* chars."""
    return "".join(c for c in title[:max_len] if c.isalnum() or c in " _-").strip()


def _generate_search_keywords(driver, paper: dict) -> list[str]:
    """
    Return 5-8 search keywords for a paper.
    Priority: existing topics from DB → Claude Haiku on title+abstract → title words.
    """
    # 1. Topics already linked in the graph
    try:
        with driver.session() as session:
            records = session.run(
                "MATCH (p:Paper {id: $id})-[:ABOUT]->(t:Topic) RETURN t.name AS name",
                id=paper["id"],
            ).data()
        topics = [r["name"] for r in records if r.get("name")]
        if len(topics) >= 3:
            return topics[:8]
    except Exception:
        topics = []

    # 2. LiteLLM / Gemma — extract keywords from title + abstract
    title = paper.get("title", "")
    abstract = paper.get("abstract") or paper.get("summary") or ""
    if title and (abstract or len(title) > 20):
        try:
            from services.litellm_client import chat_completion
            snippet = f"Title: {title}\n\nAbstract: {abstract[:1500]}"
            prompt = (
                "Return a JSON array of 6-8 short search keywords (2-4 words each) "
                "that best describe the research topic of this paper. "
                "Focus on methods, domains, and concepts — not author names or venues. "
                "Return ONLY the JSON array, no explanation.\n\n" + snippet
            )
            import json, re
            raw = chat_completion(
                messages=[{"role": "user", "content": prompt}],
                json_mode=True,
            ).strip()
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)
            kws = json.loads(raw)
            if isinstance(kws, list) and kws:
                combined = topics + [str(k) for k in kws if k]
                seen: set[str] = set()
                deduped = []
                for k in combined:
                    lo = k.lower()
                    if lo not in seen:
                        seen.add(lo)
                        deduped.append(k)
                return deduped[:8]
        except Exception as exc:
            log.debug("Keyword generation via LiteLLM failed: %s", exc)

    # 3. Fallback: significant words from the title
    import re as _re
    stopwords = {"a", "an", "the", "of", "in", "on", "for", "with", "and", "or",
                 "to", "is", "are", "via", "using", "based", "from", "by", "its"}
    words = [w for w in _re.findall(r"[A-Za-z]{4,}", title) if w.lower() not in stopwords]
    return (topics + words)[:8]


@router.get("/{paper_id}/related")
def get_related(paper_id: str, limit: int = 10):
    """Get related papers from Semantic Scholar recommendations."""
    driver = get_driver()
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    doi = paper.get("doi")
    if not doi:
        return {"related": [], "reason": "no_doi", "source_paper_id": paper_id}

    # Get recommendations from S2
    related = get_related_papers(doi, limit)

    # Mark which are already in library
    if related:
        dois = [r["doi"] for r in related if r.get("doi")]
        if dois:
            with driver.session() as session:
                records = session.run(
                    """
                    UNWIND $dois AS d
                    MATCH (p:Paper {doi: d})
                    RETURN d AS doi, p.id AS id
                    """,
                    dois=dois,
                ).data()

            doi_map = {rec["doi"]: rec["id"] for rec in records}

            for r in related:
                if r.get("doi") and r["doi"] in doi_map:
                    r["in_library"] = True
                    r["library_paper_id"] = doi_map[r["doi"]]

    if related:
        return {"related": related, "source_paper_id": paper_id}

    # S2 returned nothing (paper too new or not indexed) — generate search keywords
    keywords = _generate_search_keywords(driver, paper)
    return {"related": [], "source_paper_id": paper_id, "search_keywords": keywords}
