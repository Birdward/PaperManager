import sys
import os
import csv
from datetime import datetime, timezone
import io
import json
import logging
import re
import zipfile
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from neo4j import Driver

from db.connection import get_driver
from db.queries.users import is_user_admin
from db.queries.papers import get_paper
from db.queries.notes import get_paper_note
from db.queries.annotations import list_annotations
from db.queries.claims import get_paper_claims
from db.queries.references import get_references, get_cited_by
from db.queries.figures import list_figures
from db.queries.tables import list_tables
from services.auth import get_current_user

log = logging.getLogger(__name__)
router = APIRouter(
    prefix="/export",
    tags=["export"],
    dependencies=[Depends(get_current_user)],
)

SNAPSHOT_FORMAT = "papermanager-graph-snapshot"
SNAPSHOT_VERSION = 1
IMPORT_TMP_LABEL = "__PMImport"
IMPORT_TMP_PROP = "__pm_export_id"

# ── Turtle helpers ────────────────────────────────────────────────────────────

PM   = "http://papermanager.local/ontology#"
PMR  = "http://papermanager.local/resource/"
XSD  = "http://www.w3.org/2001/XMLSchema#"

TURTLE_PREFIXES = """\
@prefix pm:  <http://papermanager.local/ontology#> .
@prefix pmr: <http://papermanager.local/resource/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

"""


def _safe_uri(s: str) -> str:
    """Encode a string for use inside a URI."""
    return re.sub(r"[^A-Za-z0-9_\-]", lambda m: "%" + m.group().encode().hex().upper(), str(s))


def _lit(v) -> str:
    """Serialize a Python value as a Turtle literal."""
    if v is None:
        return None
    if isinstance(v, bool):
        return f'"{str(v).lower()}"^^xsd:boolean'
    if isinstance(v, int):
        return f'"{v}"^^xsd:integer'
    if isinstance(v, float):
        return f'"{v}"^^xsd:decimal'
    s = str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
    return f'"{s}"'


def _node_turtle(uri: str, type_name: str, props: dict, skip: set | None = None) -> list[str]:
    """Build Turtle lines for a single node."""
    skip = skip or set()
    lines = [f"{uri} a pm:{type_name} ;"]
    pairs = []
    for k, v in props.items():
        if k in skip or v is None:
            continue
        lit = _lit(v)
        if lit:
            pairs.append(f'    pm:{k} {lit}')
    if pairs:
        lines.append(" ;\n".join(pairs) + " .")
    else:
        lines[-1] = lines[-1].rstrip(" ;") + " ."
    return lines


def _cypher_ident(value: str) -> str:
    if not value:
        raise HTTPException(status_code=400, detail="Snapshot contains an empty identifier")
    return "`" + value.replace("`", "``") + "`"


def _snapshot_filename() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"papermanager_snapshot_{stamp}.json"


def _build_snapshot(driver: Driver) -> dict:
    snapshot = {
        "format": SNAPSHOT_FORMAT,
        "version": SNAPSHOT_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "nodes": [],
        "relationships": [],
    }

    _SNAPSHOT_SKIP_LABELS = {"User"}
    _SNAPSHOT_STRIP_PROPS = {"password_hash", "anthropic_api_key", "anthropic_work_api_key", "anthropic_work_base_url"}

    with driver.session() as session:
        snapshot["nodes"] = [
            {
                "export_id": record["export_id"],
                "labels": record["labels"],
                "properties": {k: v for k, v in dict(record["props"]).items() if k not in _SNAPSHOT_STRIP_PROPS},
            }
            for record in session.run(
                """
                MATCH (n)
                WHERE NOT any(l IN labels(n) WHERE l IN ['User'])
                RETURN elementId(n) AS export_id, labels(n) AS labels, properties(n) AS props
                ORDER BY export_id
                """
            )
        ]

        # User nodes are not exported, so a relationship to one (MEMBER_OF, ADDED_BY,
        # WROTE, ...) names the user instead; import re-attaches it to that account.
        snapshot["relationships"] = [
            {
                "export_id": record["export_id"],
                "start_export_id": record["start_export_id"],
                "end_export_id": record["end_export_id"],
                "type": record["type"],
                "properties": dict(record["props"]),
                **({"start_user": record["start_user"]} if record.get("start_user") else {}),
                **({"end_user": record["end_user"]} if record.get("end_user") else {}),
            }
            for record in session.run(
                """
                MATCH (a)-[r]->(b)
                RETURN elementId(r) AS export_id,
                       elementId(a) AS start_export_id,
                       elementId(b) AS end_export_id,
                       type(r) AS type,
                       properties(r) AS props,
                       CASE WHEN a:User THEN a.name END AS start_user,
                       CASE WHEN b:User THEN b.name END AS end_user
                ORDER BY export_id
                """
            )
        ]

    return snapshot


def _restore_snapshot(driver: Driver, payload: dict, replace: bool) -> dict:
    if payload.get("format") != SNAPSHOT_FORMAT:
        raise HTTPException(status_code=400, detail="Unsupported snapshot format")
    if payload.get("version") != SNAPSHOT_VERSION:
        raise HTTPException(status_code=400, detail="Unsupported snapshot version")

    nodes = payload.get("nodes")
    relationships = payload.get("relationships")
    if not isinstance(nodes, list) or not isinstance(relationships, list):
        raise HTTPException(status_code=400, detail="Snapshot is missing nodes or relationships")

    counts = {"nodes": 0, "relationships": 0, "notes": 0, "figures": 0, "note_rels": 0, "figure_rels": 0}
    tmp_label = _cypher_ident(IMPORT_TMP_LABEL)

    # Accounts are not part of a snapshot: replacing keeps the existing User nodes
    # (wiping them locked everyone out, the importing admin included), and User nodes
    # in older snapshots are not recreated. Relationships to a user are re-attached by
    # name to the account that exists here, or dropped if there is none.
    user_by_export_id = {
        node.get("export_id"): (node.get("properties") or {}).get("name")
        for node in nodes
        if isinstance(node, dict) and "User" in (node.get("labels") or [])
    }

    def _tx_write(tx):
        if replace:
            log.info("Clearing existing graph (except user accounts) before snapshot restore")
            tx.run("MATCH (n) WHERE NOT n:User DETACH DELETE n").consume()

        # Track special node types for validation
        note_count = 0
        figure_count = 0
        notes_with_content = 0
        figures_with_drive = 0

        for node in nodes:
            export_id = node.get("export_id")
            labels = node.get("labels")
            properties = node.get("properties")
            if not isinstance(export_id, str) or not isinstance(labels, list) or not isinstance(properties, dict):
                raise HTTPException(status_code=400, detail="Snapshot contains an invalid node entry")

            # Validate and log special node types
            if "Note" in labels:
                note_count += 1
                if properties.get("content"):
                    notes_with_content += 1
                else:
                    log.warning("Note node without content: id=%s", properties.get("id"))
            
            if "Figure" in labels:
                figure_count += 1
                if properties.get("drive_file_id"):
                    figures_with_drive += 1
                else:
                    log.warning("Figure node without drive_file_id: id=%s, paper_id=%s", 
                              properties.get("id"), properties.get("paper_id"))

            if "User" in labels:
                continue
            label_clause = "".join(f":{_cypher_ident(label)}" for label in labels)
            tx.run(
                f"""
                CREATE (n{label_clause}:{tmp_label})
                SET n = $properties
                SET n.{IMPORT_TMP_PROP} = $export_id
                """,
                properties=properties,
                export_id=export_id,
            ).consume()
            counts["nodes"] += 1

        log.info("Imported %d nodes | Notes: %d (%d with content) | Figures: %d (%d with drive_file_id)",
                counts["nodes"], note_count, notes_with_content, figure_count, figures_with_drive)
        
        counts["notes"] = note_count
        counts["figures"] = figure_count

        # Track relationship types
        note_rel_count = 0
        figure_rel_count = 0

        for rel in relationships:
            start_export_id = rel.get("start_export_id")
            end_export_id = rel.get("end_export_id")
            rel_type = rel.get("type")
            properties = rel.get("properties")
            if (
                not isinstance(start_export_id, str)
                or not isinstance(end_export_id, str)
                or not isinstance(rel_type, str)
                or not isinstance(properties, dict)
            ):
                raise HTTPException(status_code=400, detail="Snapshot contains an invalid relationship entry")

            # Track note and figure relationships
            if rel_type == "HAS_NOTE":
                note_rel_count += 1
            elif rel_type == "HAS_FIGURE":
                figure_rel_count += 1

            start_user = rel.get("start_user") or user_by_export_id.get(start_export_id)
            end_user = rel.get("end_user") or user_by_export_id.get(end_export_id)
            match_a = "(a:User {name: $start_user})" if start_user else f"(a:{tmp_label} {{{IMPORT_TMP_PROP}: $start_export_id}})"
            match_b = "(b:User {name: $end_user})" if end_user else f"(b:{tmp_label} {{{IMPORT_TMP_PROP}: $end_export_id}})"
            tx.run(
                f"""
                MATCH {match_a}
                MATCH {match_b}
                CREATE (a)-[r:{_cypher_ident(rel_type)}]->(b)
                SET r = $properties
                """,
                start_export_id=start_export_id,
                end_export_id=end_export_id,
                start_user=start_user,
                end_user=end_user,
                properties=properties,
            ).consume()
            counts["relationships"] += 1

        log.info("Imported %d relationships | HAS_NOTE: %d | HAS_FIGURE: %d",
                counts["relationships"], note_rel_count, figure_rel_count)
        
        counts["note_rels"] = note_rel_count
        counts["figure_rels"] = figure_rel_count

        tx.run(
            f"""
            MATCH (n:{tmp_label})
            REMOVE n:{tmp_label}
            REMOVE n.{IMPORT_TMP_PROP}
            """
        ).consume()

    with driver.session() as session:
        session.execute_write(_tx_write)

    return counts


# ── BibTeX (existing) ─────────────────────────────────────────────────────────

@router.get("/bibtex")
def export_bibtex(driver: Driver = Depends(get_driver)):
    """Export all papers as a BibTeX .bib file."""
    papers = []
    with driver.session() as session:
        result = session.run(
            """
            MATCH (p:Paper)
            OPTIONAL MATCH (p)-[:AUTHORED_BY]->(person:Person)
            WITH p, collect(person.name) AS authors
            RETURN p, authors
            ORDER BY p.title
            """
        )
        for record in result:
            props = dict(record["p"])
            props["_authors"] = record["authors"]
            papers.append(props)

    lines: list[str] = []
    for p in papers:
        key = (p.get("id") or "unknown")[:8]
        title   = _bib_escape(p.get("title") or "")
        year    = p.get("year", "")
        doi     = p.get("doi") or ""
        authors = " and ".join(p.get("_authors") or [])

        lines.append(f"@article{{{key},")
        lines.append(f"  title  = {{{title}}},")
        if authors:
            lines.append(f"  author = {{{authors}}},")
        if year:
            lines.append(f"  year   = {{{year}}},")
        if doi:
            lines.append(f"  doi    = {{{doi}}},")
        lines.append("}")
        lines.append("")

    content = "\n".join(lines)
    return Response(
        content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=papers.bib"},
    )


# ── RDF / Turtle export ───────────────────────────────────────────────────────

@router.get("/rdf")
def export_rdf(driver: Driver = Depends(get_driver)):
    """Export the entire graph as an RDF Turtle (.ttl) file."""
    out: list[str] = [TURTLE_PREFIXES]
    SKIP_INTERNAL = {"raw_text", "drive_file_id"}

    with driver.session() as session:

        # Papers
        for r in session.run("MATCH (p:Paper) RETURN p"):
            props = dict(r["p"])
            pid = props.get("id", "")
            uri = f"pmr:paper_{_safe_uri(pid)}"
            out += _node_turtle(uri, "Paper", props, skip=SKIP_INTERNAL)
            out.append("")

        # People
        for r in session.run("MATCH (p:Person) RETURN p"):
            props = dict(r["p"])
            pid = props.get("id", "")
            uri = f"pmr:person_{_safe_uri(pid)}"
            out += _node_turtle(uri, "Person", props)
            out.append("")

        # Tags
        for r in session.run("MATCH (t:Tag) RETURN t"):
            props = dict(r["t"])
            name = props.get("name", "")
            uri = f"pmr:tag_{_safe_uri(name)}"
            out.append(f'{uri} a pm:Tag ; pm:name {_lit(name)} .')
            out.append("")

        # Topics
        for r in session.run("MATCH (t:Topic) RETURN t"):
            props = dict(r["t"])
            name = props.get("name", "")
            uri = f"pmr:topic_{_safe_uri(name)}"
            out += _node_turtle(uri, "Topic", props)
            out.append("")

        # Projects
        for r in session.run("MATCH (p:Project) RETURN p"):
            props = dict(r["p"])
            pid = props.get("id", "")
            uri = f"pmr:project_{_safe_uri(pid)}"
            out += _node_turtle(uri, "Project", props)
            out.append("")

        # Notes (content only — mentions handled via edges)
        for r in session.run("MATCH (n:Note) RETURN n"):
            props = dict(r["n"])
            nid = props.get("id", "")
            uri = f"pmr:note_{_safe_uri(nid)}"
            out += _node_turtle(uri, "Note", props)
            out.append("")

        # ── Relationships ─────────────────────────────────────────────────────

        out.append("# --- Relationships ---\n")

        for r in session.run("MATCH (p:Paper)-[:AUTHORED_BY]->(a:Person) RETURN p.id AS pid, a.id AS aid"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:authoredBy pmr:person_{_safe_uri(r['aid'])} .")

        for r in session.run("MATCH (p:Paper)-[rel:INVOLVES]->(a:Person) RETURN p.id AS pid, a.id AS aid, rel.role AS role"):
            blank = f"pmr:involves_{_safe_uri(r['pid'])}_{_safe_uri(r['aid'])}"
            out.append(f"{blank} a pm:InvolvesRel ; pm:paper pmr:paper_{_safe_uri(r['pid'])} ; pm:person pmr:person_{_safe_uri(r['aid'])} ; pm:role {_lit(r['role'])} .")

        for r in session.run("MATCH (p:Paper)-[:TAGGED]->(t:Tag) RETURN p.id AS pid, t.name AS tname"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:taggedWith pmr:tag_{_safe_uri(r['tname'])} .")

        for r in session.run("MATCH (p:Paper)-[:ABOUT]->(t:Topic) RETURN p.id AS pid, t.name AS tname"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:about pmr:topic_{_safe_uri(r['tname'])} .")

        for r in session.run("MATCH (p:Paper)-[:CITES]->(ref:Paper) RETURN p.id AS pid, ref.id AS rid"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:cites pmr:paper_{_safe_uri(r['rid'])} .")

        for r in session.run("MATCH (p:Paper)-[:IN_PROJECT]->(proj:Project) RETURN p.id AS pid, proj.id AS projid"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:inProject pmr:project_{_safe_uri(r['projid'])} .")

        for r in session.run("MATCH (p:Paper)-[:HAS_NOTE]->(n:Note) RETURN p.id AS pid, n.id AS nid"):
            out.append(f"pmr:paper_{_safe_uri(r['pid'])} pm:hasNote pmr:note_{_safe_uri(r['nid'])} .")

        for r in session.run("MATCH (n:Note)-[:MENTIONS]->(x) RETURN n.id AS nid, labels(x) AS lbls, x.id AS xid, x.name AS xname"):
            lbl = (r["lbls"] or ["Unknown"])[0]
            if lbl == "Person":
                out.append(f"pmr:note_{_safe_uri(r['nid'])} pm:mentions pmr:person_{_safe_uri(r['xid'])} .")
            elif lbl == "Topic":
                out.append(f"pmr:note_{_safe_uri(r['nid'])} pm:mentions pmr:topic_{_safe_uri(r['xname'])} .")

        for r in session.run("MATCH (p:Person)-[:SPECIALIZES_IN]->(t:Topic) RETURN p.id AS pid, t.name AS tname"):
            out.append(f"pmr:person_{_safe_uri(r['pid'])} pm:specializesIn pmr:topic_{_safe_uri(r['tname'])} .")

    content = "\n".join(out)
    return Response(
        content,
        media_type="text/turtle; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=papermanager.ttl"},
    )


# ── CSV export (ZIP) ──────────────────────────────────────────────────────────

@router.get("/csv")
def export_csv(driver: Driver = Depends(get_driver)):
    """Export the entire graph as a ZIP of CSV files."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:

        with driver.session() as session:

            def _csv(rows: list[dict], filename: str):
                if not rows:
                    zf.writestr(filename, "")
                    return
                s = io.StringIO()
                # Nodes carry different property sets; the header is their union.
                fieldnames = list(dict.fromkeys(k for row in rows for k in row))
                w = csv.DictWriter(s, fieldnames=fieldnames)
                w.writeheader()
                w.writerows(rows)
                zf.writestr(filename, s.getvalue())

            # Papers
            papers = [dict(r["p"]) for r in session.run("MATCH (p:Paper) RETURN p ORDER BY p.created_at DESC")]
            for p in papers:
                p.pop("raw_text", None)
            _csv(papers, "papers.csv")

            # People
            people = [dict(r["p"]) for r in session.run("MATCH (p:Person) RETURN p ORDER BY p.name")]
            _csv(people, "people.csv")

            # Tags
            tags = [dict(r["t"]) for r in session.run("MATCH (t:Tag) RETURN t ORDER BY t.name")]
            _csv(tags, "tags.csv")

            # Topics
            topics = [dict(r["t"]) for r in session.run("MATCH (t:Topic) RETURN t ORDER BY t.name")]
            _csv(topics, "topics.csv")

            # Projects
            projects = [dict(r["p"]) for r in session.run("MATCH (p:Project) RETURN p ORDER BY p.name")]
            _csv(projects, "projects.csv")

            # Notes
            notes = [dict(r["n"]) for r in session.run("MATCH (n:Note) RETURN n")]
            _csv(notes, "notes.csv")

            # Edges
            edges: list[dict] = []
            for r in session.run("MATCH (a)-[rel]->(b) RETURN a.id AS src, type(rel) AS type, b.id AS tgt, b.name AS tgt_name, properties(rel) AS props"):
                row = {
                    "source_id":   r["src"] or "",
                    "type":        r["type"],
                    "target_id":   r["tgt"] or r["tgt_name"] or "",
                    "extra":       json.dumps(dict(r["props"])) if r["props"] else "",
                }
                edges.append(row)
            _csv(edges, "edges.csv")

    buf.seek(0)
    return Response(
        buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=papermanager_export.zip"},
    )


def _json_safe(obj):
    import datetime
    import sys
    try:
        if isinstance(obj, (datetime.datetime, datetime.date, datetime.time)):
            return obj.isoformat()
        # Neo4j DateTime, Date, Time, Duration types
        if hasattr(obj, 'iso_format'):
            return obj.iso_format()
        # Neo4j Point
        if hasattr(obj, 'x') and hasattr(obj, 'y'):
            return {'x': obj.x, 'y': obj.y, 'z': getattr(obj, 'z', None)}
        return str(obj)
    except Exception as e:
        # Log the type and value of the unserializable object
        debug_path = "/tmp/pm_snapshot_debug.log"
        with open(debug_path, "a") as f:
            f.write(f"[UNSERIALIZABLE] type={type(obj).__name__} value={repr(obj)} error={e}\n")
        print(f"[UNSERIALIZABLE] type={type(obj).__name__} value={repr(obj)} error={e}", file=sys.stderr)
        sys.stderr.flush()
        raise

@router.get("/snapshot")
def export_snapshot(driver: Driver = Depends(get_driver)):
    """Export the full graph as a restorable JSON snapshot."""
    snapshot = _build_snapshot(driver)
    debug_path = "/tmp/pm_snapshot_debug.log"
    def log(msg):
        with open(debug_path, "a") as f:
            f.write(msg + "\n")
        print(msg, file=sys.stderr)
        sys.stderr.flush()
    log("[DEBUG] export_snapshot called, using _json_safe:")
    try:
        for i, node in enumerate(snapshot.get("nodes", [])):
            try:
                json.dumps(node, default=_json_safe)
            except Exception as e:
                log(f"[ERROR] Node {i} failed: {e} | {repr(node)}")
                raise
        for i, rel in enumerate(snapshot.get("relationships", [])):
            try:
                json.dumps(rel, default=_json_safe)
            except Exception as e:
                log(f"[ERROR] Relationship {i} failed: {e} | {repr(rel)}")
                raise
        data = json.dumps(snapshot, ensure_ascii=False, indent=2, default=_json_safe)
    except TypeError as exc:
        import traceback
        log(f"[ERROR] JSON serialization failed: {exc}")
        traceback.print_exc(file=sys.stderr)
        raise
    log("[DEBUG] export_snapshot completed successfully.")
    return Response(
        data,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={_snapshot_filename()}"},
    )


@router.post("/import/snapshot")
async def import_snapshot(file: UploadFile = File(...), replace: bool = True, current_user: str = Depends(get_current_user), driver: Driver = Depends(get_driver)):
    """Import a full graph snapshot previously exported by this app."""
    if not is_user_admin(driver, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Only .json snapshot files are accepted")

    try:
        payload = json.loads((await file.read()).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Snapshot file is not valid JSON") from exc

    counts = _restore_snapshot(driver, payload, replace=replace)
    log.info("Snapshot import complete | replace=%s | %s", replace, counts)
    return {"imported": counts, "replaced": replace}


@router.post("/import/snapshot/validate")
async def validate_snapshot(file: UploadFile = File(...)):
    """Validate and inspect a snapshot file without importing it."""
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Only .json snapshot files are accepted")

    try:
        payload = json.loads((await file.read()).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Snapshot file is not valid JSON") from exc

    # Validate format and version
    if payload.get("format") != SNAPSHOT_FORMAT:
        return {"valid": False, "error": "Unsupported snapshot format"}
    if payload.get("version") != SNAPSHOT_VERSION:
        return {"valid": False, "error": "Unsupported snapshot version"}

    nodes = payload.get("nodes", [])
    relationships = payload.get("relationships", [])
    
    # Analyze node types
    node_types = {}
    notes_with_content = 0
    notes_without_content = []
    figures_with_drive = 0
    figures_without_drive = []
    
    for node in nodes:
        labels = node.get("labels", [])
        properties = node.get("properties", {})
        
        for label in labels:
            node_types[label] = node_types.get(label, 0) + 1
        
        if "Note" in labels:
            if properties.get("content"):
                notes_with_content += 1
            else:
                notes_without_content.append({
                    "id": properties.get("id"),
                    "created_at": properties.get("created_at")
                })
        
        if "Figure" in labels:
            if properties.get("drive_file_id"):
                figures_with_drive += 1
            else:
                figures_without_drive.append({
                    "id": properties.get("id"),
                    "paper_id": properties.get("paper_id"),
                    "figure_number": properties.get("figure_number")
                })
    
    # Analyze relationship types
    rel_types = {}
    for rel in relationships:
        rel_type = rel.get("type")
        if rel_type:
            rel_types[rel_type] = rel_types.get(rel_type, 0) + 1
    
    return {
        "valid": True,
        "format": payload.get("format"),
        "version": payload.get("version"),
        "exported_at": payload.get("exported_at"),
        "total_nodes": len(nodes),
        "total_relationships": len(relationships),
        "node_types": node_types,
        "relationship_types": rel_types,
        "notes": {
            "total": node_types.get("Note", 0),
            "with_content": notes_with_content,
            "without_content": len(notes_without_content),
            "missing_content_details": notes_without_content[:10]  # Show first 10
        },
        "figures": {
            "total": node_types.get("Figure", 0),
            "with_drive_file_id": figures_with_drive,
            "without_drive_file_id": len(figures_without_drive),
            "missing_drive_details": figures_without_drive[:10]  # Show first 10
        }
    }


# ── RDF / Turtle import ───────────────────────────────────────────────────────

_TRIPLE_RE = re.compile(
    r'(pmr:\S+|"[^"]*"(?:\^\^xsd:\w+)?)\s+(pm:\w+|a)\s+(pmr:\S+|"[^"]*"(?:\^\^xsd:\w+)?)\s*\.'
)
_LIT_RE  = re.compile(r'^"(.*?)"(?:\^\^xsd:(\w+))?$', re.DOTALL)
_PMR_RE  = re.compile(r'^pmr:((\w+)_(.+))$')


def _parse_literal(tok: str):
    m = _LIT_RE.match(tok)
    if not m:
        return tok
    val, dtype = m.group(1), m.group(2)
    val = val.replace("\\n", "\n").replace("\\r", "\r").replace('\\"', '"').replace("\\\\", "\\")
    if dtype == "integer":
        try:
            return int(val)
        except ValueError:
            return val
    if dtype in ("decimal", "float"):
        try:
            return float(val)
        except ValueError:
            return val
    if dtype == "boolean":
        return val.lower() == "true"
    return val


def _parse_uri(tok: str) -> tuple[str, str, str] | None:
    """Return (full_local, node_type_prefix, local_id) or None."""
    m = _PMR_RE.match(tok)
    if not m:
        return None
    full, prefix, local = m.group(1), m.group(2), m.group(3)
    return full, prefix, local


@router.post("/import/rdf")
async def import_rdf(file: UploadFile = File(...)):
    """
    Import a Turtle (.ttl) file previously exported by this app.
    Uses MERGE everywhere — safe to run on a populated database (no duplicates).
    """
    if not file.filename or not file.filename.endswith(".ttl"):
        raise HTTPException(status_code=400, detail="Only .ttl (Turtle RDF) files are accepted")

    raw = (await file.read()).decode("utf-8")
    driver = get_driver()

    # State collectors
    nodes: dict[str, dict] = {}       # uri → {_type, _prefix, _lid, **props}
    involves: list[dict] = []          # InvolvesRel reified nodes
    edges: list[tuple[str, str, str, dict]] = []  # (src_uri, pred, tgt_uri, extra)

    # ── Pass 1: parse all triples ─────────────────────────────────────────────
    for m in _TRIPLE_RE.finditer(raw):
        subj, pred, obj = m.group(1), m.group(2), m.group(3)

        if pred == "a":
            # Node type declaration
            type_name = obj.replace("pm:", "")
            if subj not in nodes:
                nodes[subj] = {"_type": type_name}
            else:
                nodes[subj]["_type"] = type_name
            continue

        local_pred = pred.replace("pm:", "")

        if subj.startswith("pmr:") and obj.startswith('"'):
            # Property literal
            if subj not in nodes:
                nodes[subj] = {}
            nodes[subj][local_pred] = _parse_literal(obj)
            continue

        if subj.startswith("pmr:") and obj.startswith("pmr:"):
            edges.append((subj, local_pred, obj, {}))

    # ── Pass 2: collect InvolvesRel edges ─────────────────────────────────────
    for uri, props in nodes.items():
        if props.get("_type") == "InvolvesRel":
            involves.append(props)

    # ── Pass 3: write to Neo4j ─────────────────────────────────────────────────
    counts: dict[str, int] = {k: 0 for k in ("papers", "people", "tags", "topics", "projects", "notes", "edges", "involves")}

    with driver.session() as session:

        for uri, props in nodes.items():
            t = props.get("_type")
            p = {k: v for k, v in props.items() if not k.startswith("_")}

            if t == "Paper" and p.get("id"):
                session.run(
                    "MERGE (n:Paper {id: $id}) SET n += $props",
                    id=p["id"], props=p,
                )
                counts["papers"] += 1

            elif t == "Person" and p.get("id"):
                session.run(
                    "MERGE (n:Person {id: $id}) SET n += $props",
                    id=p["id"], props=p,
                )
                counts["people"] += 1

            elif t == "Tag" and p.get("name"):
                session.run(
                    "MERGE (n:Tag {name: $name})",
                    name=p["name"],
                )
                counts["tags"] += 1

            elif t == "Topic" and p.get("name"):
                session.run(
                    "MERGE (n:Topic {name: $name}) SET n += $props",
                    name=p["name"], props=p,
                )
                counts["topics"] += 1

            elif t == "Project" and p.get("id"):
                session.run(
                    "MERGE (n:Project {id: $id}) SET n += $props",
                    id=p["id"], props=p,
                )
                counts["projects"] += 1

            elif t == "Note" and p.get("id"):
                session.run(
                    "MERGE (n:Note {id: $id}) SET n += $props",
                    id=p["id"], props=p,
                )
                counts["notes"] += 1

        # Involves (reified)
        for inv in involves:
            paper_uri = inv.get("paper", "")
            person_uri = inv.get("person", "")
            role = inv.get("role", "")
            pu = _parse_uri(paper_uri)
            pe = _parse_uri(person_uri)
            if pu and pe:
                session.run(
                    """
                    MATCH (paper:Paper {id: $pid}), (person:Person {id: $peid})
                    MERGE (paper)-[r:INVOLVES {role: $role}]->(person)
                    """,
                    pid=pu[2], peid=pe[2], role=role,
                )
                counts["involves"] += 1

        # Edges
        REL_MAP = {
            "authoredBy":   ("Paper", "AUTHORED_BY", "Person"),
            "taggedWith":   ("Paper", "TAGGED",       "Tag"),
            "about":        ("Paper", "ABOUT",        "Topic"),
            "cites":        ("Paper", "CITES",        "Paper"),
            "inProject":    ("Paper", "IN_PROJECT",   "Project"),
            "hasNote":      ("Paper", "HAS_NOTE",     "Note"),
            "mentions":     ("Note",  "MENTIONS",     None),
            "specializesIn":("Person","SPECIALIZES_IN","Topic"),
        }

        for src_uri, pred, tgt_uri, _ in edges:
            if pred not in REL_MAP:
                continue
            src_p = _parse_uri(src_uri)
            tgt_p = _parse_uri(tgt_uri)
            if not src_p or not tgt_p:
                continue

            rel_type = REL_MAP[pred][1]
            src_prefix, tgt_prefix = src_p[1], tgt_p[1]

            # Resolve lookup key (id vs name)
            src_id_field = "name" if src_prefix in ("tag", "topic") else "id"
            tgt_id_field = "name" if tgt_prefix in ("tag", "topic") else "id"

            # URL-decode the local id (we encoded spaces/special chars)
            import urllib.parse
            src_lid = urllib.parse.unquote(src_p[2])
            tgt_lid = urllib.parse.unquote(tgt_p[2])

            # Strip trailing punctuation artefacts
            src_lid = src_lid.rstrip(" .")
            tgt_lid = tgt_lid.rstrip(" .")

            src_label = src_prefix.capitalize()
            tgt_label = tgt_prefix.capitalize()
            if src_label == "Note":
                src_label = "Note"
            if tgt_label == "Note":
                tgt_label = "Note"

            try:
                session.run(
                    f"""
                    MATCH (a:{src_label} {{{src_id_field}: $sid}})
                    MATCH (b:{tgt_label} {{{tgt_id_field}: $tid}})
                    MERGE (a)-[:{rel_type}]->(b)
                    """,
                    sid=src_lid, tid=tgt_lid,
                )
                counts["edges"] += 1
            except Exception as exc:
                log.debug("Edge import skip | %s→%s | %s", src_uri, tgt_uri, exc)

    log.info("RDF import complete | %s", counts)
    return {"imported": counts}


# ── Per-paper Markdown export ─────────────────────────────────────────────────

@router.get("/papers/{paper_id}/markdown")
def export_paper_markdown(paper_id: str, driver: Driver = Depends(get_driver)):
    """Export a single paper and all its extracted data as a Markdown file."""
    paper = get_paper(driver, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    # ── Fetch related data ────────────────────────────────────────────────────
    with driver.session() as session:
        authors = [
            r["name"] for r in session.run(
                "MATCH (p:Paper {id:$id})-[:AUTHORED_BY]->(a:Person) RETURN a.name AS name ORDER BY a.name",
                id=paper_id,
            )
        ]
        tags = [
            r["name"] for r in session.run(
                "MATCH (p:Paper {id:$id})-[:TAGGED]->(t:Tag) RETURN t.name AS name ORDER BY t.name",
                id=paper_id,
            )
        ]
        topics = [
            r["name"] for r in session.run(
                "MATCH (p:Paper {id:$id})-[:ABOUT]->(t:Topic) RETURN t.name AS name ORDER BY t.name",
                id=paper_id,
            )
        ]
        projects = [
            {"name": r["name"], "description": r.get("description") or ""}
            for r in session.run(
                "MATCH (proj:Project)-[:CONTAINS]->(p:Paper {id:$id}) RETURN proj.name AS name, proj.description AS description ORDER BY proj.name",
                id=paper_id,
            )
        ]
        involves = [
            {"name": r["name"], "role": r["role"]}
            for r in session.run(
                "MATCH (p:Paper {id:$id})-[rel:INVOLVES]->(a:Person) RETURN a.name AS name, rel.role AS role ORDER BY a.name",
                id=paper_id,
            )
        ]

    note_obj = get_paper_note(driver, paper_id)
    note_content: str = (note_obj or {}).get("content", "") or ""

    claims = get_paper_claims(driver, paper_id)
    annotations = list_annotations(driver, paper_id)
    figures = list_figures(driver, paper_id)
    tables = list_tables(driver, paper_id)
    references = get_references(driver, paper_id)
    cited_by = get_cited_by(driver, paper_id)

    # ── Build Markdown ─────────────────────────────────────────────────────────
    def _s(v) -> str:
        return str(v) if v is not None else ""

    lines: list[str] = []

    title = _s(paper.get("title") or "Untitled")
    lines += [f"# {title}", ""]

    # Metadata table
    lines.append("## Metadata")
    lines.append("")
    meta_rows = [
        ("Year",            _s(paper.get("year"))),
        ("DOI",             _s(paper.get("doi"))),
        ("Venue",           _s(paper.get("venue"))),
        ("Document type",   _s(paper.get("document_type"))),
        ("Published date",  _s(paper.get("published_date"))),
        ("Metadata source", _s(paper.get("metadata_source"))),
        ("Reading status",  _s(paper.get("reading_status"))),
        ("Rating",          _s(paper.get("rating"))),
        ("Bookmarked",      "Yes" if paper.get("bookmarked") else "No"),
        ("Added",           _s(paper.get("created_at", ""))[:10]),
    ]
    for label, val in meta_rows:
        if val and val not in ("None", "0", "null"):
            lines.append(f"- **{label}:** {val}")
    lines.append("")

    # Authors
    if authors:
        lines += ["## Authors", ""]
        for a in authors:
            lines.append(f"- {a}")
        lines.append("")

    # Involved people
    if involves:
        lines += ["## Involved People", ""]
        for iv in involves:
            lines.append(f"- **{iv['name']}** ({iv['role']})")
        lines.append("")

    # Tags
    if tags:
        lines += ["## Tags", ""]
        lines.append(", ".join(f"`{t}`" for t in tags))
        lines.append("")

    # Topics
    if topics:
        lines += ["## Topics", ""]
        for t in topics:
            lines.append(f"- {t}")
        lines.append("")

    # Projects
    if projects:
        lines += ["## Projects", ""]
        for proj in projects:
            desc = f" — {proj['description']}" if proj["description"] else ""
            lines.append(f"- **{proj['name']}**{desc}")
        lines.append("")

    # Abstract
    abstract = _s(paper.get("abstract"))
    if abstract:
        lines += ["## Abstract", "", abstract, ""]

    # Summary
    summary = _s(paper.get("summary"))
    if summary:
        lines += ["## AI Summary", "", summary, ""]

    # Claims
    if claims:
        lines += ["## Extracted Claims", ""]
        by_type: dict[str, list[str]] = {}
        for c in claims:
            by_type.setdefault(c.get("type", "claim"), []).append(c["text"])
        for ctype, ctexts in sorted(by_type.items()):
            lines.append(f"### {ctype.capitalize()}s")
            lines.append("")
            for text in ctexts:
                lines.append(f"- {text}")
            lines.append("")

    # Notes
    if note_content.strip():
        lines += ["## Notes", "", note_content, ""]

    # Highlights / Annotations
    if annotations:
        lines += ["## Highlights & Annotations", ""]
        from services.my_notes import color_meaning

        for ann in annotations:
            color = ann.get("color", "yellow")
            label = color_meaning(color)
            page = ann.get("page_number")
            text = ann.get("highlighted_text", "").strip()
            note = ann.get("note", "").strip()
            page_str = f" *(p. {page})*" if page else ""
            lines.append(f"**[{label}]{page_str}** {text}")
            if note:
                lines.append(f"  > {note}")
            lines.append("")

    # Figures
    if figures:
        lines += ["## Figures", ""]
        for fig in figures:
            fig_num = fig.get("figure_number")
            page = fig.get("page_number")
            caption = (fig.get("caption") or "").strip()
            label = f"Figure {fig_num}" if fig_num else "Figure"
            page_str = f" *(p. {page})*" if page else ""
            cap_str = f" — {caption}" if caption else ""
            lines.append(f"**{label}**{page_str}{cap_str}")
        lines.append("")

    # Tables
    if tables:
        lines += ["## Tables", ""]
        for tbl in tables:
            tbl_num = tbl.get("table_number")
            page = tbl.get("page_number")
            caption = (tbl.get("caption") or "").strip()
            md = (tbl.get("markdown_content") or "").strip()
            label = f"Table {tbl_num}" if tbl_num else "Table"
            page_str = f" *(p. {page})*" if page else ""
            cap_str = f": {caption}" if caption else ""
            lines.append(f"### {label}{page_str}{cap_str}")
            lines.append("")
            lines.append(md)
            lines.append("")

    # References
    if references:
        lines += ["## References", ""]
        for ref in references:
            ref_title = ref.get("title") or "Untitled"
            ref_year  = ref.get("year")
            ref_doi   = ref.get("doi")
            yr = f" ({ref_year})" if ref_year else ""
            doi_str = f" — DOI: {ref_doi}" if ref_doi else ""
            lines.append(f"- {ref_title}{yr}{doi_str}")
        lines.append("")

    # Cited by
    if cited_by:
        lines += ["## Cited By", ""]
        for ref in cited_by:
            ref_title = ref.get("title") or "Untitled"
            ref_year  = ref.get("year")
            yr = f" ({ref_year})" if ref_year else ""
            lines.append(f"- {ref_title}{yr}")
        lines.append("")

    content = "\n".join(lines)

    safe_title = re.sub(r"[^\w\s-]", "", title)[:60].strip().replace(" ", "_")
    filename = f"{safe_title or paper_id}.md"

    return Response(
        content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── helpers ───────────────────────────────────────────────────────────────────

def _bib_escape(s: str) -> str:
    return s.replace("{", "\\{").replace("}", "\\}")
