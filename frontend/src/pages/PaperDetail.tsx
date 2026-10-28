import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { mdPlugins, inlineMd } from "../lib/markdown";
import { apiFetch, extractReferences, aiExtractReferences, saveReferences, listReferences, ingestFromUrl, previewUrl, suggestTags, applyTags, createStandaloneTag, suggestTopics, fetchFigures, fetchTables, extractFiguresForPaper, chatWithFigure, deletePaper, removeAuthor, addAuthorByName, aiExtractAuthors, fetchGraph, fetchPaperInvolves, regenerateSummary, updatePaper, refetchPdf, reextractAbstract, aiExtractMetadata, parsePdf, fetchPaperProjects, listProjects, addPaperToProject, removePaperFromProject, getPaperClaims, extractPaperClaims, getRelatedPapers, discoverAdd, listAnnotations, exportPaperMarkdown, getOrCreatePerson, linkPersonInvolves, listConcepts } from "../api/client";
import NoteEditor from "../components/NoteEditor";
import ChatPanel from "../components/ChatPanel";
import EditPaperModal from "../components/EditPaperModal";
import BookChapters from "../components/BookChapters";
import PdfAnnotator from "../components/PdfAnnotator";
import type { PdfAnnotatorHandle, ConceptMark, PdfPageInfo } from "../components/PdfAnnotator";
import { CHAT_MODEL } from "../lib/chatModels";
import ConceptsPanel from "../components/concepts/ConceptsPanel";
import TourPanel, { type TourStop } from "../components/TourPanel";
import { SpecialZoomLevel } from "@react-pdf-viewer/core";
import UploadConfirmModal from "../components/UploadConfirmModal";
import OnboardingModal from "../components/OnboardingModal";
import { notify } from "../lib/notify";
import type { Paper, Person, Topic, Tag, Reference, Figure, PaperTable, GraphData, ParsedMeta, T_IngestOut, Claim, RelatedPaper, Annotation, AnnotationColor, Concept, ConceptsBackend, ConceptGeneration } from "../types";

const PAPER_GRAPH_NODE_COLORS: Record<string, string> = {
  paper: "#7c3aed", person: "#2563eb", topic: "#16a34a",
  tag: "#d97706", project: "#db2777", note: "#6b7280", unknown: "#9ca3af",
};

function resolveUserColor(name?: string, explicitColor?: string): string {
  if (explicitColor) return explicitColor;
  if (!name?.trim()) return "#94a3b8";
  const palette = [
    "#7c3aed", "#2563eb", "#0d9488", "#ea580c", "#db2777",
    "#16a34a", "#4f46e5", "#d97706", "#0891b2", "#be123c",
  ];
  const hash = [...name.trim().toLowerCase()].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

interface PaperFull extends Paper {
  authors?: Person[];
  topics?: Topic[];
  tags?: Tag[];
}

type RightTab = "notes" | "chat" | "highlights" | "concepts" | "tour";

export default function PaperDetail() {
  const { id } = useParams<{ id: string }>();
  const [paper, setPaper]     = useState<PaperFull | null>(null);
  const [authors, setAuthors] = useState<Person[]>([]);
  const [topics, setTopics]   = useState<Topic[]>([]);
  const [tags, setTags]       = useState<Tag[]>([]);
  const [newTag, setNewTag]   = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [tab, setTab]           = useState<RightTab>("notes");
  const [leftTab, setLeftTab]   = useState<"abstract" | "pdf" | "figures" | "tables" | "chapters" | "summary" | "references" | "graph" | "related" | "people" | "meta" | "claims">("abstract");
  // Figures
  const [figures, setFigures]         = useState<Figure[]>([]);
  const [figuresLoaded, setFiguresLoaded] = useState(false);
  const [tables, setTables]           = useState<PaperTable[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [figuresExtracting, setFiguresExtracting] = useState(false);
  const [figuresExtractStep, setFiguresExtractStep] = useState(0);
  const [selectedFigure, setSelectedFigure] = useState<Figure | null>(null);
  const [figureQuestion, setFigureQuestion] = useState("");
  const [figureAnswer, setFigureAnswer]     = useState<string | null>(null);
  const [figureAnswering, setFigureAnswering] = useState(false);
  // Graph tab
  const [graphData, setGraphData]   = useState<GraphData | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphInstanceRef  = useRef<unknown>(null);

  // People tab
  const [involves, setInvolves] = useState<{id: string; name: string; affiliation?: string; role: string; years_known?: string | null}[]>([]);
  const [involvesLoaded, setInvolvesLoaded] = useState(false);

  // Related papers tab
  const [relatedPapers, setRelatedPapers] = useState<RelatedPaper[]>([]);
  const [relatedKeywords, setRelatedKeywords] = useState<string[]>([]);
  const [relatedLoaded, setRelatedLoaded] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [addingRelatedIds, setAddingRelatedIds] = useState<Set<string>>(new Set());

  const [rightWidth, setRightWidth] = useState(320);
  const dragging = useRef(false);

  // PDF annotations + zoom (lifted for the legend bar and sidebar panel)
  const pdfRef = useRef<PdfAnnotatorHandle>(null);
  // The page in view, for the toolbar: PDF page numbers are what the chats and their warnings use.
  const [pdfPage, setPdfPage] = useState<PdfPageInfo | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pdfScale, setPdfScale] = useState<number | SpecialZoomLevel>(SpecialZoomLevel.PageWidth);
  const resolvedScale = useRef<number>(1);
  const [pdfInitialPage, setPdfInitialPage] = useState(0);

  // Interactive concepts (right-pane tab, marked on the PDF while that tab is open)
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [conceptsBackend, setConceptsBackend] = useState<ConceptsBackend | null>(null);
  const [conceptGeneration, setConceptGeneration] = useState<ConceptGeneration | null>(null);
  const [activeConceptId, setActiveConceptId] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    setConcepts([]);
    setConceptGeneration(null);
    setActiveConceptId(null);
    listConcepts(id)
      .then((r) => { setConcepts(r.concepts); setConceptsBackend(r.backend); setConceptGeneration(r.generation); })
      .catch(() => {});
  }, [id]);
  const [tourStops, setTourStops] = useState<TourStop[]>([]);
  const [activeStop, setActiveStop] = useState<number | null>(null);
  useEffect(() => { setTourStops([]); setActiveStop(null); }, [id]);
  const conceptMarks: ConceptMark[] | undefined = tab === "concepts"
    ? concepts.map((c) => ({ id: c.id, page: c.page, anchor: c.anchor, label: c.label, active: c.id === activeConceptId }))
    : tab === "tour"
    ? tourStops.map((s, i) => ({ id: `tour-${i}`, page: s.page, anchor: s.anchor, label: `${i + 1}. ${s.title}`, active: i === activeStop }))
    : undefined;
  const showPdfPage = (page: number) => {
    if (leftTab === "pdf") {
      pdfRef.current?.jumpToPage(page);
    } else {
      setPdfInitialPage(page);
      setLeftTab("pdf");
    }
  };

  const adjustScale = (delta: number) => {
    setPdfScale((s) => {
      const cur = typeof s === "number" ? s : resolvedScale.current;
      const next = Math.min(5, Math.max(0.1, Math.round((cur + delta) * 20) / 20));
      resolvedScale.current = next; // keep ref in sync for next press
      return next;
    });
  };

  // Color labels for the PDF legend
  const COLOR_LABELS: Record<AnnotationColor, string> = {
    yellow: "Key insight",
    green: "Evidence",
    blue: "Context",
    red: "Question",
    purple: "Follow-up",
  };
  const COLOR_SWATCH: Record<AnnotationColor, string> = {
    yellow: "#f5e800",
    green: "#00c850",
    blue: "#3884ff",
    red: "#ff3c3c",
    purple: "#a020f0",
  };
  const [references, setReferences] = useState<Reference[]>([]);
  const [citedBy, setCitedBy]       = useState<Reference[]>([]);
  const [extracting, setExtracting]         = useState(false);
  const [aiExtractingRefs, setAiExtractingRefs] = useState(false);
  const [pendingRefs, setPendingRefs]   = useState<Reference[] | null>(null);
  const [checkedRefs, setCheckedRefs]   = useState<boolean[]>([]);
  const [pullingDoi, setPullingDoi]     = useState<string | null>(null);
  const [pullingAll, setPullingAll]     = useState(false);
  const [pullAllProgress, setPullAllProgress] = useState<{done: number; total: number} | null>(null);
  // Inline URL import for refs without DOI
  const [refUrlInput, setRefUrlInput]       = useState<Record<number, string>>({});
  const [refUrlPulling, setRefUrlPulling]   = useState<number | null>(null);
  const [refUrlOpen, setRefUrlOpen]         = useState<number | null>(null);
  const [onboardingPaper, setOnboardingPaper] = useState<T_IngestOut | null>(null);
  // Ref confirm modal (Pull ↓ and Import ↓ go through UploadConfirmModal)
  const [refConfirmUrl, setRefConfirmUrl] = useState<string | null>(null);
  const [refConfirmMeta, setRefConfirmMeta] = useState<ParsedMeta | null>(null);
  // Upload PDF for a reference
  const [refUploadFile, setRefUploadFile]   = useState<File | null>(null);
  const [refUploadMeta, setRefUploadMeta]   = useState<ParsedMeta | null>(null);
  const [refUploadParsing, setRefUploadParsing] = useState(false);
  const refUploadInputRef = useRef<HTMLInputElement>(null);
  const pendingRefForUpload = useRef<Reference | null>(null);
  const [suggestingTags, setSuggestingTags] = useState(false);
  const [suggestedExisting, setSuggestedExisting] = useState<string[]>([]);
  const [suggestedNew, setSuggestedNew]     = useState<string[]>([]);
  const [allTagSuggestions, setAllTagSuggestions] = useState<string[]>([]);
  const [selectedSugTags, setSelectedSugTags]     = useState<Set<string>>(new Set());
  const [newTagDraft, setNewTagDraft] = useState("");
  const [tagSuggestOpen, setTagSuggestOpen] = useState(false);
  const [suggestingTopics, setSuggestingTopics] = useState(false);
  const [suggestedTopics, setSuggestedTopics] = useState<string[]>([]);
  const [selectedSugTopics, setSelectedSugTopics] = useState<Set<string>>(new Set());
  const [topicSuggestOpen, setTopicSuggestOpen] = useState(false);
  // Projects
  const [paperProjects, setPaperProjects] = useState<{id: string; name: string; description?: string}[]>([]);
  const [allProjects, setAllProjects]     = useState<{id: string; name: string; description?: string}[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  // Claims
  const [claims, setClaims] = useState<Claim[]>([]);
  const [claimsLoaded, setClaimsLoaded] = useState(false);
  const [extractingClaims, setExtractingClaims] = useState(false);
  // Authors (meta tab)
  const [newAuthorName, setNewAuthorName] = useState("");
  const [addingAuthor, setAddingAuthor] = useState(false);
  const [authorSuggestions, setAuthorSuggestions] = useState<{id: string; name: string; affiliation?: string}[]>([]);
  const [allPeople, setAllPeople] = useState<{id: string; name: string; affiliation?: string}[]>([]);
  const authorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiExtractingAuthors, setAiExtractingAuthors] = useState(false);
  const [aiExtractAuthorsError, setAiExtractAuthorsError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    apiFetch<PaperFull>(`/papers/${id}`).then(setPaper).catch(() => {});
    apiFetch<Person[]>(`/papers/${id}/authors`).then(setAuthors).catch(() => {});
    apiFetch<Topic[]>(`/papers/${id}/topics`).then(setTopics).catch(() => {});
    apiFetch<Tag[]>(`/papers/${id}/tags`).then(setTags).catch(() => {});
    listReferences(id)
      .then(({ references, cited_by }) => { setReferences(references); setCitedBy(cited_by); })
      .catch(() => {});
    apiFetch<{id: string; name: string; affiliation?: string}[]>("/people").then(setAllPeople).catch(() => {});
    listAnnotations(id).then(setAnnotations).catch(() => {});
  }, [id]);

  // Load figures lazily when left tab is first opened
  useEffect(() => {
    if (leftTab === "figures" && id && !figuresLoaded) {
      fetchFigures(id).then((figs) => { setFigures(figs); setFiguresLoaded(true); }).catch(() => setFiguresLoaded(true));
    }
  }, [leftTab, id, figuresLoaded]);

  // Load tables lazily
  useEffect(() => {
    if (leftTab === "tables" && id && !tablesLoaded) {
      fetchTables(id).then((tbls) => { setTables(tbls); setTablesLoaded(true); }).catch(() => setTablesLoaded(true));
    }
  }, [leftTab, id, tablesLoaded]);

  // Load projects lazily when meta tab is first opened
  useEffect(() => {
    if (leftTab === "meta" && id && !projectsLoaded) {
      Promise.all([fetchPaperProjects(id), listProjects()])
        .then(([pp, all]) => { setPaperProjects(pp); setAllProjects(all); setProjectsLoaded(true); })
        .catch(() => setProjectsLoaded(true));
    }
  }, [leftTab, id, projectsLoaded]);

  // Load involves lazily when people tab is first opened
  useEffect(() => {
    if (leftTab === "people" && id && !involvesLoaded) {
      fetchPaperInvolves(id).then((data) => { setInvolves(data); setInvolvesLoaded(true); }).catch(() => setInvolvesLoaded(true));
    }
  }, [leftTab, id, involvesLoaded]);

  // Load graph lazily when graph tab is first opened
  useEffect(() => {
    if (leftTab === "graph" && id && !graphLoaded) {
      fetchGraph(`paper&id=${id}`).then((data) => { setGraphData(data); setGraphLoaded(true); }).catch(() => setGraphLoaded(true));
    }
  }, [leftTab, id, graphLoaded]);

  // Load claims lazily when claims tab is first opened
  useEffect(() => {
    if (leftTab === "claims" && id && !claimsLoaded) {
      getPaperClaims(id).then((res) => { setClaims(res.claims); setClaimsLoaded(true); }).catch(() => setClaimsLoaded(true));
    }
  }, [leftTab, id, claimsLoaded]);

  // Load related papers lazily when related tab is first opened
  useEffect(() => {
    if (leftTab === "related" && id && !relatedLoaded) {
      setRelatedLoading(true);
      getRelatedPapers(id)
        .then((data) => {
          setRelatedPapers(data.related || []);
          setRelatedKeywords(data.search_keywords || []);
          setRelatedLoaded(true);
        })
        .catch(() => setRelatedLoaded(true))
        .finally(() => setRelatedLoading(false));
    }
  }, [leftTab, id, relatedLoaded]);

  // Build force-graph when graph data is ready
  useEffect(() => {
    if (!graphLoaded || !graphData || graphData.nodes.length === 0 || !graphContainerRef.current) return;

    import("force-graph").then(({ default: ForceGraph }) => {
      if (graphInstanceRef.current) {
        (graphInstanceRef.current as { _destructor?: () => void })?._destructor?.();
        if (graphContainerRef.current) graphContainerRef.current.innerHTML = "";
      }
      if (!graphContainerRef.current) return;

      const w = graphContainerRef.current.clientWidth;
      const h = graphContainerRef.current.clientHeight;

      const graph = ForceGraph()(graphContainerRef.current)
        .width(w)
        .height(h)
        .backgroundColor("#f9fafb")
        .nodeId("id")
        .nodeLabel((n: unknown) => (n as { label?: string }).label ?? "")
        .nodeColor((n: unknown) => PAPER_GRAPH_NODE_COLORS[(n as { type?: string }).type ?? "unknown"] ?? PAPER_GRAPH_NODE_COLORS.unknown)
        .nodeRelSize(6)
        .nodeCanvasObjectMode(() => "after")
        .nodeCanvasObject((node: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const n = node as { label?: string; x?: number; y?: number };
          if (!n.label || typeof n.x !== "number" || typeof n.y !== "number") return;
          const fontSize = Math.max(10 / globalScale, 2.5);
          ctx.font = `${fontSize}px Inter, sans-serif`;
          const display = n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label;
          const tw = ctx.measureText(display).width;
          const px = n.x, py = n.y + 6 + fontSize * 0.9;
          ctx.fillStyle = "rgba(249,250,251,0.85)";
          ctx.fillRect(px - tw / 2 - 2, py - fontSize / 2 - 1, tw + 4, fontSize + 2);
          ctx.fillStyle = "#1e293b";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(display, px, py);
        })
        .linkColor(() => "#cbd5e1")
        .linkWidth(1.5)
        .linkDirectionalArrowLength(6)
        .linkDirectionalArrowRelPos(1)
        .linkCanvasObjectMode(() => "after")
        .linkCanvasObject((link: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const l = link as { type?: string; source?: { x?: number; y?: number }; target?: { x?: number; y?: number } };
          const label = l.type ?? "";
          if (!label) return;
          const src = l.source, tgt = l.target;
          if (!src || !tgt || typeof src.x !== "number" || typeof tgt.x !== "number") return;
          const midX = (src.x! + tgt.x!) / 2;
          const midY = (src.y! + tgt.y!) / 2;
          const fontSize = Math.max(9 / globalScale, 2);
          ctx.font = `${fontSize}px Inter, sans-serif`;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(249,250,251,0.85)";
          ctx.fillRect(midX - tw / 2 - 2, midY - fontSize / 2 - 1, tw + 4, fontSize + 2);
          ctx.fillStyle = "#64748b";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, midX, midY);
        })
        .onNodeClick((n: unknown) => {
          const node = n as { type?: string; id?: string };
          if (node.type === "paper" && node.id && node.id !== id) navigate(`/paper/${node.id}`);
        })
        .graphData({
          nodes: graphData.nodes.map((n) => ({ ...n })),
          links: graphData.links.map((l) => ({ ...l })),
        });

      graphInstanceRef.current = graph;
    });

    return () => {
      if (graphInstanceRef.current) {
        (graphInstanceRef.current as { _destructor?: () => void })?._destructor?.();
        graphInstanceRef.current = null;
      }
    };
  }, [graphData, graphLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const [copiedTableId, setCopiedTableId] = useState<string | null>(null);
  const copyTable = (tbl: PaperTable) => {
    navigator.clipboard.writeText(tbl.markdown_content).then(() => {
      setCopiedTableId(tbl.id);
      setTimeout(() => setCopiedTableId(null), 1500);
    });
  };
  const [figuresExtractMsg, setFiguresExtractMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [refetching, setRefetching] = useState(false);
  const [refetchError, setRefetchError] = useState<string | null>(null);
  const [extractingAbstract, setExtractingAbstract] = useState(false);
  const [extractAbstractError, setExtractAbstractError] = useState<string | null>(null);
  const [aiExtracting, setAiExtracting] = useState(false);
  const [aiExtractError, setAiExtractError] = useState<string | null>(null);
  // Inline meta editing
  const [metaEdit, setMetaEdit] = useState<Partial<{ title: string; year: string; doi: string; venue: string; abstract: string }>>({});

  const EXTRACT_STEPS = ["Loading model…", "Rendering pages…", "Detecting figures…", "Saving images…"];

  useEffect(() => {
    if (!figuresExtracting) { setFiguresExtractStep(0); return; }
    setFiguresExtractStep(0);
    const id = setInterval(() => {
      setFiguresExtractStep((s) => (s + 1) % EXTRACT_STEPS.length);
    }, 3500);
    return () => clearInterval(id);
  }, [figuresExtracting]);

  const handleExtractFigures = async () => {
    if (!id) return;
    setFiguresExtracting(true);
    setSelectedFigure(null);
    setFigureAnswer(null);
    setFiguresExtractMsg(null);
    try {
      const res = await extractFiguresForPaper(id);
      const [figs, tbls] = await Promise.all([fetchFigures(id), fetchTables(id)]);
      setFigures(figs);
      setFiguresLoaded(true);
      setTables(tbls);
      setTablesLoaded(true);
      const tblMsg = (res as { tables_extracted?: number }).tables_extracted
        ? ` + ${(res as { tables_extracted: number }).tables_extracted} table(s)` : "";
      setFiguresExtractMsg(`${res.extracted} figure${res.extracted !== 1 ? "s" : ""}${tblMsg} extracted`);
    } catch (e) {
      setFiguresExtractMsg(e instanceof Error ? e.message : "Extraction failed");
    } finally {
      setFiguresExtracting(false);
    }
  };

  const handleFigureChat = async () => {
    if (!id || !selectedFigure || !figureQuestion.trim()) return;
    setFigureAnswering(true);
    setFigureAnswer(null);
    try {
      const res = await chatWithFigure(id, selectedFigure.id, figureQuestion.trim(), CHAT_MODEL);
      setFigureAnswer(res.answer);
    } catch (e) {
      setFigureAnswer(`Error: ${e instanceof Error ? e.message : "Chat failed"}`);
    } finally {
      setFigureAnswering(false);
    }
  };

  const handleExtract = async () => {
    if (!id) return;
    setExtracting(true);
    try {
      const { references: found } = await extractReferences(id);
      setPendingRefs(found);
      setCheckedRefs(found.map(() => true));
    } catch {
      // ignore
    } finally {
      setExtracting(false);
    }
  };

  const handleAiExtractRefs = async () => {
    if (!id) return;
    setAiExtractingRefs(true);
    try {
      const { references: found } = await aiExtractReferences(id);
      setPendingRefs(found);
      setCheckedRefs(found.map(() => true));
    } catch {
      // ignore
    } finally {
      setAiExtractingRefs(false);
    }
  };

  const handleSuggestTags = async () => {
    if (!id || !paper) return;
    setSuggestingTags(true);
    setTagSuggestOpen(true);
    try {
      const res = await suggestTags(paper.title, paper.abstract ?? undefined);
      setAllTagSuggestions(res.all_tags);
      setSuggestedExisting(res.existing);
      setSuggestedNew(res.new);
      const existing = tags.map((t) => t.name);
      setSelectedSugTags(new Set(res.existing.filter((t) => !existing.includes(t))));
    } finally {
      setSuggestingTags(false);
    }
  };

  const applyTagSuggestions = async () => {
    if (!id) return;
    const existing = tags.map((t) => t.name);
    const toApply = [...selectedSugTags].filter((t) => !existing.includes(t));
    const newOnes = toApply.filter((t) => !allTagSuggestions.includes(t));
    for (const name of newOnes) await createStandaloneTag(name);
    if (toApply.length) await applyTags(id, toApply);
    setTags(await apiFetch<Tag[]>(`/papers/${id}/tags`));
    setTagSuggestOpen(false);
    setSelectedSugTags(new Set());
  };

  const handleSuggestTopics = async () => {
    if (!id) return;
    setSuggestingTopics(true);
    setTopicSuggestOpen(true);
    try {
      const res = await suggestTopics(id);
      const existing = topics.map((t) => t.name);
      const fresh = res.topics.filter((t) => !existing.includes(t));
      setSuggestedTopics(res.topics);
      setSelectedSugTopics(new Set(fresh));
    } finally {
      setSuggestingTopics(false);
    }
  };

  const applyTopicSuggestions = async () => {
    if (!id) return;
    const existing = topics.map((t) => t.name);
    for (const name of selectedSugTopics) {
      if (!existing.includes(name)) {
        await apiFetch(`/papers/${id}/topics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
      }
    }
    setTopics(await apiFetch<Topic[]>(`/papers/${id}/topics`));
    setTopicSuggestOpen(false);
    setSelectedSugTopics(new Set());
  };

  const handlePullReference = async (doi: string, refTitle?: string, refYear?: number | null) => {
    setPullingDoi(doi);
    try {
      let meta: ParsedMeta;
      try {
        meta = await previewUrl(doi);
      } catch {
        meta = { title: refTitle ?? "", doi, year: refYear ?? undefined, authors: [], metadata_source: "doi" };
      }
      setRefConfirmUrl(doi);
      setRefConfirmMeta(meta);
    } catch { /* ignore */ }
    finally { setPullingDoi(null); }
  };

  const handlePullAllRefs = async () => {
    if (!id || pullingAll) return;
    const stubs = references.filter((ref) => !(ref as any).summary && !!ref.doi);
    if (stubs.length === 0) return;
    setPullingAll(true);
    setPullAllProgress({ done: 0, total: stubs.length });
    for (let i = 0; i < stubs.length; i++) {
      try { await ingestFromUrl(stubs[i].doi!); } catch { /* skip failed */ }
      setPullAllProgress({ done: i + 1, total: stubs.length });
    }
    const { references: refs, cited_by } = await listReferences(id);
    setReferences(refs);
    setCitedBy(cited_by);
    setPullingAll(false);
    setPullAllProgress(null);
  };

  const handlePullRefByUrl = async (idx: number) => {
    const url = refUrlInput[idx]?.trim();
    if (!url || !id) return;
    setRefUrlPulling(idx);
    try {
      const meta = await previewUrl(url);
      setRefUrlOpen(null);
      setRefUrlInput((prev) => { const n = { ...prev }; delete n[idx]; return n; });
      setRefConfirmUrl(url);
      setRefConfirmMeta(meta);
    } catch { /* leave input open so user can correct */ }
    finally { setRefUrlPulling(null); }
  };

  const handleRefFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !pendingRefForUpload.current) return;
    const ref = pendingRefForUpload.current;
    setRefUploadParsing(true);
    try {
      const parsed = await parsePdf(f);
      setRefUploadMeta({
        ...parsed,
        title: parsed.title || ref.title || "",
        doi:   parsed.doi   || ref.doi   || null,
        year:  parsed.year  || ref.year  || null,
      });
      setRefUploadFile(f);
    } catch {
      setRefUploadMeta({
        title: ref.title || "",
        doi:   ref.doi   ?? undefined,
        year:  ref.year  ?? undefined,
        authors: [],
        metadata_source: "heuristic",
      });
      setRefUploadFile(f);
    } finally {
      setRefUploadParsing(false);
    }
  };

  const handleSaveRefs = async () => {
    if (!id || !pendingRefs) return;
    const selected = pendingRefs.filter((_, i) => checkedRefs[i]);
    if (selected.length > 0) {
      await saveReferences(id, selected).catch(() => {});
      const { references, cited_by } = await listReferences(id).catch(() => ({ references: [], cited_by: [] }));
      setReferences(references);
      setCitedBy(cited_by);
    }
    setPendingRefs(null);
  };

  const handleDeletePaper = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await deletePaper(id);
      navigate("/");
    } catch (e) {
      setDeleting(false);
      setConfirmDelete(false);
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleExtractClaims = async () => {
    if (!id) return;
    setExtractingClaims(true);
    try {
      const res = await extractPaperClaims(id);
      setClaims(res.claims);
      setClaimsLoaded(true);
    } catch (error) {
      console.error("Failed to extract claims:", error);
      alert("Failed to extract claims. Make sure the paper has text content.");
    } finally {
      setExtractingClaims(false);
    }
  };

  const saveModalMetadata = async (next: { tags: string[]; topics: string[] }) => {
    if (!id) return { tags, topics };

    const currentTagNames = tags.map((tag) => tag.name);
    const currentTopicNames = topics.map((topic) => topic.name);

    const tagsToAdd = next.tags.filter((name) => !currentTagNames.includes(name));
    const tagsToRemove = currentTagNames.filter((name) => !next.tags.includes(name));
    const topicsToAdd = next.topics.filter((name) => !currentTopicNames.includes(name));
    const topicsToRemove = currentTopicNames.filter((name) => !next.topics.includes(name));

    await Promise.all([
      ...tagsToAdd.map((name) => apiFetch(`/papers/${id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })),
      ...tagsToRemove.map((name) => apiFetch(`/papers/${id}/tags/${encodeURIComponent(name)}`, { method: "DELETE" })),
      ...topicsToAdd.map((name) => apiFetch(`/papers/${id}/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })),
      ...topicsToRemove.map((name) => apiFetch(`/papers/${id}/topics/${encodeURIComponent(name)}`, { method: "DELETE" })),
    ]);

    const [nextTags, nextTopics] = await Promise.all([
      apiFetch<Tag[]>(`/papers/${id}/tags`),
      apiFetch<Topic[]>(`/papers/${id}/topics`),
    ]);

    return { tags: nextTags, topics: nextTopics };
  };

  const addTag = async () => {
    if (!newTag.trim() || !id) return;
    await apiFetch(`/papers/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTag.trim() }),
    });
    setTags(await apiFetch<Tag[]>(`/papers/${id}/tags`));
    setNewTag("");
  };

  const addTopic = async () => {
    if (!newTopic.trim() || !id) return;
    await apiFetch(`/papers/${id}/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTopic.trim() }),
    });
    setTopics(await apiFetch<Topic[]>(`/papers/${id}/topics`));
    setNewTopic("");
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = window.innerWidth - ev.clientX;
      setRightWidth(Math.min(700, Math.max(240, next)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!paper) return <div className="p-8 text-sm text-gray-400">Loading…</div>;

  const BASE        = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
  // Files kept on the server's disk (STORAGE_MODE=local) have no Drive page.
  const driveUrl    = paper.drive_file_id && !paper.drive_file_id.startsWith("local-") ? `https://drive.google.com/file/d/${paper.drive_file_id}/view` : null;
  const driveEmbed  = paper.drive_file_id ? `${BASE}/papers/${paper.id}/pdf` : null;

  const cycleStatus = async () => {
    if (!id) return;
    const cycle: Array<Paper["reading_status"]> = ["unread", "reading", "read"];
    const current = paper.reading_status ?? "unread";
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    const prev = paper;
    setPaper((p) => p ? { ...p, reading_status: next } : p);
    try {
      const updated = await apiFetch<Paper>(`/papers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reading_status: next }),
      });
      setPaper((p) => p ? { ...p, ...updated } : p);
    } catch {
      setPaper(prev);
      notify("Couldn't update reading status. Please try again.");
    }
  };

  const toggleBookmark = async () => {
    if (!id) return;
    const newVal = !paper.bookmarked;
    const prev = paper;
    setPaper((p) => p ? { ...p, bookmarked: newVal } : p);
    try {
      const updated = await apiFetch<Paper>(`/papers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: newVal }),
      });
      setPaper((p) => p ? { ...p, ...updated } : p);
    } catch {
      setPaper(prev);
      notify("Couldn't update bookmark. Please try again.");
    }
  };

  const setRating = async (stars: number) => {
    if (!id) return;
    const newRating = paper.rating === stars ? null : stars;
    const prev = paper;
    setPaper((p) => p ? { ...p, rating: newRating ?? undefined } : p);
    try {
      const updated = await apiFetch<Paper>(`/papers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: newRating }),
      });
      setPaper((p) => p ? { ...p, ...updated } : p);
    } catch {
      setPaper(prev);
      notify("Couldn't update rating. Please try again.");
    }
  };

  const downloadBibtex = async () => {
    const res = await fetch(`${BASE}/papers/${id}/bibtex`, { credentials: "include" });
    if (!res.ok) return;
    const text = await res.text();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${paper.title.slice(0, 40).replace(/[^\w\s]/g, "").trim()}.bib`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => exportPaperMarkdown(id!);

  const downloadPdf = async () => {
    if (!driveEmbed || !paper) return;
    const res = await fetch(driveEmbed);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${paper.title.slice(0, 40).replace(/[^\w\s]/g, "").trim()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddRelated = async (related: RelatedPaper) => {
    const key = related.url;
    setAddingRelatedIds((prev) => new Set(prev).add(key));
    try {
      const addedPaper = await discoverAdd(related.url);
      // Update the related paper to mark it as in library
      setRelatedPapers((prev) =>
        prev.map((r) =>
          r.url === related.url
            ? { ...r, in_library: true, library_paper_id: addedPaper.id }
            : r
        )
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add paper");
    } finally {
      setAddingRelatedIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const STATUS_STYLES: Record<string, string> = {
    unread:  "bg-gray-100 text-gray-500",
    reading: "bg-blue-100 text-blue-600",
    read:    "bg-green-100 text-green-600",
  };
  const STATUS_LABELS: Record<string, string> = {
    unread: "📚 Unread",
    reading: "📖 Reading",
    read: "✅ Read",
  };
  const currentStatus = paper.reading_status ?? "unread";
  const uploaderColor = resolveUserColor(paper.added_by, paper.added_by_color);

  return (
    <div className="h-[calc(100vh-53px)] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shrink-0 flex-wrap gap-2">
        <Link to="/" className="text-sm text-violet-600 hover:underline shrink-0">← Library</Link>
        <h1 className="text-sm font-medium text-gray-700 truncate max-w-md flex-1 text-center">{paper.title}</h1>

        {/* Paper controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Reading status */}
          <button
            type="button"
            onClick={cycleStatus}
            title="Click to cycle reading status"
            className={`text-xs px-2 py-1 rounded-full font-medium transition-colors ${STATUS_STYLES[currentStatus]}`}
          >
            {STATUS_LABELS[currentStatus]}
          </button>

          {/* Stars */}
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                title={`Rate ${star} star${star > 1 ? "s" : ""}`}
                className={`text-base leading-none transition-colors ${
                  star <= (paper.rating ?? 0) ? "text-amber-400" : "text-gray-200 hover:text-amber-300"
                }`}
              >
                ★
              </button>
            ))}
          </div>

          {paper.added_by && (
            <span
              className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600"
              title={`Uploaded by ${paper.added_by}`}
            >
              <span
                className="w-2 h-2 rounded-full border border-white/80 shrink-0"
                style={{ backgroundColor: uploaderColor }}
              />
              {paper.added_by}
            </span>
          )}

          {/* Bookmark */}
          <button
            type="button"
            onClick={toggleBookmark}
            title={paper.bookmarked ? "Remove bookmark" : "Bookmark"}
            className={`text-lg leading-none transition-colors ${paper.bookmarked ? "text-amber-400" : "text-gray-300 hover:text-amber-300"}`}
          >
            ★
          </button>

          {/* BibTeX download */}
          <button
            onClick={downloadBibtex}
            title="Download BibTeX"
            className="text-xs text-gray-400 hover:text-violet-600 transition-colors px-2 py-1 border border-gray-200 rounded-lg"
          >
            .bib
          </button>

          {/* Markdown export */}
          <button
            onClick={downloadMarkdown}
            title="Export all paper data as Markdown"
            className="text-xs text-gray-400 hover:text-violet-600 transition-colors px-2 py-1 border border-gray-200 rounded-lg"
          >
            .md
          </button>

          {/* PDF download */}
          <button
            onClick={downloadPdf}
            title={driveEmbed ? "Download PDF" : "No PDF uploaded"}
            disabled={!driveEmbed}
            className="text-xs text-gray-400 hover:text-violet-600 transition-colors px-2 py-1 border border-gray-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-gray-400"
          >
            .pdf
          </button>

        </div>
      </div>

      {/* Main two-column layout */}
      <div className="flex-1 flex overflow-hidden">

        {/* LEFT — abstract / PDF */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-gray-200 bg-white shrink-0">
            <button
              onClick={() => setLeftTab("abstract")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "abstract"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Abstract
            </button>
            {driveEmbed && (
              <button
                onClick={() => setLeftTab("pdf")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                  leftTab === "pdf"
                    ? "border-violet-600 text-violet-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                PDF
              </button>
            )}
            <button
              onClick={() => setLeftTab("figures")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "figures"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {figuresLoaded && figures.length > 0 ? `Figures (${figures.length})` : "Figures"}
            </button>
            <button
              onClick={() => setLeftTab("tables")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "tables"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tablesLoaded && tables.length > 0 ? `Tables (${tables.length})` : "Tables"}
            </button>
            {(paper.document_type === "book" || paper.document_type === "lecture_deck") && (
              <button
                onClick={() => setLeftTab("chapters")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                  leftTab === "chapters"
                    ? "border-violet-600 text-violet-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                📚 Chapters
              </button>
            )}
            <button
              onClick={() => setLeftTab("summary")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "summary"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Summary
            </button>
            <button
              onClick={() => setLeftTab("references")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "references"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {references.length > 0 || citedBy.length > 0
                ? `References (${references.length + citedBy.length})`
                : "References"}
            </button>
            <button
              onClick={() => setLeftTab("graph")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "graph"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Graph
            </button>
            <button
              onClick={() => setLeftTab("related")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "related"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Related
            </button>
            <button
              onClick={() => setLeftTab("people")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "people"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              People
            </button>
            <button
              onClick={() => setLeftTab("meta")}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                leftTab === "meta"
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Metadata
            </button>
            {!(paper.document_type === "book" || paper.document_type === "lecture_deck") && (
              <button
                onClick={() => setLeftTab("claims")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                  leftTab === "claims"
                    ? "border-violet-600 text-violet-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {claimsLoaded && claims.length > 0 ? `Claims (${claims.length})` : "Claims"}
              </button>
            )}
            {driveUrl && (
              <a
                href={driveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto mb-1 flex items-center gap-1 text-xs text-gray-400 hover:text-violet-600 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                Open in Drive
              </a>
            )}
          </div>

          {/* Abstract tab */}
          {leftTab === "abstract" && (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-2xl mx-auto px-8 py-10 space-y-6">
                <div>
                  <h2 className="text-xl font-semibold text-gray-900 leading-snug">{paper.title}</h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {paper.year || paper.venue ? (
                      <p className="text-xs text-gray-400">
                        {paper.year}{paper.venue ? ` · ${paper.venue}` : ""}
                      </p>
                    ) : null}
                    {paper.document_type && paper.document_type !== "paper" && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${paper.document_type === "book" ? "bg-amber-100 text-amber-700" : paper.document_type === "news_article" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
                        {paper.document_type === "book" ? "📚 Book" : paper.document_type === "news_article" ? "📰 News article" : "🎓 Lecture deck"}
                      </span>
                    )}
                  </div>
                  {authors.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
                      {authors.map((a) => (
                        <span key={a.id} className="group flex items-center gap-1 text-sm text-gray-600">
                          <Link to={`/people?id=${a.id}`} className="hover:text-violet-600 transition-colors">
                            {a.name}
                          </Link>
                          {a.affiliation && (
                            <span className="text-xs text-gray-400">({a.affiliation})</span>
                          )}
                          <button
                            onClick={async () => {
                              if (!id) return;
                              await removeAuthor(id, a.id);
                              setAuthors((prev) => prev.filter((p) => p.id !== a.id));
                            }}
                            title="Remove from paper"
                            className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all text-xs leading-none"
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Abstract</p>
                  {paper.abstract ? (
                    <textarea
                      defaultValue={paper.abstract}
                      onBlur={async (e) => {
                        const val = e.target.value.trim();
                        if (val === (paper.abstract ?? "").trim() || !id) return;
                        const updated = await updatePaper(id, { abstract: val || null });
                        setPaper((p) => p ? { ...p, ...updated } : p);
                      }}
                      rows={14}
                      className="w-full text-sm text-gray-700 leading-relaxed border border-transparent hover:border-gray-200 focus:border-violet-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 resize-y bg-transparent focus:bg-white transition-colors"
                    />
                  ) : (
                    <textarea
                      placeholder="No abstract — click to add one…"
                      onBlur={async (e) => {
                        const val = e.target.value.trim();
                        if (!val || !id) return;
                        const updated = await updatePaper(id, { abstract: val });
                        setPaper((p) => p ? { ...p, ...updated } : p);
                      }}
                      rows={8}
                      className="w-full text-sm text-gray-400 leading-relaxed border border-dashed border-gray-200 hover:border-violet-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 resize-y bg-transparent focus:bg-white focus:text-gray-700 transition-colors"
                    />
                  )}
                </div>

                {paper.doi && (
                  <p className="text-xs text-gray-400">
                    DOI: <span className="font-mono">{paper.doi}</span>
                    {paper.citation_count != null && ` · ${paper.citation_count.toLocaleString()} citations`}
                  </p>
                )}

                {/* Delete */}
                <div className="pt-4 border-t border-gray-100">
                  {!confirmDelete ? (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Delete this paper…
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-xs text-red-700 flex-1">
                        This will permanently delete the paper, its PDF, all figures, and its note.
                        People, tags, and topics are kept.
                      </p>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                        className="shrink-0 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleDeletePaper}
                        disabled={deleting}
                        className="shrink-0 text-xs font-medium bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Summary tab */}
          {leftTab === "summary" && (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-2xl mx-auto px-8 py-10 space-y-5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">AI Summary</p>
                  <button
                    onClick={async () => {
                      if (!id || regenerating) return;
                      setRegenerating(true);
                      try {
                        const res = await regenerateSummary(id);
                        setPaper((p) => p ? { ...p, summary: res.summary } : p);
                      } catch (e) {
                        alert(e instanceof Error ? e.message : "Failed to regenerate summary");
                      } finally {
                        setRegenerating(false);
                      }
                    }}
                    disabled={regenerating}
                    className="text-xs px-3 py-1.5 bg-violet-50 text-violet-700 rounded-lg hover:bg-violet-100 disabled:opacity-50 font-medium flex items-center gap-1.5"
                  >
                    {regenerating && (
                      <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    )}
                    {regenerating ? "Regenerating…" : "✦ Re-generate"}
                  </button>
                </div>
                {paper.summary ? (
                  <div className="prose prose-sm max-w-none text-gray-700 prose-headings:text-gray-800 prose-a:text-violet-600">
                    <ReactMarkdown {...mdPlugins}>{paper.summary}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 italic">
                    No summary yet. Click "✦ Re-generate" to create one using AI.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* References tab */}
          {leftTab === "references" && (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-2xl mx-auto px-8 py-8 space-y-5">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleExtract}
                    disabled={extracting || aiExtractingRefs || pullingAll}
                    className="text-xs py-2 px-4 bg-violet-50 text-violet-700 rounded-lg hover:bg-violet-100 disabled:opacity-50 font-medium"
                  >
                    {extracting ? "Extracting…" : "Extract from PDF"}
                  </button>
                  <button
                    onClick={handleAiExtractRefs}
                    disabled={aiExtractingRefs || extracting || pullingAll}
                    className="text-xs py-2 px-4 bg-violet-100 text-violet-700 rounded-lg hover:bg-violet-200 disabled:opacity-50 font-medium flex items-center gap-1.5"
                  >
                    {aiExtractingRefs && (
                      <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                    )}
                    {aiExtractingRefs ? "Extracting…" : "✦ Extract with AI"}
                  </button>
                  {references.some((ref) => !(ref as any).summary && ref.doi) && (
                    <button
                      onClick={handlePullAllRefs}
                      disabled={pullingAll || extracting}
                      className="text-xs py-2 px-4 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 font-medium flex items-center gap-1.5"
                    >
                      {pullingAll && (
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                      )}
                      {pullingAll
                        ? `Pulling ${pullAllProgress?.done}/${pullAllProgress?.total}…`
                        : `Pull all into library (${references.filter((r) => !(r as any).summary && r.doi).length})`}
                    </button>
                  )}
                </div>

                {pendingRefs && (
                  <div className="border border-violet-200 rounded-xl overflow-hidden">
                    <div className="bg-violet-50 px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs font-semibold text-violet-700">
                        {pendingRefs.length} found — pick which to save
                      </span>
                      <button
                        onClick={() => setCheckedRefs(checkedRefs.every(Boolean) ? checkedRefs.map(() => false) : checkedRefs.map(() => true))}
                        className="text-[10px] text-violet-500 hover:text-violet-700 underline"
                      >
                        {checkedRefs.every(Boolean) ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {pendingRefs.map((ref, i) => (
                        <label key={i} className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${checkedRefs[i] ? "bg-white" : "bg-gray-50"} hover:bg-violet-50`}>
                          <input
                            type="checkbox"
                            className="mt-0.5 shrink-0 accent-violet-600"
                            checked={checkedRefs[i] ?? true}
                            onChange={(e) => { const next = [...checkedRefs]; next[i] = e.target.checked; setCheckedRefs(next); }}
                          />
                          <div className="min-w-0">
                            <p className={`text-xs leading-snug ${checkedRefs[i] ? "text-gray-800 font-medium" : "text-gray-400"}`}>{ref.title}</p>
                            {(ref.year || ref.doi) && (
                              <p className="text-[10px] text-gray-400 mt-0.5">{[ref.year, ref.doi].filter(Boolean).join(" · ")}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
                      <button onClick={() => setPendingRefs(null)} className="text-xs text-gray-400 hover:text-gray-600">Discard</button>
                      <button
                        onClick={handleSaveRefs}
                        disabled={checkedRefs.every((c) => !c)}
                        className="ml-auto text-xs bg-violet-600 text-white px-4 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-40 font-medium"
                      >
                        Save {checkedRefs.filter(Boolean).length}
                      </button>
                    </div>
                  </div>
                )}

                {references.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Cites · {references.length}</p>
                    <div className="space-y-1.5">
                      {references.map((ref, i) => {
                        const isPulled = !!(ref as any).summary;
                        const doi = ref.doi;
                        const isStub = !isPulled && !!doi;
                        const isNoDoi = !isPulled && !doi;
                        const isPulling = pullingDoi === doi;
                        return (
                          <div
                            key={i}
                            className={`rounded-lg border px-3 py-2.5 group transition-colors ${isPulled ? "border-violet-100 bg-violet-50 hover:bg-violet-100 cursor-pointer" : "border-gray-100 bg-white"}`}
                            onClick={() => isPulled && navigate(`/paper/${ref.id}`)}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-xs font-medium text-gray-800 leading-snug">{ref.title}</p>
                              {isPulled && <span className="shrink-0 text-[10px] text-green-600 font-semibold mt-0.5">✓ In library</span>}
                              {isStub && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handlePullReference(doi!, ref.title, ref.year); }}
                                    disabled={isPulling || refUploadParsing}
                                    className="text-[10px] font-medium bg-white border border-violet-200 text-violet-600 px-2 py-0.5 rounded-full hover:bg-violet-50 disabled:opacity-50"
                                  >
                                    {isPulling ? "…" : "Pull ↓"}
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); pendingRefForUpload.current = ref; refUploadInputRef.current?.click(); }}
                                    disabled={refUploadParsing}
                                    title="Upload PDF for this reference"
                                    className="text-[10px] font-medium bg-white border border-gray-200 text-gray-500 px-2 py-0.5 rounded-full hover:border-violet-300 hover:text-violet-600 disabled:opacity-50"
                                  >
                                    {refUploadParsing && pendingRefForUpload.current === ref ? "…" : "PDF ↑"}
                                  </button>
                                </div>
                              )}
                              {isNoDoi && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setRefUrlOpen(refUrlOpen === i ? null : i); }}
                                  className="shrink-0 text-[10px] font-medium bg-white border border-gray-200 text-gray-500 px-2 py-0.5 rounded-full hover:border-violet-300 hover:text-violet-600"
                                >
                                  Import ↓
                                </button>
                              )}
                            </div>
                            {isNoDoi && refUrlOpen === i && (
                              <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <input
                                  autoFocus
                                  value={refUrlInput[i] ?? ""}
                                  onChange={(e) => setRefUrlInput((prev) => ({ ...prev, [i]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") handlePullRefByUrl(i); if (e.key === "Escape") setRefUrlOpen(null); }}
                                  placeholder="Paste URL or DOI…"
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-300"
                                />
                                <button
                                  onClick={() => handlePullRefByUrl(i)}
                                  disabled={refUrlPulling === i || !refUrlInput[i]?.trim()}
                                  className="text-[10px] px-2 py-1 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50"
                                >
                                  {refUrlPulling === i ? "…" : "Pull"}
                                </button>
                              </div>
                            )}
                            {(ref.year || doi) && (
                              <p className="text-[10px] text-gray-400 mt-1">{[ref.year, doi?.replace("arXiv:", "arXiv: ")].filter(Boolean).join(" · ")}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {citedBy.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Cited by · {citedBy.length}</p>
                    <div className="space-y-1.5">
                      {citedBy.map((ref, i) => (
                        <div
                          key={i}
                          className={`rounded-lg border px-3 py-2.5 transition-colors ${ref.id ? "border-violet-100 bg-violet-50 hover:bg-violet-100 cursor-pointer" : "border-gray-100 bg-white"}`}
                          onClick={() => ref.id && navigate(`/paper/${ref.id}`)}
                        >
                          <p className="text-xs font-medium text-gray-800 leading-snug">{ref.title}</p>
                          {ref.year && <p className="text-[10px] text-gray-400 mt-1">{ref.year}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {references.length === 0 && citedBy.length === 0 && !pendingRefs && (
                  <p className="text-xs text-gray-400 text-center pt-6">No references saved yet.</p>
                )}
              </div>
            </div>
          )}

          {/* PDF tab */}
          {leftTab === "pdf" && paper?.drive_file_id && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Color legend + zoom control */}
              <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-gray-100 bg-white text-[10px] text-gray-500">
                <span className="font-medium text-gray-400 uppercase tracking-wide text-[9px] shrink-0">Colors:</span>
                <div className="flex items-center gap-2.5 flex-wrap flex-1">
                  {(["yellow", "green", "blue", "red", "purple"] as AnnotationColor[]).map((c) => (
                    <span key={c} className="flex items-center gap-1 whitespace-nowrap">
                      <span className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0" style={{ background: COLOR_SWATCH[c] }} />
                      {COLOR_LABELS[c]}
                    </span>
                  ))}
                </div>
                {pdfPage && (
                  <span className="shrink-0 ml-auto tabular-nums text-gray-500" data-testid="pdf-page-indicator">
                    PDF page {pdfPage.page} / {pdfPage.total}
                    {pdfPage.label && pdfPage.label !== String(pdfPage.page) && (
                      <span className="text-gray-400"> · printed {pdfPage.label}</span>
                    )}
                  </span>
                )}
                {/* Zoom control */}
                <div className="flex items-center gap-1 shrink-0 ml-auto">
                  <button
                    onClick={() => setPdfScale(SpecialZoomLevel.PageWidth)}
                    className="text-[10px] px-1.5 h-5 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600"
                  >Fit</button>
                  <button
                    onClick={() => adjustScale(-0.05)}
                    disabled={pdfScale <= 0.25}
                    className="w-5 h-5 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-30 text-xs"
                  >−</button>
                  <span className="font-mono text-[10px] text-gray-600 w-9 text-center">
                    {typeof pdfScale === "number" ? `${Math.round(pdfScale * 100)}%` : "fit"}
                  </span>
                  <button
                    onClick={() => adjustScale(0.05)}
                    disabled={typeof pdfScale === "number" && pdfScale >= 5}
                    className="w-5 h-5 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-30 text-xs"
                  >+</button>
                </div>
              </div>
              <PdfAnnotator
                ref={pdfRef}
                paperId={id!}
                pdfUrl={`${BASE}/papers/${id}/pdf`}
                onHighlightsChange={setAnnotations}
                scale={pdfScale}
                initialPage={pdfInitialPage}
                onScaleResolved={(s) => { resolvedScale.current = s; }}
                onPageInfo={setPdfPage}
                conceptMarks={conceptMarks}
                onConceptClick={(cid) => {
                  if (cid.startsWith("tour-")) { setActiveStop(Number(cid.slice(5))); return; }
                  setTab("concepts"); setActiveConceptId(cid);
                }}
              />
            </div>
          )}
          {leftTab === "pdf" && !paper?.drive_file_id && (
            <p className="text-xs text-gray-400 text-center pt-6">No PDF available.</p>
          )}

          {/* People tab */}
          {leftTab === "people" && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5 space-y-6">

                {/* Authors */}
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Authors</p>
                  {authors.length === 0 ? (
                    <p className="text-xs text-gray-400">No authors recorded.</p>
                  ) : (
                    <div className="space-y-2">
                      {authors.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3">
                          <div>
                            <Link to={`/people?id=${a.id}`} className="text-sm font-medium text-gray-800 hover:text-violet-600 transition-colors">
                              {a.name}
                            </Link>
                            {a.affiliation && (
                              <p className="text-xs text-gray-400 mt-0.5">{a.affiliation}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-medium bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full">author</span>
                            <button
                              onClick={async () => {
                                if (!id) return;
                                await removeAuthor(id, a.id);
                                setAuthors((prev) => prev.filter((p) => p.id !== a.id));
                              }}
                              title="Remove from paper"
                              className="text-gray-300 hover:text-red-400 transition-colors text-sm leading-none"
                            >×</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Involved people */}
                {involvesLoaded && involves.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Involved</p>
                    <div className="space-y-2">
                      {involves.map((p) => (
                        <div key={`${p.id}-${p.role}`} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3">
                          <div>
                            <Link to={`/people?id=${p.id}`} className="text-sm font-medium text-gray-800 hover:text-violet-600 transition-colors">
                              {p.name}
                            </Link>
                            {p.affiliation && (
                              <p className="text-xs text-gray-400 mt-0.5">{p.affiliation}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] font-medium bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full">
                              {p.role.replace("_", " ")}
                            </span>
                            {p.years_known && (
                              <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                                {p.years_known}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add involves form */}
                {involvesLoaded && (
                  <AddInvolvesForm paperId={id!} onAdded={(p) => setInvolves((prev) => [...prev, p])} />
                )}

                {!involvesLoaded && <p className="text-xs text-gray-400">Loading…</p>}
              </div>
            </div>
          )}

          {/* Meta tab */}
          {leftTab === "meta" && (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-xl mx-auto px-6 py-5 space-y-6">

                {/* Editable fields */}
                <MetaSection title="Paper info">
                  <div className="space-y-2">
                    {(["title", "year", "venue", "doi", "abstract"] as const).map((field) => {
                      const currentVal = String(paper[field] ?? "");
                      const editVal = metaEdit[field] ?? currentVal;
                      const isDirty = editVal !== currentVal;
                      return (
                        <div key={field}>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">{field}</p>
                          {field === "abstract" ? (
                            <div className="space-y-1">
                            <textarea
                              value={editVal}
                              onChange={(e) => setMetaEdit((s) => ({ ...s, [field]: e.target.value }))}
                              onBlur={async () => {
                                if (!isDirty || !id) return;
                                const updated = await updatePaper(id, { [field]: editVal || null });
                                setPaper((p) => p ? { ...p, ...updated } : p);
                                setMetaEdit((s) => { const n = { ...s }; delete n[field]; return n; });
                              }}
                              rows={4}
                              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 resize-none"
                            />
                            <button
                              onClick={async () => {
                                if (!id || extractingAbstract) return;
                                setExtractingAbstract(true);
                                setExtractAbstractError(null);
                                try {
                                  const res = await reextractAbstract(id);
                                  setPaper((p) => p ? {
                                    ...p,
                                    abstract: res.abstract,
                                    ...(res.doi  ? { doi:  res.doi  } : {}),
                                    ...(res.year ? { year: res.year } : {}),
                                  } : p);
                                  setMetaEdit((s) => {
                                    const n = { ...s };
                                    delete n.abstract;
                                    if (res.doi)  delete n.doi;
                                    if (res.year) delete n.year;
                                    return n;
                                  });
                                } catch (e) {
                                  setExtractAbstractError(e instanceof Error ? e.message : "Extraction failed");
                                } finally {
                                  setExtractingAbstract(false);
                                }
                              }}
                              disabled={extractingAbstract}
                              className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-violet-100 hover:text-violet-700 disabled:opacity-50 flex items-center gap-1 transition-colors"
                            >
                              {extractingAbstract && (
                                <svg className="animate-spin h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                </svg>
                              )}
                              {extractingAbstract ? "Extracting…" : "↺ Re-extract from PDF"}
                            </button>
                            {extractAbstractError && <p className="text-[10px] text-red-500">{extractAbstractError}</p>}
                            <button
                              onClick={async () => {
                                if (!id || aiExtracting) return;
                                setAiExtracting(true);
                                setAiExtractError(null);
                                try {
                                  const res = await aiExtractMetadata(id);
                                  setPaper((p) => p ? {
                                    ...p,
                                    ...(res.abstract ? { abstract: res.abstract } : {}),
                                    ...(res.doi  ? { doi:  res.doi  } : {}),
                                    ...(res.year ? { year: res.year } : {}),
                                  } : p);
                                  setMetaEdit((s) => {
                                    const n = { ...s };
                                    if (res.abstract) delete n.abstract;
                                    if (res.doi)  delete n.doi;
                                    if (res.year) delete n.year;
                                    return n;
                                  });
                                } catch (e) {
                                  setAiExtractError(e instanceof Error ? e.message : "AI extraction failed");
                                } finally {
                                  setAiExtracting(false);
                                }
                              }}
                              disabled={aiExtracting}
                              className="text-[10px] px-2 py-1 bg-violet-50 text-violet-600 rounded hover:bg-violet-100 hover:text-violet-700 disabled:opacity-50 flex items-center gap-1 transition-colors"
                            >
                              {aiExtracting && (
                                <svg className="animate-spin h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                </svg>
                              )}
                              {aiExtracting ? "Extracting…" : "✦ Extract with AI"}
                            </button>
                            {aiExtractError && <p className="text-[10px] text-red-500">{aiExtractError}</p>}
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={editVal}
                              onChange={(e) => setMetaEdit((s) => ({ ...s, [field]: e.target.value }))}
                              onBlur={async () => {
                                if (!isDirty || !id) return;
                                const val = field === "year" ? (editVal ? Number(editVal) : null) : (editVal || null);
                                const updated = await updatePaper(id, { [field]: val });
                                setPaper((p) => p ? { ...p, ...updated } : p);
                                setMetaEdit((s) => { const n = { ...s }; delete n[field]; return n; });
                              }}
                              className={`w-full text-xs border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 ${isDirty ? "border-violet-300 bg-violet-50" : "border-gray-200"}`}
                            />
                          )}
                        </div>
                      );
                    })}
                    {paper.citation_count != null && (
                      <div>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Citations</p>
                        <p className="text-xs text-gray-600">{paper.citation_count.toLocaleString()}</p>
                      </div>
                    )}
                    {paper.metadata_source && (
                      <div>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Metadata source</p>
                        <p className="text-xs text-gray-600">{paper.metadata_source}</p>
                      </div>
                    )}
                    {paper.added_by && (
                      <div>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Added by</p>
                        <p className="text-xs text-gray-600">{paper.added_by}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Document type</p>
                      <select
                        value={paper.document_type ?? "paper"}
                        onChange={async (e) => {
                          if (!id) return;
                          const newType = e.target.value as Paper["document_type"];
                          const prev = paper;
                          setPaper((p) => p ? { ...p, document_type: newType } : p);
                          try {
                            const updated = await updatePaper(id, { document_type: newType ?? null });
                            setPaper((p) => p ? { ...p, ...updated } : p);
                          } catch {
                            setPaper(prev);
                            notify("Couldn't change document type. Please try again.");
                          }
                        }}
                        className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"
                      >
                        <option value="paper">📄 Paper</option>
                        <option value="book">📚 Book</option>
                        <option value="lecture_deck">🎓 Lecture deck</option>
                        <option value="news_article">📰 News article</option>
                      </select>
                    </div>
                  </div>
                </MetaSection>

                {/* Authors */}
                <MetaSection title="Authors">
                  <div className="space-y-1.5 mb-2">
                    {authors.length === 0 && (
                      <p className="text-xs text-gray-400">No authors recorded.</p>
                    )}
                    {authors.map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-2 group">
                        <Link to={`/people?id=${a.id}`} className="text-xs text-gray-700 hover:text-violet-600 transition-colors truncate">
                          {a.name}
                        </Link>
                        <button
                          onClick={async () => {
                            if (!id) return;
                            await removeAuthor(id, a.id);
                            setAuthors((prev) => prev.filter((p) => p.id !== a.id));
                          }}
                          title="Remove author"
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all text-xs leading-none shrink-0"
                        >×</button>
                      </div>
                    ))}
                  </div>
                  <div className="relative mt-1">
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={newAuthorName}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewAuthorName(val);
                          if (!val.trim()) { setAuthorSuggestions([]); return; }
                          setAuthorSuggestions(
                            allPeople
                              .filter((p) => p.name.toLowerCase().includes(val.toLowerCase()))
                              .slice(0, 6)
                          );
                        }}
                        onKeyDown={async (e) => {
                          if (e.key === "Escape") { setAuthorSuggestions([]); return; }
                          if (e.key !== "Enter" || !newAuthorName.trim() || !id || addingAuthor) return;
                          setAddingAuthor(true);
                          try {
                            const person = await addAuthorByName(id, newAuthorName.trim());
                            setAuthors((prev) => prev.some((p) => p.id === person.id) ? prev : [...prev, person]);
                            setNewAuthorName("");
                            setAuthorSuggestions([]);
                          } finally { setAddingAuthor(false); }
                        }}
                        onBlur={() => setTimeout(() => setAuthorSuggestions([]), 150)}
                        placeholder="Add author…"
                        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-300"
                      />
                      <button
                        onClick={async () => {
                          if (!newAuthorName.trim() || !id || addingAuthor) return;
                          setAddingAuthor(true);
                          try {
                            const person = await addAuthorByName(id, newAuthorName.trim());
                            setAuthors((prev) => prev.some((p) => p.id === person.id) ? prev : [...prev, person]);
                            setNewAuthorName("");
                            setAuthorSuggestions([]);
                          } finally { setAddingAuthor(false); }
                        }}
                        disabled={addingAuthor || !newAuthorName.trim()}
                        className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-40 transition-colors"
                      >+</button>
                    </div>
                    {authorSuggestions.length > 0 && (
                      <ul className="absolute z-20 top-full mt-0.5 left-0 right-0 bg-white border border-gray-200 rounded shadow-lg overflow-hidden text-xs">
                        {authorSuggestions.map((s) => (
                          <li key={s.id}>
                            <button
                              onMouseDown={async (e) => {
                                e.preventDefault();
                                if (!id) return;
                                setAddingAuthor(true);
                                try {
                                  await apiFetch(`/papers/${id}/authors`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ person_id: s.id }),
                                  });
                                  setAuthors((prev) => prev.some((p) => p.id === s.id) ? prev : [...prev, s]);
                                  setNewAuthorName("");
                                  setAuthorSuggestions([]);
                                } finally { setAddingAuthor(false); }
                              }}
                              className="w-full text-left px-2.5 py-1.5 hover:bg-violet-50 transition-colors"
                            >
                              <span className="font-medium text-gray-800">{s.name}</span>
                              {s.affiliation && <span className="text-gray-400 ml-1.5">{s.affiliation}</span>}
                            </button>
                          </li>
                        ))}
                        <li className="border-t border-gray-100">
                          <button
                            onMouseDown={async (e) => {
                              e.preventDefault();
                              if (!newAuthorName.trim() || !id) return;
                              setAddingAuthor(true);
                              try {
                                const person = await addAuthorByName(id, newAuthorName.trim());
                                setAuthors((prev) => prev.some((p) => p.id === person.id) ? prev : [...prev, person]);
                                setNewAuthorName("");
                                setAuthorSuggestions([]);
                              } finally { setAddingAuthor(false); }
                            }}
                            className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50 text-gray-400 transition-colors"
                          >
                            + Add "{newAuthorName}" as new person
                          </button>
                        </li>
                      </ul>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      if (!id || aiExtractingAuthors) return;
                      setAiExtractingAuthors(true);
                      setAiExtractAuthorsError(null);
                      try {
                        const res = await aiExtractAuthors(id);
                        setAuthors((prev) => {
                          const existingIds = new Set(prev.map((p) => p.id));
                          const newOnes = res.authors.filter((a) => !existingIds.has(a.id));
                          return [...prev, ...newOnes];
                        });
                      } catch (e) {
                        setAiExtractAuthorsError(e instanceof Error ? e.message : "Extraction failed");
                      } finally {
                        setAiExtractingAuthors(false);
                      }
                    }}
                    disabled={aiExtractingAuthors}
                    className="mt-1.5 w-full text-xs py-1 px-2 bg-violet-50 text-violet-600 rounded hover:bg-violet-100 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {aiExtractingAuthors && (
                      <svg className="animate-spin h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    )}
                    {aiExtractingAuthors ? "Extracting…" : "✦ Extract authors with AI"}
                  </button>
                  {aiExtractAuthorsError && <p className="text-[10px] text-red-500 mt-1">{aiExtractAuthorsError}</p>}
                </MetaSection>

                {/* AI Summary */}
                {/* Re-fetch PDF — shown when paper has no PDF or missing authors/abstract */}
                {(paper.doi?.startsWith("arXiv:") || paper.doi?.startsWith("10.1101/")) && (
                  <MetaSection title="PDF & extraction">
                    <p className="text-xs text-gray-500 mb-2">
                      {paper.drive_file_id
                        ? "Re-download the PDF and re-run the full extraction pipeline (authors, abstract, summary, figures)."
                        : "No PDF uploaded yet. Download the PDF and run the full extraction pipeline."}
                    </p>
                    <button
                      onClick={async () => {
                        if (!id || refetching) return;
                        setRefetching(true);
                        setRefetchError(null);
                        try {
                          const res = await refetchPdf(id);
                          // Refresh paper + authors
                          const updated = await apiFetch<PaperFull>(`/papers/${id}`);
                          setPaper(updated);
                          const updatedAuthors = await apiFetch<Person[]>(`/papers/${id}/authors`);
                          setAuthors(updatedAuthors);
                        } catch (e) {
                          setRefetchError(e instanceof Error ? e.message : "Re-fetch failed");
                        } finally {
                          setRefetching(false);
                        }
                      }}
                      disabled={refetching}
                      className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 font-medium flex items-center gap-2"
                    >
                      {refetching && (
                        <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                      )}
                      {refetching ? "Downloading & extracting…" : "↓ Download PDF & re-extract"}
                    </button>
                    {refetchError && <p className="text-xs text-red-500 mt-1">{refetchError}</p>}
                  </MetaSection>
                )}

                {/* Topics */}
                <MetaSection title="Topics">
                  <div className="flex flex-wrap gap-1">
                    {topics.map((t) => (
                      <span key={t.id} className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                        {t.name}
                      </span>
                    ))}
                  </div>
                  <InlineAdd value={newTopic} onChange={setNewTopic} onAdd={addTopic} placeholder="Add topic…" />
                  <button
                    onClick={handleSuggestTopics}
                    disabled={suggestingTopics}
                    className="mt-1.5 w-full text-xs py-1 px-2 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {suggestingTopics ? "Asking Claude…" : "✦ Suggest topics with AI"}
                  </button>
                  {topicSuggestOpen && !suggestingTopics && (
                    <div className="mt-2 border border-blue-200 rounded-lg overflow-hidden">
                      <div className="bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 flex justify-between">
                        <span>Topic suggestions</span>
                        <button onClick={() => setTopicSuggestOpen(false)} className="text-blue-400 hover:text-blue-700">×</button>
                      </div>
                      <div className="p-3 space-y-2">
                        <div className="flex flex-wrap gap-1">
                          {suggestedTopics.map((t) => (
                            <button
                              key={t}
                              onClick={() => setSelectedSugTopics((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                                topics.map((x) => x.name).includes(t)
                                  ? "border-gray-200 text-gray-400 cursor-default"
                                  : selectedSugTopics.has(t)
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "border-dashed border-blue-400 text-blue-600 hover:bg-blue-50"
                              }`}
                            >
                              {topics.map((x) => x.name).includes(t) ? "✓ " : "+ "}{t}
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={applyTopicSuggestions}
                          disabled={selectedSugTopics.size === 0}
                          className="w-full text-xs py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          Apply {selectedSugTopics.size} topic{selectedSugTopics.size !== 1 ? "s" : ""}
                        </button>
                      </div>
                    </div>
                  )}
                </MetaSection>

                {/* Projects */}
                <MetaSection title="Projects">
                  <div className="flex flex-wrap gap-1 mb-1">
                    {paperProjects.map((proj) => (
                      <span key={proj.id} className="flex items-center gap-1 text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">
                        {proj.name}
                        <button
                          onClick={async () => {
                            if (!id) return;
                            await removePaperFromProject(proj.id, id);
                            setPaperProjects((prev) => prev.filter((p) => p.id !== proj.id));
                          }}
                          className="text-violet-400 hover:text-red-500 leading-none transition-colors"
                        >×</button>
                      </span>
                    ))}
                    {paperProjects.length === 0 && !addingProject && (
                      <span className="text-xs text-gray-400 italic">Not in any project</span>
                    )}
                  </div>
                  {addingProject ? (
                    <select
                      autoFocus
                      defaultValue=""
                      onChange={async (e) => {
                        const projectId = e.target.value;
                        if (!projectId || !id) return;
                        await addPaperToProject(projectId, id);
                        const proj = allProjects.find((p) => p.id === projectId);
                        if (proj) setPaperProjects((prev) => [...prev, proj]);
                        setAddingProject(false);
                      }}
                      onBlur={() => setAddingProject(false)}
                      className="w-full text-xs border border-violet-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"
                    >
                      <option value="">— Select a project —</option>
                      {allProjects
                        .filter((p) => !paperProjects.some((pp) => pp.id === p.id))
                        .map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                  ) : (
                    <button
                      onClick={() => setAddingProject(true)}
                      className="text-xs text-violet-600 hover:text-violet-800 transition-colors mt-0.5"
                    >
                      + Add to project
                    </button>
                  )}
                </MetaSection>

                {/* Tags */}
                <MetaSection title="Tags">
                  <div className="flex flex-wrap gap-1">
                    {tags.map((t) => (
                      <span key={t.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {t.name}
                      </span>
                    ))}
                  </div>
                  <InlineAdd value={newTag} onChange={setNewTag} onAdd={addTag} placeholder="Add tag…" />
                  <button
                    onClick={handleSuggestTags}
                    disabled={suggestingTags}
                    className="mt-1.5 w-full text-xs py-1 px-2 bg-violet-50 text-violet-600 rounded hover:bg-violet-100 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {suggestingTags ? "Asking Claude…" : "✦ Suggest tags with AI"}
                  </button>
                  {tagSuggestOpen && !suggestingTags && (
                    <div className="mt-2 border border-violet-200 rounded-lg overflow-hidden">
                      <div className="bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 flex justify-between">
                        <span>Tag suggestions</span>
                        <button onClick={() => setTagSuggestOpen(false)} className="text-violet-400 hover:text-violet-700">×</button>
                      </div>
                      <div className="p-3 space-y-2">
                        {suggestedNew.length > 0 && (
                          <div>
                            <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">New from AI</p>
                            <div className="flex flex-wrap gap-1">
                              {suggestedNew.map((t) => (
                                <button key={t} onClick={() => setSelectedSugTags((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${selectedSugTags.has(t) ? "bg-violet-600 text-white border-violet-600" : "border-dashed border-violet-400 text-violet-600"}`}>
                                  + {t}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">All tags</p>
                          <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                            {allTagSuggestions.filter((t) => !tags.map((x) => x.name).includes(t)).map((t) => (
                              <button key={t} onClick={() => setSelectedSugTags((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${selectedSugTags.has(t) ? "bg-violet-600 text-white border-violet-600" : "border-gray-200 text-gray-600 hover:border-violet-400"}`}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <input value={newTagDraft} onChange={(e) => setNewTagDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && newTagDraft.trim()) { const clean = newTagDraft.toLowerCase().replace(/\s+/g, "-"); setSelectedSugTags((p) => new Set([...p, clean])); setSuggestedNew((p) => [...p, clean]); setNewTagDraft(""); } }}
                            placeholder="custom-tag" className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none" />
                          <button onClick={() => { if (newTagDraft.trim()) { const clean = newTagDraft.toLowerCase().replace(/\s+/g, "-"); setSelectedSugTags((p) => new Set([...p, clean])); setSuggestedNew((p) => [...p, clean]); setNewTagDraft(""); } }}
                            className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">+</button>
                        </div>
                        <button onClick={applyTagSuggestions} disabled={selectedSugTags.size === 0}
                          className="w-full text-xs py-1.5 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50">
                          Apply {selectedSugTags.size} tag{selectedSugTags.size !== 1 ? "s" : ""}
                        </button>
                      </div>
                    </div>
                  )}
                </MetaSection>
              </div>
            </div>
          )}

          {/* Graph tab */}
          {leftTab === "graph" && (
            <div className="flex-1 overflow-hidden relative bg-gray-50">
              {!graphLoaded && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 z-10">
                  Loading graph…
                </div>
              )}
              {graphLoaded && graphData && graphData.nodes.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                  No connections yet.
                </div>
              )}
              <div ref={graphContainerRef} className="w-full h-full" />
            </div>
          )}

          {/* Related papers tab */}
          {leftTab === "related" && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5 space-y-4">
                <div className="text-sm text-gray-600 mb-4">
                  Papers Semantic Scholar recommends based on this work
                </div>

                {relatedLoading && (
                  <div className="text-center py-12 text-gray-400 text-sm">
                    Loading related papers…
                  </div>
                )}

                {!relatedLoading && relatedLoaded && relatedPapers.length === 0 && (
                  <div className="py-6">
                    <p className="text-sm text-gray-400 text-center mb-4">
                      {paper.doi
                        ? "Not yet indexed by Semantic Scholar — try searching with these keywords:"
                        : "No DOI — recommendations unavailable"}
                    </p>
                    {relatedKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-2 justify-center">
                        {relatedKeywords.map((kw, i) => (
                          <button
                            key={i}
                            onClick={() => navigate(`/?q=${encodeURIComponent(kw)}`)}
                            className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-sm rounded-full border border-blue-200 transition-colors"
                          >
                            {kw}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {relatedPapers.map((related, idx) => (
                  <div
                    key={idx}
                    className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-base font-semibold text-gray-900">
                            {related.title}
                          </h3>
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                            S2
                          </span>
                          {related.year && (
                            <span className="text-sm text-gray-500">{related.year}</span>
                          )}
                        </div>

                        {related.authors.length > 0 && (
                          <p className="text-sm text-gray-600 mb-2">
                            {related.authors.slice(0, 5).join(", ")}
                            {related.authors.length > 5 && ` +${related.authors.length - 5} more`}
                          </p>
                        )}

                        {related.venue && (
                          <p className="text-xs text-gray-500 mb-1">{related.venue}</p>
                        )}

                        {related.citation_count !== null && (
                          <p className="text-xs text-gray-500 mb-2">
                            {related.citation_count} citation{related.citation_count !== 1 ? "s" : ""}
                          </p>
                        )}

                        {related.abstract && (
                          <p className="text-sm text-gray-700 line-clamp-2 mb-2">
                            {related.abstract}
                          </p>
                        )}

                        <a
                          href={related.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-violet-600 hover:underline"
                        >
                          View source →
                        </a>
                      </div>

                      <div className="flex-shrink-0">
                        {related.in_library ? (
                          <Link
                            to={`/paper/${related.library_paper_id}`}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-medium hover:bg-green-100"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                              className="w-3.5 h-3.5"
                            >
                              <path
                                fillRule="evenodd"
                                d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                                clipRule="evenodd"
                              />
                            </svg>
                            View
                          </Link>
                        ) : (
                          <button
                            onClick={() => handleAddRelated(related)}
                            disabled={addingRelatedIds.has(related.url)}
                            className="px-3 py-1.5 bg-violet-600 text-white rounded text-xs font-medium hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {addingRelatedIds.has(related.url) ? "Adding..." : "Add"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Figures tab */}
          {leftTab === "figures" && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5 space-y-5">

                {/* Toolbar */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleExtractFigures}
                    disabled={figuresExtracting}
                    className="text-xs px-3 py-1.5 bg-violet-50 text-violet-700 rounded-lg hover:bg-violet-100 disabled:opacity-50 font-medium"
                  >
                    {figures.length > 0 ? "Re-extract" : "Extract figures"}
                  </button>
                  {figuresExtracting ? (
                    <span className="flex items-center gap-1.5 text-xs text-violet-500">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                      {EXTRACT_STEPS[figuresExtractStep]}
                    </span>
                  ) : figuresExtractMsg ? (
                    <span className="text-xs text-gray-400">{figuresExtractMsg}</span>
                  ) : figures.length > 0 ? (
                    <span className="text-xs text-gray-400">{figures.length} figure{figures.length !== 1 ? "s" : ""}</span>
                  ) : null}
                </div>

                {/* Empty state */}
                {figuresLoaded && figures.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-12">
                    No figures extracted yet.<br />
                    <span className="text-xs">Click "Extract figures" to start.</span>
                  </p>
                )}

                {/* Figures — vertical stack */}
                {figures.length > 0 && (
                  <div className="space-y-6">
                    {figures.map((fig) => {
                      const isOpen = selectedFigure?.id === fig.id;
                      return (
                        <div key={fig.id} className="border border-gray-200 rounded-xl overflow-hidden">
                          {/* Image */}
                          {fig.drive_file_id ? (
                            <img
                              src={`${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/papers/${id}/figures/${fig.id}/image`}
                              alt={fig.caption ?? "Figure"}
                              className="w-3/4 mx-auto block object-contain bg-gray-50"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                          ) : (
                            <div className="w-3/4 mx-auto h-40 bg-gray-100 flex items-center justify-center text-gray-400 text-xs">No preview</div>
                          )}

                          {/* Caption + ask button  also just 3/4*/}
                          <div className="px-4 py-3 bg-white border-t border-gray-100">
                            <div className="w-3/4 mx-auto flex items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-semibold text-gray-500">
                                  {fig.figure_number ? `Figure ${fig.figure_number}` : `Page ${fig.page_number}`}
                                </p>
                                {fig.caption && (
                                  <p className="text-sm text-gray-700 mt-0.5 leading-relaxed">{fig.caption}</p>
                                )}
                              </div>
                              <button
                                onClick={() => {
                                  setSelectedFigure(isOpen ? null : fig);
                                  setFigureAnswer(null);
                                  setFigureQuestion("");
                                }}
                                className="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 transition-colors"
                              >
                                {isOpen ? "Close" : "Ask"}
                              </button>
                            </div>
                          </div>

                          {/* Inline chat — shown when expanded */}
                          {isOpen && (
                            <div className="px-4 py-4 space-y-3 border-t border-violet-100 bg-violet-50">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Ask about this figure</p>
                              </div>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={figureQuestion}
                                  onChange={(e) => setFigureQuestion(e.target.value)}
                                  onKeyDown={(e) => e.key === "Enter" && handleFigureChat()}
                                  placeholder="What does this figure show?"
                                  disabled={figureAnswering}
                                  className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-violet-300 disabled:opacity-50"
                                />
                                <button
                                  onClick={handleFigureChat}
                                  disabled={figureAnswering || !figureQuestion.trim()}
                                  className="px-4 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 disabled:opacity-50"
                                >
                                  {figureAnswering ? "…" : "Ask"}
                                </button>
                              </div>
                              {figureAnswer && (
                                <div className="prose prose-sm max-w-none bg-white border border-gray-100 rounded-xl p-4">
                                  <ReactMarkdown {...mdPlugins}>{figureAnswer}</ReactMarkdown>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tables tab */}
          {leftTab === "tables" && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5 space-y-5">

                {/* Toolbar hint */}
                <p className="text-xs text-gray-400">
                  Tables are extracted automatically when you run "Extract figures" on the Figures tab.
                  Click <strong>Copy</strong> to copy a table as Markdown for use elsewhere.
                </p>

                {/* Empty state */}
                {tablesLoaded && tables.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-12">
                    No tables extracted yet.<br />
                    <span className="text-xs">Go to the Figures tab and click "Extract figures".</span>
                  </p>
                )}

                {/* Tables list */}
                {tables.map((tbl) => (
                  <div key={tbl.id} className="border border-gray-200 rounded-xl overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                      <span className="text-xs font-semibold text-gray-600">
                        {tbl.table_number ? `Table ${tbl.table_number}` : `Page ${tbl.page_number}`}
                        {tbl.caption && <span className="font-normal text-gray-500"> — {tbl.caption}</span>}
                      </span>
                      <button
                        onClick={() => copyTable(tbl)}
                        className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 transition-colors"
                      >
                        {copiedTableId === tbl.id ? "Copied!" : "Copy MD"}
                      </button>
                    </div>
                    {/* Markdown table rendered */}
                    <div className="overflow-x-auto px-4 py-3">
                      <ReactMarkdown
                        {...mdPlugins}
                        components={{
                          table: ({ children }) => (
                            <table className="w-full text-xs border-collapse">{children}</table>
                          ),
                          thead: ({ children }) => (
                            <thead className="bg-gray-50">{children}</thead>
                          ),
                          th: ({ children }) => (
                            <th className="border border-gray-200 px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">
                              {children}
                            </th>
                          ),
                          td: ({ children }) => (
                            <td className="border border-gray-200 px-3 py-2 text-gray-700 align-top">
                              {children}
                            </td>
                          ),
                          tr: ({ children }) => (
                            <tr className="even:bg-gray-50/60">{children}</tr>
                          ),
                        }}
                      >
                        {tbl.markdown_content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Claims tab */}
          {leftTab === "claims" && (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-6 py-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-700">Claims & Findings</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleExtractClaims}
                      disabled={extractingClaims}
                      className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {extractingClaims && (
                        <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                      )}
                      {extractingClaims ? "Extracting…" : "↺ Re-extract claims"}
                    </button>
                  </div>
                </div>

                {claimsLoaded && claims.length === 0 && (
                  <div className="text-center py-12">
                    <p className="text-sm text-gray-400 mb-2">No claims extracted yet.</p>
                    <p className="text-xs text-gray-400">Click "Re-extract claims" to start.</p>
                  </div>
                )}

                {claimsLoaded && claims.length > 0 && (
                  <div className="space-y-6">
                    {(["finding", "claim", "hypothesis", "method", "limitation"] as const).map((type) => {
                      const typeClaims = claims.filter((c) => c.type === type);
                      if (typeClaims.length === 0) return null;
                      return (
                        <div key={type} className="space-y-2">
                          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                            {type === "finding" ? "Findings" : type === "claim" ? "Claims" : type === "hypothesis" ? "Hypotheses" : type === "method" ? "Methods" : "Limitations"}
                          </h4>
                          <div className="space-y-2">
                            {typeClaims.map((claim) => (
                              <div key={claim.id} className="flex items-start gap-2 text-sm text-gray-700 leading-relaxed">
                                <span className="text-violet-600 mt-0.5">•</span>
                                <p><ReactMarkdown {...inlineMd}>{claim.text}</ReactMarkdown></p>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!claimsLoaded && <p className="text-xs text-gray-400 text-center py-12">Loading…</p>}
              </div>
            </div>
          )}

          {/* Chapters tab (book/lecture deck only) */}
          {leftTab === "chapters" && id && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5">
                <BookChapters paperId={id} />
              </div>
            </div>
          )}
        </div>

        {/* Drag handle with % indicator */}
        <div
          onMouseDown={startDrag}
          title="Drag to resize"
          className="shrink-0 relative w-5 cursor-col-resize group select-none flex flex-col items-center justify-center"
        >
          <div className="w-px h-full bg-gray-200 group-hover:bg-violet-400 transition-colors" />
          <span className="absolute text-[8px] text-gray-400 group-hover:text-violet-600 font-mono bg-white border border-gray-200 rounded px-0.5 leading-tight">
            {Math.round(((window.innerWidth - rightWidth) / window.innerWidth) * 100)}%
          </span>
        </div>

        {/* RIGHT — metadata + notes/chat */}
        <div className="shrink-0 flex flex-col bg-white overflow-hidden" style={{ width: rightWidth }}>

          {/* Tabs: Notes / Chat / Highlights */}
          <div className="flex border-b border-gray-100 shrink-0">
            {(["notes", "chat", "highlights", "concepts", "tour"] as RightTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 text-xs font-medium capitalize transition-colors
                  ${tab === t
                    ? "text-violet-600 border-b-2 border-violet-600"
                    : "text-gray-500 hover:text-gray-700"
                  }`}
              >
                {t === "highlights"
                  ? `Highlights${annotations.length > 0 ? ` (${annotations.length})` : ""}`
                  : t === "concepts"
                  ? `Concepts${concepts.length > 0 ? ` (${concepts.length})` : ""}`
                  : t}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden p-3">
            {tab === "notes" && id && (
              <NoteEditor
                key={id}
                fetchNote={() => apiFetch(`/papers/${id}/note`)}
                saveNote={(content) => apiFetch(`/papers/${id}/note`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content }),
                })}
                compact
              />
            )}
            {tab === "chat" && id && <ChatPanel paperId={id} />}
            {tab === "concepts" && id && (
              <ConceptsPanel
                paperId={id}
                hasPdf={!!paper?.drive_file_id}
                concepts={concepts}
                backend={conceptsBackend}
                onConceptsChange={setConcepts}
                generation={conceptGeneration}
                onGenerationChange={setConceptGeneration}
                activeId={activeConceptId}
                onActivate={(c) => {
                  setActiveConceptId(c?.id ?? null);
                  if (c && !(leftTab === "pdf" && activeConceptId === c.id)) showPdfPage(c.page);
                }}
              />
            )}
            {tab === "tour" && id && (
              <TourPanel
                paperId={id}
                hasPdf={!!paper?.drive_file_id}
                activeIndex={activeStop}
                onStopsChange={setTourStops}
                onActivate={(i) => {
                  setActiveStop(i);
                  if (i != null && tourStops[i]) showPdfPage(tourStops[i].page);
                }}
              />
            )}
            {tab === "highlights" && (
              <div className="h-full overflow-y-auto">
                {annotations.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center mt-8">
                    No highlights yet.<br />Select text in the PDF to add one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {[...annotations]
                      .sort((a, b) => a.page_number - b.page_number)
                      .map((ann) => (
                        <button
                          key={ann.id}
                          onClick={() => {
                            if (leftTab === "pdf") {
                              // Viewer already mounted — jump via ref (remounts at target page)
                              pdfRef.current?.jumpToPage(ann.page_number);
                            } else {
                              // Viewer about to mount — set initialPage so it opens at correct page
                              setPdfInitialPage(ann.page_number);
                              setLeftTab("pdf");
                            }
                          }}
                          className="w-full flex items-start gap-2.5 rounded-lg border border-gray-100 bg-white px-3 py-2.5 text-left hover:border-violet-200 hover:bg-violet-50 transition-colors group"
                        >
                          <span
                            className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5 ring-1 ring-black/10"
                            style={{ background: COLOR_SWATCH[ann.color as AnnotationColor] ?? "#f5e800" }}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-gray-800 line-clamp-2 group-hover:text-violet-700 leading-snug">
                              {ann.highlighted_text || "(no text)"}
                            </p>
                            {ann.note && (
                              <p className="text-[10px] text-gray-400 mt-1 line-clamp-2 italic">{ann.note}</p>
                            )}
                            <p className="text-[10px] text-gray-400 mt-1">
                              {COLOR_LABELS[ann.color as AnnotationColor] ?? ann.color} · p.{ann.page_number + 1}
                            </p>
                          </div>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hidden file input for reference PDF upload */}
      <input
        ref={refUploadInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleRefFileChosen}
      />

      {refUploadFile && refUploadMeta && (
        <UploadConfirmModal
          file={refUploadFile}
          meta={refUploadMeta}
          onConfirmed={async (paper: T_IngestOut) => {
            setRefUploadFile(null);
            setRefUploadMeta(null);
            pendingRefForUpload.current = null;
            const { references: refs, cited_by } = await listReferences(id!);
            setReferences(refs);
            setCitedBy(cited_by);
            setOnboardingPaper(paper);
          }}
          onCancel={() => { setRefUploadFile(null); setRefUploadMeta(null); pendingRefForUpload.current = null; }}
        />
      )}

      {refConfirmUrl && refConfirmMeta && (
        <UploadConfirmModal
          file={null}
          url={refConfirmUrl}
          meta={refConfirmMeta}
          onConfirmed={async (paper) => {
            setRefConfirmUrl(null);
            setRefConfirmMeta(null);
            const { references: refs, cited_by } = await listReferences(id!);
            setReferences(refs);
            setCitedBy(cited_by);
            setOnboardingPaper(paper);
          }}
          onCancel={() => { setRefConfirmUrl(null); setRefConfirmMeta(null); }}
        />
      )}

      {onboardingPaper && (
        <OnboardingModal
          paper={onboardingPaper}
          onClose={() => setOnboardingPaper(null)}
        />
      )}

      {editOpen && (
        <EditPaperModal
          paper={paper}
          metadataEditor={{
            tags,
            topics,
            onSave: saveModalMetadata,
            onSaved: ({ tags: nextTags, topics: nextTopics }) => {
              setTags(nextTags);
              setTopics(nextTopics);
            },
          }}
          onSaved={(updated) => { setPaper((p) => p ? { ...p, ...updated } : p); setEditOpen(false); }}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}

function MetaSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

const INVOLVE_ROLES = ["shared_by", "supervisor", "collaborating", "reviewer", "colleague", "student", "friend"] as const;
const YEARS_KNOWN_OPTIONS = ["< 1 year", "1 year", "2 years", "3 years", "5+ years"] as const;

function AddInvolvesForm({
  paperId,
  onAdded,
}: {
  paperId: string;
  onAdded: (p: { id: string; name: string; affiliation?: string; role: string; years_known?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(INVOLVE_ROLES[0]);
  const [years, setYears] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    const n = name.trim();
    if (!n) return;
    setAdding(true);
    try {
      const person = await getOrCreatePerson(n);
      await linkPersonInvolves(paperId, person.id, role, years || undefined);
      onAdded({ id: person.id, name: person.name, affiliation: person.affiliation, role, years_known: years || undefined });
      setName(""); setYears("");
    } catch { /* ignore */ }
    finally { setAdding(false); }
  };

  return (
    <div className="pt-2 border-t border-gray-100">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Link person</p>
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Name…"
          className="flex-1 min-w-28 text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"
        >
          {INVOLVE_ROLES.map((r) => (
            <option key={r} value={r}>{r.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={years}
          onChange={(e) => setYears(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"
        >
          <option value="">Years known…</option>
          {YEARS_KNOWN_OPTIONS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <button
          onClick={handleAdd}
          disabled={adding || !name.trim()}
          className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50"
        >
          {adding ? "…" : "Link"}
        </button>
      </div>
    </div>
  );
}

function InlineAdd({
  value, onChange, onAdd, placeholder,
}: {
  value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string;
}) {
  return (
    <div className="flex gap-1 mt-1">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onAdd()}
        placeholder={placeholder}
        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-300"
      />
      <button onClick={onAdd} className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">+</button>
    </div>
  );
}
