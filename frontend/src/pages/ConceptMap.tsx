import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../api/client";

// ── Types ───────────────────────────────────────────────────────────────────

type Author = { id: string; name: string };
type MapPaper = {
  id: string; title: string; year: number | null; venue: string | null;
  citation_count: number | null; reading_status: string | null; document_type: string | null;
  mapped_at: string | null; map_error: string | null; authors: Author[];
};
type MapConcept = { id: string; name: string; kind: string; definition: string | null; aliases: string[] };
type Discuss = { paper_id: string; concept_id: string; role: string; in_paper: string | null };
type ConceptLink = { source: string; target: string; type: string; support: { paper_id: string; evidence: string | null }[] };
type Job = { total: number; done: number; failed: number; running: boolean; errors: { paper_id: string; title: string; error: string }[] };
type MapData = {
  papers: MapPaper[]; concepts: MapConcept[]; discusses: Discuss[];
  concept_links: ConceptLink[]; citations: { source: string; target: string }[]; job: Job;
};

type NodeKind = "concept" | "paper" | "author";
type Sel = { kind: NodeKind; id: string } | null;
type GNode = { id: string; kind: NodeKind; label: string; color: string; r: number; x?: number; y?: number };
type GLink = { source: string | GNode; target: string | GNode; kind: "discuss" | "relation" | "cites" | "authored"; label: string; role?: string };

// ── Palette ─────────────────────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  method: "#7c3aed", model: "#2563eb", task: "#0891b2", dataset: "#059669", metric: "#65a30d",
  theory: "#db2777", phenomenon: "#ea580c", tool: "#ca8a04", domain: "#64748b",
};
const PAPER_COLOR = "#334155";
const AUTHOR_COLOR = "#f43f5e";
const ROLE_STYLE: Record<string, string> = {
  introduces: "bg-violet-100 text-violet-700", extends: "bg-blue-100 text-blue-700",
  uses: "bg-gray-100 text-gray-600", evaluates: "bg-emerald-100 text-emerald-700",
  critiques: "bg-red-100 text-red-700", background: "bg-gray-50 text-gray-400",
};
const REL_TEXT: Record<string, [string, string]> = {
  is_a: ["is a", "has kind"], part_of: ["part of", "contains"], uses: ["uses", "used by"],
  extends: ["extends", "extended by"], improves_on: ["improves on", "improved on by"],
  alternative_to: ["alternative to", "alternative to"], evaluated_on: ["evaluated on", "evaluates"],
  causes: ["causes", "caused by"], addresses: ["addresses", "addressed by"], related_to: ["related to", "related to"],
};

const shortAuthors = (a: Author[]) =>
  a.length === 0 ? "" : a.length <= 2 ? a.map(x => x.name).join(", ") : `${a[0].name} et al.`;

function hexAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ConceptMap() {
  const { id: projectId } = useParams<{ id: string }>();
  const [projectName, setProjectName] = useState("");
  const [data, setData] = useState<MapData | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<"graph" | "overview">("graph");
  const [search, setSearch] = useState("");
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [minPapers, setMinPapers] = useState(1);
  const [yearMin, setYearMin] = useState<number | "">("");
  const [yearMax, setYearMax] = useState<number | "">("");
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [authorSearch, setAuthorSearch] = useState("");
  const [showPapers, setShowPapers] = useState(true);
  const [showAuthors, setShowAuthors] = useState(false);
  const [showCitations, setShowCitations] = useState(true);
  const [showRelations, setShowRelations] = useState(true);
  const [selected, setSelected] = useState<Sel>(null);
  const [graphReady, setGraphReady] = useState(0);

  const load = useCallback(() => {
    if (!projectId) return;
    apiFetch<MapData>(`/projects/${projectId}/concept-map`)
      .then(d => {
        setData(prev => {
          // Dense maps start with shared concepts only; the slider shows the rest.
          if (!prev && d.concepts.length > 600) setMinPapers(2);
          return d;
        });
        setJob(d.job);
      })
      .catch(e => setError(String(e)));
  }, [projectId]);

  useEffect(() => {
    load();
    if (projectId) apiFetch<{ name: string }>(`/projects/${projectId}`).then(p => setProjectName(p.name)).catch(() => {});
  }, [load, projectId]);

  // Poll while a build runs; refresh the map every few papers and at the end.
  useEffect(() => {
    if (!job?.running || !projectId) return;
    let ticks = 0;
    const t = setInterval(() => {
      apiFetch<Job>(`/projects/${projectId}/concept-map/status`).then(j => {
        setJob(j);
        ticks += 1;
        if (!j.running || ticks % 5 === 0) load();
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [job?.running, projectId, load]);

  const startBuild = async (force: boolean, paperIds?: string[]) => {
    if (force && !paperIds && !confirm("Re-extract the concepts of every paper in this project?")) return;
    try {
      const j = await apiFetch<Job>(`/projects/${projectId}/concept-map/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, paper_ids: paperIds ?? null }),
      });
      setJob(j);
      if (!j.running) load();
    } catch (e) {
      setError(String(e));
    }
  };

  // ── Indexes ──────────────────────────────────────────────────────────────

  const idx = useMemo(() => {
    const papers = new Map<string, MapPaper>();
    const concepts = new Map<string, MapConcept>();
    const authors = new Map<string, { author: Author; papers: string[] }>();
    if (!data) return { papers, concepts, authors };
    data.papers.forEach(p => {
      papers.set(p.id, p);
      p.authors.forEach(a => {
        const e = authors.get(a.id) ?? { author: a, papers: [] };
        e.papers.push(p.id);
        authors.set(a.id, e);
      });
    });
    data.concepts.forEach(c => concepts.set(c.id, c));
    return { papers, concepts, authors };
  }, [data]);

  const years = useMemo(() => {
    const ys = (data?.papers ?? []).map(p => p.year).filter((y): y is number => !!y);
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : [null, null];
  }, [data]);

  // Papers passing the author and year filters.
  const visiblePaperIds = useMemo(() => {
    const s = new Set<string>();
    (data?.papers ?? []).forEach(p => {
      if (authorFilter.size && !p.authors.some(a => authorFilter.has(a.id))) return;
      if (yearMin !== "" && (p.year ?? 0) < yearMin) return;
      if (yearMax !== "" && (p.year ?? 9999) > yearMax) return;
      s.add(p.id);
    });
    return s;
  }, [data, authorFilter, yearMin, yearMax]);

  // concept id → its DISCUSSES rows among visible papers
  const conceptPapers = useMemo(() => {
    const m = new Map<string, Discuss[]>();
    (data?.discusses ?? []).forEach(d => {
      if (!visiblePaperIds.has(d.paper_id)) return;
      const arr = m.get(d.concept_id) ?? [];
      arr.push(d);
      m.set(d.concept_id, arr);
    });
    return m;
  }, [data, visiblePaperIds]);

  const visibleConceptIds = useMemo(() => {
    const s = new Set<string>();
    (data?.concepts ?? []).forEach(c => {
      if (hiddenKinds.has(c.kind)) return;
      if ((conceptPapers.get(c.id)?.length ?? 0) < minPapers) return;
      s.add(c.id);
    });
    return s;
  }, [data, hiddenKinds, conceptPapers, minPapers]);

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !data) return null;
    const s = new Set<string>();
    data.concepts.forEach(c => {
      if (c.name.toLowerCase().includes(q) || c.aliases.some(a => a.toLowerCase().includes(q))) s.add(c.id);
    });
    data.papers.forEach(p => { if ((p.title ?? "").toLowerCase().includes(q)) s.add(p.id); });
    idx.authors.forEach(({ author }) => { if (author.name.toLowerCase().includes(q)) s.add(author.id); });
    return s;
  }, [search, data, idx]);

  // ── Graph data ───────────────────────────────────────────────────────────

  const graphData = useMemo(() => {
    const nodes: GNode[] = [];
    const links: GLink[] = [];
    if (!data) return { nodes, links };
    visibleConceptIds.forEach(cid => {
      const c = idx.concepts.get(cid)!;
      const n = conceptPapers.get(cid)?.length ?? 1;
      nodes.push({ id: cid, kind: "concept", label: c.name, color: KIND_COLORS[c.kind] ?? "#64748b", r: 3 + 2.2 * Math.sqrt(n) });
    });
    const paperIds = new Set<string>();
    if (showPapers) {
      data.discusses.forEach(d => {
        if (!visiblePaperIds.has(d.paper_id) || !visibleConceptIds.has(d.concept_id)) return;
        paperIds.add(d.paper_id);
        links.push({ source: d.paper_id, target: d.concept_id, kind: "discuss", label: d.role, role: d.role });
      });
      if (showCitations) {
        data.citations.forEach(c => {
          if (!visiblePaperIds.has(c.source) || !visiblePaperIds.has(c.target)) return;
          paperIds.add(c.source); paperIds.add(c.target);
          links.push({ source: c.source, target: c.target, kind: "cites", label: "cites" });
        });
      }
      paperIds.forEach(pid => {
        const p = idx.papers.get(pid)!;
        nodes.push({ id: pid, kind: "paper", label: p.title, color: PAPER_COLOR, r: 2.5 + Math.log10(1 + (p.citation_count ?? 0)) * 1.4 });
      });
      if (showAuthors) {
        const added = new Set<string>();
        paperIds.forEach(pid => idx.papers.get(pid)!.authors.forEach(a => {
          if (!added.has(a.id)) {
            added.add(a.id);
            nodes.push({ id: a.id, kind: "author", label: a.name, color: AUTHOR_COLOR, r: 2 });
          }
          links.push({ source: a.id, target: pid, kind: "authored", label: "authored" });
        }));
      }
    }
    if (showRelations) {
      data.concept_links.forEach(l => {
        if (!visibleConceptIds.has(l.source) || !visibleConceptIds.has(l.target)) return;
        if (!l.support.some(s => visiblePaperIds.has(s.paper_id))) return;
        links.push({ source: l.source, target: l.target, kind: "relation", label: REL_TEXT[l.type]?.[0] ?? l.type });
      });
    }
    return { nodes, links };
  }, [data, idx, visibleConceptIds, visiblePaperIds, conceptPapers, showPapers, showAuthors, showCitations, showRelations]);

  // Neighbourhood of the selected node, for focus dimming.
  const focus = useMemo(() => {
    if (!selected) return null;
    const s = new Set<string>([selected.id]);
    graphData.links.forEach(l => {
      const a = typeof l.source === "string" ? l.source : l.source.id;
      const b = typeof l.target === "string" ? l.target : l.target.id;
      if (a === selected.id) s.add(b);
      if (b === selected.id) s.add(a);
    });
    return s;
  }, [selected, graphData]);

  // ── force-graph ──────────────────────────────────────────────────────────

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const nodeCache = useRef(new Map<string, GNode>());
  const drawState = useRef({ focus: null as Set<string> | null, hits: null as Set<string> | null });

  useEffect(() => {
    const container = containerRef.current;
    if (view !== "graph" || !container) return;
    let disposed = false;
    import("force-graph").then(({ default: ForceGraph }) => {
      if (disposed || !containerRef.current) return;
      const el = containerRef.current;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = (ForceGraph as any)()(el);
      const dimmed = (id: string) => {
        const { focus, hits } = drawState.current;
        return (focus && !focus.has(id)) || (hits && !hits.has(id) && !(focus?.has(id)));
      };
      g.width(el.clientWidth).height(el.clientHeight)
        .backgroundColor("#f8fafc")
        .nodeId("id")
        .nodeRelSize(1)
        .nodeVal((n: GNode) => n.r * n.r)
        .nodeLabel((n: GNode) => n.label)
        .nodeCanvasObjectMode(() => "replace")
        .nodeCanvasObject((n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
          if (n.x == null || n.y == null) return;
          const dim = dimmed(n.id);
          ctx.fillStyle = dim ? hexAlpha(n.color, 0.12) : n.color;
          ctx.beginPath();
          if (n.kind === "paper") {
            ctx.rect(n.x - n.r, n.y - n.r, 2 * n.r, 2 * n.r);
          } else if (n.kind === "author") {
            ctx.moveTo(n.x, n.y - n.r * 1.3); ctx.lineTo(n.x + n.r * 1.3, n.y);
            ctx.lineTo(n.x, n.y + n.r * 1.3); ctx.lineTo(n.x - n.r * 1.3, n.y); ctx.closePath();
          } else {
            ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
          }
          ctx.fill();
          const { focus } = drawState.current;
          if (focus && focus.has(n.id) && n.id === [...focus][0]) {
            ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1.5 / scale; ctx.stroke();
          }
          // Labels: big concepts always, everything else once zoomed in or focused.
          const show = !dim && (
            (n.kind === "concept" && (n.r > 6 || scale > 1.6)) ||
            (n.kind !== "concept" && scale > 3.2) ||
            (focus?.has(n.id) ?? false)
          );
          if (!show) return;
          const fs = Math.max((n.kind === "concept" ? 11 : 9) / scale, 1.5);
          ctx.font = `${n.kind === "concept" ? 600 : 400} ${fs}px Inter, sans-serif`;
          const text = n.label.length > 42 ? n.label.slice(0, 40) + "…" : n.label;
          const tw = ctx.measureText(text).width;
          const py = n.y + n.r + fs * 0.8;
          ctx.fillStyle = "rgba(248,250,252,0.85)";
          ctx.fillRect(n.x - tw / 2 - 1, py - fs / 2 - 0.5, tw + 2, fs + 1);
          ctx.fillStyle = n.kind === "concept" ? "#0f172a" : "#475569";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(text, n.x, py);
        })
        .linkColor((l: GLink) => {
          const a = typeof l.source === "string" ? l.source : l.source.id;
          const b = typeof l.target === "string" ? l.target : l.target.id;
          const { focus } = drawState.current;
          const off = focus && !(focus.has(a) && focus.has(b) && (a === [...focus][0] || b === [...focus][0]));
          const base = l.kind === "relation" ? "#0d9488" : l.kind === "cites" ? "#d97706"
            : l.kind === "authored" ? AUTHOR_COLOR : l.role === "introduces" ? "#7c3aed" : "#94a3b8";
          return hexAlpha(base, off ? 0.04 : l.kind === "discuss" ? 0.35 : 0.7);
        })
        .linkWidth((l: GLink) => (l.kind === "relation" ? 1.2 : 0.6))
        .linkLineDash((l: GLink) => (l.kind === "cites" ? [3, 2] : null))
        .linkDirectionalArrowLength((l: GLink) => (l.kind === "relation" || l.kind === "cites" ? 3 : 0))
        .linkDirectionalArrowRelPos(1)
        .linkLabel((l: GLink) => l.label)
        .onNodeClick((n: GNode) => setSelected({ kind: n.kind, id: n.id }))
        .onBackgroundClick(() => setSelected(null))
        .cooldownTime(15000);
      g.d3Force("charge")?.strength?.(-45);
      g.d3Force("link")?.distance?.((l: GLink) => (l.kind === "relation" ? 45 : l.kind === "authored" ? 12 : 28));
      graphRef.current = g;
      const ro = new ResizeObserver(() => g.width(el.clientWidth).height(el.clientHeight));
      ro.observe(el);
      (g as { _ro?: ResizeObserver })._ro = ro;
      setGraphReady(r => r + 1);
    });
    return () => {
      disposed = true;
      const g = graphRef.current;
      if (g) { g._ro?.disconnect(); g._destructor?.(); }
      graphRef.current = null;
      container.innerHTML = "";
    };
  }, [view]);


  // Push data into the existing graph; cached node objects keep their positions.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const cache = nodeCache.current;
    const nodes = graphData.nodes.map(n => {
      const old = cache.get(n.id);
      const merged = old ? Object.assign(old, { label: n.label, color: n.color, r: n.r, kind: n.kind }) : { ...n };
      cache.set(n.id, merged);
      return merged;
    });
    g.graphData({ nodes, links: graphData.links.map(l => ({ ...l })) });
  }, [graphData, graphReady]);

  // Repaint when focus or search changes (the simulation may already be idle).
  useEffect(() => {
    drawState.current = { focus, hits: searchHits };
    const g = graphRef.current;
    if (g) g.nodeColor(g.nodeColor());
  }, [focus, searchHits]);

  const centreOn = (id: string) => {
    const n = nodeCache.current.get(id);
    const g = graphRef.current;
    if (g && n && n.x != null) { g.centerAt(n.x, n.y, 600); g.zoom(Math.max(g.zoom(), 2.5), 600); }
  };
  const select = (s: Sel) => { setSelected(s); if (s) setTimeout(() => centreOn(s.id), 50); };

  // ── Render ───────────────────────────────────────────────────────────────

  const mappedCount = data?.papers.filter(p => p.mapped_at).length ?? 0;
  const authorsSorted = useMemo(() => {
    const q = authorSearch.trim().toLowerCase();
    return [...idx.authors.values()]
      .filter(a => !q || a.author.name.toLowerCase().includes(q))
      .sort((a, b) => b.papers.length - a.papers.length || a.author.name.localeCompare(b.author.name));
  }, [idx, authorSearch]);

  const toggleAuthor = (id: string) => setAuthorFilter(prev => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id); else s.add(id);
    return s;
  });

  return (
    <div className="h-[calc(100vh-53px)] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <Link to={`/projects?id=${projectId}`} className="text-xs text-gray-400 hover:text-violet-600">← Projects</Link>
        <h1 className="text-sm font-semibold text-gray-800">{projectName || "Project"} · Concept map</h1>
        <div className="flex gap-1 ml-2">
          {(["graph", "overview"] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1 text-xs rounded-full font-medium ${view === v ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {v === "graph" ? "Graph" : "Overview"}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search concepts, papers, authors…"
          className="ml-2 w-72 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400" />
        <span className="ml-auto text-xs text-gray-400">
          {data ? `${visibleConceptIds.size} concepts · ${visiblePaperIds.size} papers · ${graphData.links.length} edges` : "Loading…"}
        </span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 shrink-0 bg-white border-r border-gray-200 overflow-y-auto p-3 space-y-4 text-xs">
          <section>
            <h3 className="font-semibold text-gray-700 mb-1">Extraction (Claude Opus)</h3>
            <p className="text-gray-500">{mappedCount} of {data?.papers.length ?? 0} papers mapped</p>
            {job?.running && (
              <div className="mt-1.5">
                <div className="h-1.5 bg-gray-100 rounded"><div className="h-1.5 bg-violet-500 rounded" style={{ width: `${(100 * job.done) / Math.max(job.total, 1)}%` }} /></div>
                <p className="text-gray-500 mt-1">{job.done} / {job.total} running{job.failed ? ` · ${job.failed} failed` : ""}</p>
              </div>
            )}
            <div className="flex gap-1.5 mt-2">
              <button disabled={job?.running} onClick={() => startBuild(false)}
                className="px-2.5 py-1 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50">Map new papers</button>
              <button disabled={job?.running} onClick={() => startBuild(true)}
                className="px-2.5 py-1 border border-gray-200 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50">Rebuild all</button>
            </div>
            {!!job?.errors.length && (
              <details className="mt-2 text-red-600">
                <summary className="cursor-pointer">{job.errors.length} errors</summary>
                <ul className="mt-1 space-y-1">{job.errors.map(e => <li key={e.paper_id}><b>{e.title}</b>: {e.error}</li>)}</ul>
              </details>
            )}
            {error && <p className="text-red-600 mt-1">{error}</p>}
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 mb-1">Concept kinds</h3>
            <div className="flex flex-wrap gap-1">
              {Object.entries(KIND_COLORS).map(([k, c]) => (
                <button key={k} onClick={() => setHiddenKinds(prev => { const s = new Set(prev); if (s.has(k)) s.delete(k); else s.add(k); return s; })}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border ${hiddenKinds.has(k) ? "opacity-30 border-gray-200" : "border-gray-300"}`}>
                  <span className="w-2 h-2 rounded-full" style={{ background: c }} />{k}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 mb-1">Shared by at least {minPapers} paper{minPapers > 1 ? "s" : ""}</h3>
            <input type="range" min={1} max={10} value={minPapers} onChange={e => setMinPapers(+e.target.value)} className="w-full accent-violet-600" />
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 mb-1">Years</h3>
            <div className="flex items-center gap-1">
              <input type="number" placeholder={String(years[0] ?? "")} value={yearMin} onChange={e => setYearMin(e.target.value ? +e.target.value : "")}
                className="w-20 border border-gray-200 rounded px-1.5 py-1" />
              <span>–</span>
              <input type="number" placeholder={String(years[1] ?? "")} value={yearMax} onChange={e => setYearMax(e.target.value ? +e.target.value : "")}
                className="w-20 border border-gray-200 rounded px-1.5 py-1" />
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 mb-1">Layers</h3>
            {([["Papers", showPapers, setShowPapers], ["Authors", showAuthors, setShowAuthors],
               ["Citations between papers", showCitations, setShowCitations], ["Concept relations", showRelations, setShowRelations]] as const)
              .map(([label, v, set]) => (
                <label key={label} className="flex items-center gap-1.5 py-0.5 text-gray-600">
                  <input type="checkbox" checked={v} onChange={e => set(e.target.checked)} className="accent-violet-600" />{label}
                </label>
              ))}
            <div className="mt-2 space-y-0.5 text-gray-500">
              <p><span className="inline-block w-2 h-2 rounded-full bg-violet-600 mr-1" />concept (size = papers)</p>
              <p><span className="inline-block w-2 h-2 mr-1" style={{ background: PAPER_COLOR }} />paper (size = citations)</p>
              <p><span className="inline-block w-2 h-2 rotate-45 mr-1" style={{ background: AUTHOR_COLOR }} />author</p>
              <p><span className="text-teal-600">→</span> concept relation · <span className="text-amber-600">⇢</span> citation</p>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-gray-700">Authors</h3>
              {authorFilter.size > 0 && <button onClick={() => setAuthorFilter(new Set())} className="text-violet-600">clear ({authorFilter.size})</button>}
            </div>
            <input value={authorSearch} onChange={e => setAuthorSearch(e.target.value)} placeholder="Filter authors…"
              className="w-full border border-gray-200 rounded px-1.5 py-1 mb-1" />
            <div className="max-h-64 overflow-y-auto">
              {authorsSorted.slice(0, 300).map(({ author, papers }) => (
                <label key={author.id} className="flex items-center gap-1.5 py-0.5 text-gray-600">
                  <input type="checkbox" checked={authorFilter.has(author.id)} onChange={() => toggleAuthor(author.id)} className="accent-violet-600" />
                  <span className="truncate flex-1">{author.name}</span><span className="text-gray-400">{papers.length}</span>
                </label>
              ))}
            </div>
          </section>
        </aside>

        {/* Main */}
        <main className="flex-1 relative overflow-hidden">
          {view === "graph" ? (
            <>
              <div ref={containerRef} className="w-full h-full" />
              {data && data.concepts.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 pointer-events-none">
                  No concepts yet: press “Map new papers” to extract them with Claude.
                </div>
              )}
            </>
          ) : (
            <Overview data={data} conceptPapers={conceptPapers} visibleConceptIds={visibleConceptIds}
              hits={searchHits} onSelect={id => setSelected({ kind: "concept", id })} selectedId={selected?.id} />
          )}
        </main>

        {selected && data && (
          <aside className="w-96 shrink-0 bg-white border-l border-gray-200 overflow-y-auto p-4 text-sm">
            <button onClick={() => setSelected(null)} className="float-right text-gray-400 hover:text-gray-600">×</button>
            {selected.kind === "concept" && idx.concepts.get(selected.id) && (
              <ConceptPanel concept={idx.concepts.get(selected.id)!} data={data} idx={idx}
                discusses={conceptPapers.get(selected.id) ?? []} onSelect={select} />
            )}
            {selected.kind === "paper" && idx.papers.get(selected.id) && (
              <PaperPanel paper={idx.papers.get(selected.id)!} data={data} idx={idx} onSelect={select}
                onAuthor={toggleAuthor} onRemap={() => startBuild(true, [selected.id])} busy={!!job?.running} />
            )}
            {selected.kind === "author" && idx.authors.get(selected.id) && (
              <AuthorPanel entry={idx.authors.get(selected.id)!} data={data} idx={idx} onSelect={select}
                filtered={authorFilter.has(selected.id)} onFilter={() => toggleAuthor(selected.id)} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Panels ──────────────────────────────────────────────────────────────────

type Idx = { papers: Map<string, MapPaper>; concepts: Map<string, MapConcept>; authors: Map<string, { author: Author; papers: string[] }> };

function KindBadge({ kind }: { kind: string }) {
  return <span className="text-[10px] px-1.5 py-0.5 rounded-full text-white" style={{ background: KIND_COLORS[kind] ?? "#64748b" }}>{kind}</span>;
}

function ConceptPanel({ concept, data, idx, discusses, onSelect }: {
  concept: MapConcept; data: MapData; idx: Idx; discusses: Discuss[]; onSelect: (s: Sel) => void;
}) {
  const related = data.concept_links.filter(l => l.source === concept.id || l.target === concept.id);
  const rows = [...discusses].sort((a, b) => (idx.papers.get(a.paper_id)?.year ?? 0) - (idx.papers.get(b.paper_id)?.year ?? 0));
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-gray-900 pr-6">{concept.name}</h2>
        <div className="flex items-center gap-1.5 mt-1"><KindBadge kind={concept.kind} />
          {concept.aliases.filter(a => a !== concept.name).map(a => <span key={a} className="text-[10px] text-gray-500 bg-gray-100 px-1.5 rounded">{a}</span>)}
        </div>
        {concept.definition && <p className="text-gray-600 mt-2">{concept.definition}</p>}
      </div>
      {related.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">Related concepts</h3>
          <ul className="space-y-1">
            {related.map(l => {
              const out = l.source === concept.id;
              const other = idx.concepts.get(out ? l.target : l.source);
              if (!other) return null;
              return (
                <li key={`${l.source}-${l.target}-${l.type}`} className="text-xs">
                  <span className="text-gray-400">{REL_TEXT[l.type]?.[out ? 0 : 1] ?? l.type} </span>
                  <button onClick={() => onSelect({ kind: "concept", id: other.id })} className="text-violet-700 hover:underline">{other.name}</button>
                  <span className="text-gray-400"> · {l.support.length} paper{l.support.length > 1 ? "s" : ""}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">Papers ({rows.length})</h3>
        <ul className="space-y-2.5">
          {rows.map(d => {
            const p = idx.papers.get(d.paper_id);
            if (!p) return null;
            return (
              <li key={d.paper_id} className="border-l-2 border-gray-100 pl-2">
                <button onClick={() => onSelect({ kind: "paper", id: p.id })} className="text-left text-xs font-medium text-gray-800 hover:text-violet-700">{p.title}</button>
                <p className="text-[11px] text-gray-400">{shortAuthors(p.authors)}{p.year ? ` · ${p.year}` : ""}{p.citation_count ? ` · ${p.citation_count} cit.` : ""}
                  <span className={`ml-1.5 px-1 rounded ${ROLE_STYLE[d.role] ?? ""}`}>{d.role}</span></p>
                {d.in_paper && <p className="text-[11px] text-gray-600 mt-0.5">{d.in_paper}</p>}
              </li>
            );
          })}
        </ul>
        {data.discusses.length > 0 && rows.length === 0 && <p className="text-xs text-gray-400">No visible paper (check filters).</p>}
      </div>
    </div>
  );
}

function PaperPanel({ paper, data, idx, onSelect, onAuthor, onRemap, busy }: {
  paper: MapPaper; data: MapData; idx: Idx; onSelect: (s: Sel) => void; onAuthor: (id: string) => void; onRemap: () => void; busy: boolean;
}) {
  const concepts = data.discusses.filter(d => d.paper_id === paper.id);
  const cites = data.citations.filter(c => c.source === paper.id).map(c => idx.papers.get(c.target)).filter(Boolean) as MapPaper[];
  const citedBy = data.citations.filter(c => c.target === paper.id).map(c => idx.papers.get(c.source)).filter(Boolean) as MapPaper[];
  const list = (title: string, ps: MapPaper[]) => ps.length > 0 && (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">{title} ({ps.length})</h3>
      <ul className="space-y-0.5">{ps.map(p => (
        <li key={p.id}><button onClick={() => onSelect({ kind: "paper", id: p.id })} className="text-left text-xs text-violet-700 hover:underline">{p.title}{p.year ? ` (${p.year})` : ""}</button></li>
      ))}</ul>
    </div>
  );
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-gray-900 pr-6">{paper.title}</h2>
        <p className="text-xs text-gray-500 mt-1">{[paper.year, paper.venue, paper.citation_count != null ? `${paper.citation_count} citations` : null].filter(Boolean).join(" · ")}</p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {paper.authors.map(a => (
            <button key={a.id} onClick={() => onSelect({ kind: "author", id: a.id })} onDoubleClick={() => onAuthor(a.id)}
              title="Click: author details · double-click: filter by author"
              className="text-[11px] bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded hover:bg-rose-100">{a.name}</button>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <Link to={`/paper/${paper.id}`} className="text-xs px-2.5 py-1 bg-violet-50 text-violet-700 rounded hover:bg-violet-100">Open paper →</Link>
          <button onClick={onRemap} disabled={busy} className="text-xs px-2.5 py-1 border border-gray-200 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50">Re-map</button>
        </div>
        {paper.map_error && <p className="text-xs text-red-600 mt-1">Last extraction failed: {paper.map_error}</p>}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">Concepts ({concepts.length})</h3>
        <ul className="space-y-2">{concepts.map(d => {
          const c = idx.concepts.get(d.concept_id);
          if (!c) return null;
          return (
            <li key={c.id}>
              <button onClick={() => onSelect({ kind: "concept", id: c.id })} className="text-xs font-medium text-gray-800 hover:text-violet-700">
                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: KIND_COLORS[c.kind] }} />{c.name}</button>
              <span className={`ml-1.5 text-[10px] px-1 rounded ${ROLE_STYLE[d.role] ?? ""}`}>{d.role}</span>
              {d.in_paper && <p className="text-[11px] text-gray-600">{d.in_paper}</p>}
            </li>
          );
        })}</ul>
        {!paper.mapped_at && <p className="text-xs text-gray-400">Not mapped yet.</p>}
      </div>
      {list("Cites in this project", cites)}
      {list("Cited by in this project", citedBy)}
    </div>
  );
}

function AuthorPanel({ entry, data, idx, onSelect, filtered, onFilter }: {
  entry: { author: Author; papers: string[] }; data: MapData; idx: Idx; onSelect: (s: Sel) => void; filtered: boolean; onFilter: () => void;
}) {
  const mine = new Set(entry.papers);
  const counts = new Map<string, number>();
  data.discusses.forEach(d => { if (mine.has(d.paper_id)) counts.set(d.concept_id, (counts.get(d.concept_id) ?? 0) + 1); });
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-gray-900 pr-6">{entry.author.name}</h2>
      <button onClick={onFilter} className="text-xs px-2.5 py-1 bg-rose-50 text-rose-700 rounded hover:bg-rose-100">
        {filtered ? "Remove author filter" : "Show only this author's papers"}</button>
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">Papers in project ({entry.papers.length})</h3>
        <ul className="space-y-0.5">{entry.papers.map(pid => idx.papers.get(pid)).filter(Boolean).map(p => (
          <li key={p!.id}><button onClick={() => onSelect({ kind: "paper", id: p!.id })} className="text-left text-xs text-violet-700 hover:underline">{p!.title}{p!.year ? ` (${p!.year})` : ""}</button></li>
        ))}</ul>
      </div>
      {top.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-1">Their concepts</h3>
          <div className="flex flex-wrap gap-1">{top.map(([cid, n]) => {
            const c = idx.concepts.get(cid);
            return c && (
              <button key={cid} onClick={() => onSelect({ kind: "concept", id: cid })}
                className="text-[11px] px-1.5 py-0.5 rounded-full border border-gray-200 hover:border-violet-300">
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ background: KIND_COLORS[c.kind] }} />{c.name}{n > 1 ? ` ×${n}` : ""}</button>
            );
          })}</div>
        </div>
      )}
    </div>
  );
}

function Overview({ data, conceptPapers, visibleConceptIds, hits, onSelect, selectedId }: {
  data: MapData | null; conceptPapers: Map<string, Discuss[]>; visibleConceptIds: Set<string>;
  hits: Set<string> | null; onSelect: (id: string) => void; selectedId?: string;
}) {
  if (!data) return null;
  const byKind = new Map<string, MapConcept[]>();
  data.concepts.forEach(c => {
    if (!visibleConceptIds.has(c.id) || (hits && !hits.has(c.id))) return;
    const arr = byKind.get(c.kind) ?? [];
    arr.push(c);
    byKind.set(c.kind, arr);
  });
  const max = Math.max(1, ...[...conceptPapers.values()].map(v => v.length));
  return (
    <div className="h-full overflow-y-auto p-6 bg-gray-50">
      <div className="columns-1 xl:columns-2 2xl:columns-3 gap-6">
        {Object.keys(KIND_COLORS).filter(k => byKind.has(k)).map(kind => {
          const list = byKind.get(kind)!.sort((a, b) => (conceptPapers.get(b.id)?.length ?? 0) - (conceptPapers.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name));
          return (
            <section key={kind} className="break-inside-avoid mb-6 bg-white rounded-lg border border-gray-200 p-3">
              <h3 className="text-xs font-semibold uppercase mb-2 flex items-center gap-1.5" style={{ color: KIND_COLORS[kind] }}>
                <span className="w-2 h-2 rounded-full" style={{ background: KIND_COLORS[kind] }} />{kind} · {list.length}</h3>
              <ul>{list.map(c => {
                const n = conceptPapers.get(c.id)?.length ?? 0;
                return (
                  <li key={c.id}>
                    <button onClick={() => onSelect(c.id)} title={c.definition ?? ""}
                      className={`w-full flex items-center gap-2 text-left text-xs py-0.5 px-1 rounded hover:bg-violet-50 ${selectedId === c.id ? "bg-violet-50" : ""}`}>
                      <span className="flex-1 truncate text-gray-800">{c.name}</span>
                      <span className="w-20 h-1.5 bg-gray-100 rounded"><span className="block h-1.5 rounded" style={{ width: `${(100 * n) / max}%`, background: KIND_COLORS[kind] }} /></span>
                      <span className="w-5 text-right text-gray-400">{n}</span>
                    </button>
                  </li>
                );
              })}</ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
