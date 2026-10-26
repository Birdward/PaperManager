"""Batch backfill operations — apply AI enrichment to existing papers."""
import logging
from fastapi import APIRouter, Depends
from db.connection import get_driver
from db.queries.papers import list_papers
from db.queries.topics import link_paper_topic
from services.auth import require_admin

log = logging.getLogger(__name__)
router = APIRouter(prefix="/backfill", tags=["backfill"], dependencies=[Depends(require_admin)])


@router.post("/topics")
def backfill_topics():
    """Run AI topic suggestion on every paper that currently has no topics."""
    from services.ai import suggest_topics

    driver = get_driver()
    papers = list_papers(driver, skip=0, limit=10_000)

    processed = skipped = errors = 0
    for paper in papers:
        # Check if paper already has topics
        with driver.session() as session:
            count = session.run(
                "MATCH (p:Paper {id: $id})-[:ABOUT]->(:Topic) RETURN count(*) AS c",
                id=paper["id"],
            ).single()["c"]
        if count > 0:
            skipped += 1
            continue

        try:
            topics = suggest_topics(
                title=paper.get("title", ""),
                abstract=paper.get("abstract", "") or "",
                summary=paper.get("summary", "") or "",
            )
            for name in topics:
                if name:
                    link_paper_topic(driver, paper["id"], name)
            processed += 1
            log.info("Backfill topics | paper=%s | topics=%s", paper["id"], topics)
        except Exception as exc:
            log.warning("Backfill topics error | paper=%s | %s", paper["id"], exc)
            errors += 1

    return {"processed": processed, "skipped": skipped, "errors": errors}


@router.post("/summary")
def backfill_summary():
    """Generate AI summaries for papers that have raw text but no summary yet."""
    from services.ai import summarize_paper
    from db.queries.papers import update_paper

    driver = get_driver()
    papers = list_papers(driver, skip=0, limit=10_000)

    processed = skipped = errors = 0
    for paper in papers:
        if paper.get("summary"):
            skipped += 1
            continue
        raw_text = paper.get("raw_text", "") or ""
        if not raw_text.strip():
            skipped += 1
            continue

        try:
            summary = summarize_paper(raw_text, paper.get("title", ""))
            update_paper(driver, paper["id"], {"summary": summary})
            processed += 1
            log.info("Backfill summary | paper=%s", paper["id"])
        except Exception as exc:
            log.warning("Backfill summary error | paper=%s | %s", paper["id"], exc)
            errors += 1

    return {"processed": processed, "skipped": skipped, "errors": errors}


@router.post("/figures")
def backfill_figures(caption_method: str = "ollama"):
    """Extract figures for papers that have a PDF on Drive but no figures yet."""
    from services.figure_extractor import extract_figures
    from services.drive import download_pdf
    from services.ingest_assets import save_figures_and_tables
    from db.queries.figures import list_figures

    driver = get_driver()
    papers = list_papers(driver, skip=0, limit=10_000)

    processed = skipped = errors = 0
    for paper in papers:
        if not paper.get("drive_file_id"):
            skipped += 1
            continue
        existing = list_figures(driver, paper["id"])
        if existing:
            skipped += 1
            continue

        try:
            pdf_bytes = download_pdf(paper["drive_file_id"])
            # extract_figures returns {"figures": [...], "tables": [...]}; save both like an upload.
            extraction = extract_figures(pdf_bytes, caption_method=caption_method)
            n_figs, n_tbls = save_figures_and_tables(driver, paper["id"], extraction)
            processed += 1
            log.info("Backfill figures | paper=%s | figures=%d | tables=%d", paper["id"], n_figs, n_tbls)
        except Exception as exc:
            log.warning("Backfill figures error | paper=%s | %s", paper["id"], exc)
            errors += 1

    return {"processed": processed, "skipped": skipped, "errors": errors}


@router.post("/claims")
def backfill_claims():
    """Extract claims for papers that have raw text but no Claim nodes yet."""
    from services.ai import extract_claims
    from db.queries.claims import create_claims

    driver = get_driver()
    with driver.session() as session:
        rows = session.run(
            "MATCH (p:Paper) WHERE p.raw_text IS NOT NULL AND NOT (p)-[:HAS_CLAIM]->() "
            "RETURN p.id AS id, p.title AS title, p.raw_text AS raw_text"
        )
        candidates = [dict(r) for r in rows]

    processed = skipped = errors = 0
    for paper in candidates:
        raw_text = paper.get("raw_text") or ""
        if not raw_text.strip():
            skipped += 1
            continue
        try:
            claims_data = extract_claims(raw_text, paper.get("title", ""), model="litellm")
            if claims_data:
                create_claims(driver, paper["id"], claims_data)
                log.info("Backfill claims | paper=%s | count=%d", paper["id"], len(claims_data))
            processed += 1
        except Exception as exc:
            log.warning("Backfill claims error | paper=%s | %s", paper["id"], exc)
            errors += 1

    return {"processed": processed, "skipped": skipped, "errors": errors}


@router.post("/embeddings")
def backfill_embeddings():
    """Generate and store vector embeddings for papers that do not have one yet."""
    from services.embeddings import embed_paper

    driver = get_driver()
    with driver.session() as session:
        rows = session.run(
            "MATCH (p:Paper) WHERE p.embedding IS NULL "
            "AND (p.abstract IS NOT NULL OR p.summary IS NOT NULL) "
            "RETURN p.id AS id, p.title AS title, p.abstract AS abstract, p.summary AS summary"
        )
        candidates = [dict(r) for r in rows]

    processed = skipped = errors = 0
    for paper in candidates:
        if not paper.get("title"):
            skipped += 1
            continue
        try:
            embedding = embed_paper(
                title=paper.get("title", ""),
                abstract=paper.get("abstract", "") or "",
                summary=paper.get("summary", "") or "",
            )
            with driver.session() as session:
                session.run(
                    "MATCH (p:Paper {id: $id}) SET p.embedding = $emb",
                    id=paper["id"],
                    emb=embedding,
                )
            processed += 1
            log.info("Backfill embedding | paper=%s", paper["id"])
        except Exception as exc:
            log.warning("Backfill embedding error | paper=%s | %s", paper["id"], exc)
            errors += 1

    return {"processed": processed, "skipped": skipped, "errors": errors}
