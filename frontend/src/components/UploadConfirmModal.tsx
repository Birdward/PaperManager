import React, { useState, useEffect, useRef } from "react";
import { uploadPdf, ingestFromUrlFull, saveReferences, applyTags, apiFetch, getOrCreatePerson, linkPersonInvolves, listPeople, listProjects, addPaperToProject, previewUrlPdf, uploadPdfForPaper, parsePdf, suggestTags, createTag, updatePaper } from "../api/client";
import { useAppSettings } from "../contexts/SettingsContext";
import type { ParsedMeta, T_IngestOut, Reference, Paper } from "../types";

const INVOLVE_ROLES = ["shared_by", "supervisor", "collaborating", "reviewer", "colleague", "student", "friend"] as const;
const YEARS_KNOWN_OPTIONS = ["< 1 year", "1 year", "2 years", "3 years", "5+ years"] as const;

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  semantic_scholar: { label: "Semantic Scholar", color: "bg-accent-lo text-accent" },
  crossref:         { label: "Crossref",          color: "bg-accent-lo text-accent" },
  llm:              { label: "AI extracted — please review", color: "bg-yellow-100 text-yellow-700" },
  heuristic:        { label: "Guessed — please correct",     color: "bg-red-100 text-coral" },
};

interface Props {
  file: File | null;
  meta: ParsedMeta;
  onConfirmed: (paper: T_IngestOut) => void;
  onCancel: () => void;
  /** When provided (no file), ingest via URL instead of PDF upload. */
  url?: string;
  debug?: boolean;
  /** Queue position indicator, e.g. position=2 total=5 → "Paper 2 of 5" */
  queuePosition?: number;
  queueTotal?: number;
  /** Skip the summary-prompt step — use default instructions. Set true for queue/batch mode. */
  skipSummaryStep?: boolean;
  /** Docling cache key from queue preprocess — avoids re-running layout on upload. */
  preprocessKey?: string;
  /** LLM analysis cache key from queue preanalyze — avoids re-running summary/claims/refs. */
  analysisKey?: string;
  /** Tag suggestions precomputed in the queue — shown instantly in the tags step. */
  precomputedTagSuggestions?: { existing: string[]; new: string[]; all_tags: string[] };
}

export default function UploadConfirmModal({ file, meta, onConfirmed, onCancel, url, debug, queuePosition, queueTotal, skipSummaryStep, preprocessKey, analysisKey, precomputedTagSuggestions }: Props) {
  const urlMode = !file && !!url;
  const { settings } = useAppSettings();

  const [title, setTitle]       = useState(meta.title || "");
  const [authors, setAuthors]   = useState((meta.authors ?? []).join(", "));
  const [year, setYear]         = useState(meta.year?.toString() ?? "");
  const [doi, setDoi]           = useState(meta.doi ?? "");
  const [abstract, setAbstract] = useState(meta.abstract ?? "");
  const [documentType, setDocumentType] = useState<"paper" | "book" | "lecture_deck" | "news_article">("paper");
  const [publishedDate, setPublishedDate] = useState(meta.published_date ?? "");
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Paper | null>(null);
  const dupCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [step, setStep]                   = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(settings.showSourceStep ? 0 : 1);
  const [uploadedPaper, setUploadedPaper] = useState<T_IngestOut | null>(null);

  // Step 2: summary prompt
  const [summaryInstructions, setSummaryInstructions] = useState(settings.defaultSummaryInstructions);

  // Step 0: source
  const [sourceType, setSourceType]     = useState<"person" | "source" | null>(null);
  const [sourcePerson, setSourcePerson] = useState<{id: string; name: string} | null>(null);
  const [sourceTag, setSourceTag]       = useState<string | null>(null);
  const [personQuery, setPersonQuery]   = useState("");
  const [allPeople, setAllPeople]       = useState<{id: string; name: string; affiliation?: string}[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [showPersonDrop, setShowPersonDrop] = useState(false);
  const [showPersonForm, setShowPersonForm] = useState(false);
  const [newPersonAffiliation, setNewPersonAffiliation] = useState("");
  const [newPersonEmail, setNewPersonEmail] = useState("");

  // Project list (used in Step 5 onboarding)
  const [projects, setProjects] = useState<{id: string; name: string; description?: string}[]>([]);
  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // PDF fallback (URL mode only) — download PDF and re-fill fields
  const [pdfFallbackLoading, setPdfFallbackLoading] = useState(false);
  const [pdfFallbackError, setPdfFallbackError]     = useState<string | null>(null);
  const [pdfFallbackDone, setPdfFallbackDone]       = useState(false);

  const handlePdfFallback = async () => {
    if (!url) return;
    setPdfFallbackLoading(true);
    setPdfFallbackError(null);
    try {
      const meta = await previewUrlPdf(url);
      if (meta.title && !title) setTitle(meta.title);
      if (meta.authors?.length && !authors) setAuthors(meta.authors.join(", "));
      if (meta.year && !year) setYear(String(meta.year));
      if (meta.doi && !doi) setDoi(meta.doi);
      if (meta.abstract && !abstract) setAbstract(meta.abstract);
      // Also fill if already empty even if we have some partial data
      if (meta.authors?.length && !authors) setAuthors(meta.authors.join(", "));
      if (meta.abstract && !abstract) setAbstract(meta.abstract);
      setPdfFallbackDone(true);
    } catch (e) {
      setPdfFallbackError(e instanceof Error ? e.message : "PDF extraction failed");
    } finally {
      setPdfFallbackLoading(false);
    }
  };

  // PDF-missing banner (URL mode only) — shown AFTER import on steps 3/4
  const [pdfMissing, setPdfMissing]     = useState(false);
  const [manualPdf, setManualPdf]       = useState<File | null>(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [pdfUploaded, setPdfUploaded]   = useState(false);

  // Manual PDF selected BEFORE import (when pdfFallbackError is set)
  const [preImportPdf, setPreImportPdf]           = useState<File | null>(null);
  const [preImportPdfLoading, setPreImportPdfLoading] = useState(false);

  const handlePreImportPdf = async (f: File) => {
    setPreImportPdf(f);
    setPreImportPdfLoading(true);
    try {
      const extracted = await parsePdf(f);
      if (extracted.authors?.length && !authors.trim()) setAuthors(extracted.authors.join(", "));
      if (extracted.abstract && !abstract.trim()) setAbstract(extracted.abstract);
      if (extracted.year && !year) setYear(String(extracted.year));
      if (extracted.doi && !doi) setDoi(extracted.doi);
    } catch { /* best-effort */ }
    finally { setPreImportPdfLoading(false); }
  };

  // Step 4: tags
  const [tagSuggestions, setTagSuggestions] = useState<{ existing: string[]; new: string[]; all_tags: string[] }>({ existing: [], new: [], all_tags: [] });
  const [appliedTags, setAppliedTags]       = useState<Set<string>>(new Set());
  const [tagsLoading, setTagsLoading]       = useState(false);
  const [customTag, setCustomTag]           = useState("");
  const [addingTag, setAddingTag]           = useState(false);

  // Step 5: project (onboarding)
  const [projectOnboardSelectedId, setProjectOnboardSelectedId] = useState<string>("");
  const [projectOnboardAdding, setProjectOnboardAdding]         = useState(false);
  const [projectOnboardAdded, setProjectOnboardAdded]           = useState(false);

  // Step 6: people
  const [linkedPeople, setLinkedPeople]   = useState<{ name: string; role: string; years_known?: string }[]>([]);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRole, setNewPersonRole] = useState("shared_by");
  const [newPersonYears, setNewPersonYears] = useState("");
  const [linkingPerson, setLinkingPerson] = useState(false);

  // Step 3: refs
  const [checkedRefs, setCheckedRefs] = useState<boolean[]>([]);
  const [savingRefs, setSavingRefs]   = useState(false);

  const source = SOURCE_LABELS[meta.metadata_source] ?? { label: meta.metadata_source, color: "bg-raised text-ink-3" };

  // Debounced duplicate check whenever DOI or title changes
  useEffect(() => {
    if (dupCheckTimer.current) clearTimeout(dupCheckTimer.current);
    setDuplicate(null);
    dupCheckTimer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (doi.trim()) params.set("doi", doi.trim());
        else if (title.trim()) params.set("title", title.trim());
        else return;
        const res = await apiFetch<{ duplicate: Paper | null }>(`/papers/check-duplicate?${params}`);
        setDuplicate(res.duplicate);
      } catch { /* silent */ }
    }, 600);
    return () => { if (dupCheckTimer.current) clearTimeout(dupCheckTimer.current); };
  }, [doi, title]);

  // Load people for autocomplete when person tab is opened
  useEffect(() => {
    if (sourceType === "person" && !peopleLoaded) {
      listPeople()
        .then((people) => { setAllPeople(people); setPeopleLoaded(true); })
        .catch(() => setPeopleLoaded(true));
    }
  }, [sourceType, peopleLoaded]);

  const filteredPeople = allPeople.filter((p) =>
    personQuery.trim() && p.name.toLowerCase().includes(personQuery.toLowerCase())
  );
  const showCreateOption = personQuery.trim().length > 1 &&
    !allPeople.some((p) => p.name.toLowerCase() === personQuery.toLowerCase());

  const handleSelectPerson = (person: {id: string; name: string}) => {
    setSourcePerson(person);
    setPersonQuery(person.name);
    setShowPersonDrop(false);
  };

  const handleCreatePerson = async () => {
    if (!personQuery.trim()) return;
    setCreatingPerson(true);
    setShowPersonDrop(false);
    try {
      const person = await getOrCreatePerson(
        personQuery.trim(),
        newPersonAffiliation.trim() || undefined,
        newPersonEmail.trim() || undefined,
      );
      setAllPeople((prev) => prev.find((p) => p.id === person.id) ? prev : [...prev, person]);
      handleSelectPerson(person);
      setShowPersonForm(false);
      setNewPersonAffiliation("");
      setNewPersonEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create person");
    } finally {
      setCreatingPerson(false);
    }
  };

  // Apply source link/tag after upload
  const applySource = async (paperId: string) => {
    if (sourceType === "person" && sourcePerson) {
      try { await linkPersonInvolves(paperId, sourcePerson.id, "shared_by"); } catch { /* best-effort */ }
      try { await applyTags(paperId, ["from-colleague"]); } catch { /* best-effort */ }
    } else if (sourceType === "source" && sourceTag) {
      try { await applyTags(paperId, [sourceTag]); } catch { /* best-effort */ }
    }
  };

  // ── After refs: go to Tags step ───────────────────────────────────────────

  const goToTagStep = (paper: T_IngestOut) => {
    setUploadedPaper(paper);
    setStep(4);
    // Use tag suggestions precomputed in the queue when available — instant.
    if (precomputedTagSuggestions) {
      setTagsLoading(true);
      apiFetch<{ id: string; name: string }[]>(`/papers/${paper.id}/tags`)
        .then((current) => {
          setAppliedTags(new Set(current.map((t) => t.name)));
          setTagSuggestions({
            existing: precomputedTagSuggestions.existing,
            new: precomputedTagSuggestions.new,
            all_tags: precomputedTagSuggestions.all_tags ?? [],
          });
        })
        .catch(() => {})
        .finally(() => setTagsLoading(false));
      return;
    }
    setTagsLoading(true);
    Promise.all([
      apiFetch<{ id: string; name: string }[]>(`/papers/${paper.id}/tags`),
      suggestTags(paper.title, paper.abstract),
    ]).then(([current, res]) => {
      setAppliedTags(new Set(current.map((t) => t.name)));
      setTagSuggestions({ existing: res.existing, new: res.new, all_tags: res.all_tags ?? [] });
    }).catch(() => {}).finally(() => setTagsLoading(false));
  };

  const addTagToApplied = async (name: string) => {
    if (appliedTags.has(name) || !uploadedPaper) return;
    setAddingTag(true);
    try {
      await createTag(uploadedPaper.id, name);
      setAppliedTags((prev) => new Set([...prev, name]));
    } catch { /* ignore */ }
    finally { setAddingTag(false); }
  };

  const submitCustomTag = async () => {
    const name = customTag.trim();
    if (!name) return;
    await addTagToApplied(name);
    setCustomTag("");
  };

  const linkNewPerson = async () => {
    const n = newPersonName.trim();
    if (!n || !uploadedPaper) return;
    setLinkingPerson(true);
    try {
      const person = await getOrCreatePerson(n);
      await linkPersonInvolves(uploadedPaper.id, person.id, newPersonRole, newPersonYears || undefined);
      setLinkedPeople((prev) => [...prev, { name: n, role: newPersonRole, years_known: newPersonYears || undefined }]);
      setNewPersonName("");
      setNewPersonYears("");
    } catch { /* ignore */ }
    finally { setLinkingPerson(false); }
  };

  const finishOnboarding = () => {
    if (uploadedPaper) onConfirmed(uploadedPaper);
  };

  // ── Step 1: upload ─────────────────────────────────────────────────────────

  const confirm = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let paper: T_IngestOut;
      if (urlMode) {
        const isDefault = summaryInstructions.trim() === settings.defaultSummaryInstructions.trim();
        paper = await ingestFromUrlFull(url!, undefined, debug, isDefault ? undefined : summaryInstructions);
        // If user provided a PDF manually before import, attach it now
        if (preImportPdf && paper.pdf_fetched === false) {
          try { await uploadPdfForPaper(paper.id, preImportPdf); } catch { /* non-fatal */ }
        }
      } else {
        const isDefault = summaryInstructions.trim() === settings.defaultSummaryInstructions.trim();
        paper = await uploadPdf(
          file!, title.trim(), undefined, undefined,
          isDefault ? undefined : summaryInstructions,
          debug,
          documentType !== "paper" ? documentType : undefined,
          settings.autoExtractClaims ? "claude" : "",  // "" saves no claims
          settings.generateEmbeddingsOnUpload,
          documentType === "paper" ? preprocessKey : undefined,
          documentType === "paper" ? analysisKey : undefined,
          documentType === "news_article" ? (publishedDate || undefined) : undefined,
        );
      }
      await applySource(paper.id);
      if (urlMode && paper.pdf_fetched === false) setPdfMissing(true);
      const hasRefs = paper.references_found && paper.references_found.length > 0;
      if (hasRefs && !settings.autoSaveReferences) {
        setUploadedPaper(paper);
        setCheckedRefs(paper.references_found.map(() => true));
        setStep(3);
      } else {
        // Auto-save all refs if setting is on, then go to tags
        if (hasRefs && settings.autoSaveReferences) {
          try { await saveReferences(paper.id, paper.references_found as Reference[]); } catch { /* best-effort */ }
        }
        goToTagStep(paper);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      // 409 = duplicate detected server-side
      if (msg.includes("409")) {
        try {
          const detail = JSON.parse(msg.replace(/^API 409: /, ""));
          setError(`Duplicate: "${detail.existing_title}" already exists. Go to paper or upload anyway below.`);
          // Try to set duplicate info so banner appears
          setDuplicate({ id: detail.existing_id, title: detail.existing_title, created_at: "" });
        } catch {
          setError(msg);
        }
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Manual PDF upload (when pdf_fetched === false) ─────────────────────────

  const uploadManualPdf = async () => {
    if (!manualPdf || !uploadedPaper) return;
    setUploadingPdf(true);
    try {
      await uploadPdfForPaper(uploadedPaper.id, manualPdf);
      setPdfUploaded(true);
      setPdfMissing(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "PDF upload failed");
    } finally {
      setUploadingPdf(false);
    }
  };

  // ── Step 2: refs ───────────────────────────────────────────────────────────

  const confirmRefs = async () => {
    if (!uploadedPaper) return;
    setSavingRefs(true);
    const selected = uploadedPaper.references_found.filter((_, i) => checkedRefs[i]);
    if (selected.length > 0) {
      try { await saveReferences(uploadedPaper.id, selected as Reference[]); } catch { /* best-effort */ }
    }
    setSavingRefs(false);
    goToTagStep(uploadedPaper);
  };

  // ── Render: Step 0 (source) ────────────────────────────────────────────────

  const SOURCE_OPTIONS: { tag: string; label: string; icon: React.ReactNode }[] = [
    {
      tag: "from-linkedin", label: "LinkedIn",
      icon: <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>,
    },
    {
      tag: "from-twitter", label: "Twitter / X",
      icon: <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>,
    },
    {
      tag: "from-email", label: "Email",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>,
    },
    {
      tag: "from-conference", label: "Conference",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/><path d="M19 9H5a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1a2 2 0 0 0-2-2z"/><path d="M12 14v8M8 14v4M16 14v4"/></svg>,
    },
    {
      tag: "from-newsletter", label: "Newsletter",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M4 4h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/><path d="M8 9h8M8 13h5"/></svg>,
    },
    {
      tag: "from-google-scholar", label: "Google Scholar",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>,
    },
    {
      tag: "from-google", label: "Google",
      icon: <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>,
    },
    {
      tag: "from-ai-chat", label: "AI Chat",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M12 2a8 8 0 0 1 8 8c0 5-8 12-8 12S4 15 4 10a8 8 0 0 1 8-8z"/><circle cx="12" cy="10" r="3"/></svg>,
    },
    {
      tag: "from-arxiv", label: "arXiv",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>,
    },
  ];

  if (step === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4">
          <ModalHeader step={0} title="How did you get this paper?" subtitle="Optionally track where you found it — helps build your knowledge graph." />

          <div className="px-6 py-5 space-y-4">
            {/* Mode tabs */}
            <div className="flex gap-2">
              <button
                onClick={() => { setSourceType("person"); setSourceTag(null); }}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${sourceType === "person" ? "bg-accent text-white border-accent" : "border-line text-ink-2 hover:border-violet-400 hover:text-accent"}`}
              >
                From a person
              </button>
              <button
                onClick={() => { setSourceType("source"); setSourcePerson(null); setPersonQuery(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${sourceType === "source" ? "bg-accent text-white border-accent" : "border-line text-ink-2 hover:border-violet-400 hover:text-accent"}`}
              >
                From a source
              </button>
            </div>

            {/* Person autocomplete */}
            {sourceType === "person" && (
              <div className="space-y-2">
                <div className="relative">
                  <input
                    autoFocus
                    value={personQuery}
                    onChange={(e) => {
                      setPersonQuery(e.target.value);
                      setSourcePerson(null);
                      setShowPersonForm(false);
                      setShowPersonDrop(true);
                    }}
                    onFocus={() => setShowPersonDrop(true)}
                    placeholder="Search or create a person…"
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  {sourcePerson && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-accent text-xs font-medium">✓ {sourcePerson.name}</span>
                  )}
                  {showPersonDrop && (filteredPeople.length > 0 || showCreateOption) && (
                    <div className="absolute z-10 mt-1 w-full bg-raised border border-line rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                      {filteredPeople.map((p) => (
                        <button
                          key={p.id}
                          onMouseDown={() => handleSelectPerson(p)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-accent-lo flex items-center gap-2"
                        >
                          <span className="w-6 h-6 rounded-full bg-accent-lo text-accent text-xs flex items-center justify-center font-medium shrink-0">
                            {p.name[0]?.toUpperCase()}
                          </span>
                          <span>{p.name}</span>
                          {p.affiliation && <span className="text-xs text-ink-3 ml-auto">{p.affiliation}</span>}
                        </button>
                      ))}
                      {showCreateOption && (
                        <button
                          onMouseDown={(e) => { e.preventDefault(); setShowPersonDrop(false); setShowPersonForm(true); }}
                          className="w-full text-left px-3 py-2 text-sm text-accent hover:bg-accent-lo flex items-center gap-2 border-t border-line-s"
                        >
                          <span className="w-6 h-6 rounded-full border-2 border-dashed border-violet-400 text-violet-500 text-xs flex items-center justify-center shrink-0">+</span>
                          Create "{personQuery.trim()}"
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Inline person-details form */}
                {showPersonForm && !sourcePerson && (
                  <div className="rounded-lg border border-accent-border bg-accent-lo p-3 space-y-2">
                    <p className="text-xs font-medium text-accent">New person: <span className="font-semibold">{personQuery.trim()}</span></p>
                    <div className="space-y-1.5">
                      <input
                        autoFocus
                        value={newPersonAffiliation}
                        onChange={(e) => setNewPersonAffiliation(e.target.value)}
                        placeholder="Affiliation (e.g. MIT, Google Brain) — optional"
                        className="w-full border border-line rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent bg-raised"
                      />
                      <input
                        value={newPersonEmail}
                        onChange={(e) => setNewPersonEmail(e.target.value)}
                        placeholder="Email — optional"
                        type="email"
                        className="w-full border border-line rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent bg-raised"
                      />
                    </div>
                    <div className="flex gap-2 pt-0.5">
                      <button
                        onClick={handleCreatePerson}
                        disabled={creatingPerson}
                        className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded hover:bg-accent disabled:opacity-50"
                      >
                        {creatingPerson ? "Creating…" : "Create person"}
                      </button>
                      <button
                        onClick={() => { setShowPersonForm(false); setNewPersonAffiliation(""); setNewPersonEmail(""); }}
                        className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink-2"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Source grid */}
            {sourceType === "source" && (
              <div className="grid grid-cols-3 gap-2">
                {SOURCE_OPTIONS.map((opt) => (
                  <button
                    key={opt.tag}
                    onClick={() => setSourceTag(sourceTag === opt.tag ? null : opt.tag)}
                    className={`group py-2.5 px-3 rounded-lg border text-sm font-medium flex flex-col items-center gap-1 transition-colors ${
                      sourceTag === opt.tag
                        ? "bg-accent border-accent text-white"
                        : "border-line text-ink-2 hover:border-violet-400 hover:text-accent"
                    }`}
                  >
                    <span className="flex items-center justify-center h-4">{opt.icon}</span>
                    <span className="text-xs">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Nothing selected yet — placeholder */}
            {!sourceType && (
              <p className="text-xs text-ink-3 text-center py-2">Select an option above, or skip to continue.</p>
            )}

            {error && (
              <p className="text-xs text-red-600">{error}</p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm text-ink-2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={() => { setSourceType(null); setSourcePerson(null); setSourceTag(null); setStep(1); }}
              className="px-4 py-2 text-sm text-ink-3 hover:text-ink"
            >
              Skip
            </button>
            <button
              onClick={() => setStep(1)}
              disabled={
                (sourceType === "person" && !sourcePerson) ||
                (sourceType === "source" && !sourceTag)
              }
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 2 (summary prompt) ────────────────────────────────────────

  if (step === 2) {
    const isModified = summaryInstructions.trim() !== settings.defaultSummaryInstructions.trim();
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <ModalHeader step={2} title="AI Summary Prompt" subtitle={urlMode ? "PDF will be downloaded automatically (arXiv/bioRxiv). Summary uses full text if available, otherwise abstract." : "Customize the summary instructions for this paper. Change your default in Settings."} />

          <div className="px-6 py-4">
            <textarea
              value={summaryInstructions}
              onChange={(e) => setSummaryInstructions(e.target.value)}
              rows={10}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
            {isModified && (
              <button
                onClick={() => setSummaryInstructions(settings.defaultSummaryInstructions)}
                className="mt-1.5 text-xs text-ink-3 hover:text-accent transition-colors"
              >
                ↺ Reset to saved default
              </button>
            )}
            <p className="mt-2 text-xs text-ink-3">
              The paper title and full text are appended automatically — no need to include them in the prompt.
            </p>
          </div>

          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button onClick={() => setStep(1)} disabled={saving} className="px-4 py-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50">← Back</button>
            <button onClick={confirm} disabled={saving || !title.trim()}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50 flex items-center gap-2">
              {saving && <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>}
              {saving ? (urlMode ? "Importing…" : "Uploading…") : (urlMode ? "Import →" : "Upload →")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 3 (refs) ───────────────────────────────────────────────────

  const pdfMissingBanner = pdfMissing ? (
    <div className="mx-6 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <p className="text-xs font-medium text-amber-800 mb-1.5">PDF not downloaded automatically</p>
      <p className="text-xs text-amber mb-2">
        The PDF couldn't be fetched (Cloudflare-protected or paywalled).{" "}
        {url && <a href={url} target="_blank" rel="noreferrer" className="underline font-medium hover:text-amber-900">Open paper page ↗</a>}
        {" "}— download the PDF manually and upload it below to enable full-text chat and search.
      </p>
      {pdfUploaded ? (
        <p className="text-xs text-accent font-medium">PDF uploaded successfully.</p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setManualPdf(e.target.files?.[0] ?? null)}
            className="text-xs text-ink-2 file:mr-2 file:py-1 file:px-2 file:text-xs file:border file:border-line file:rounded file:bg-raised file:text-ink-2 hover:file:bg-base"
          />
          {manualPdf && (
            <button
              onClick={uploadManualPdf}
              disabled={uploadingPdf}
              className="px-2.5 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1"
            >
              {uploadingPdf && <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>}
              {uploadingPdf ? "Uploading…" : "Upload PDF"}
            </button>
          )}
        </div>
      )}
    </div>
  ) : null;

  if (step === 3 && uploadedPaper) {
    const refs = uploadedPaper.references_found;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <ModalHeader step={3} title="Save references?" subtitle={`Found ${refs.length} reference${refs.length !== 1 ? "s" : ""} — uncheck any to skip.`} />
          {pdfMissingBanner}
          <div className="px-6 py-3 max-h-[55vh] overflow-y-auto space-y-1">
            {refs.map((ref, i) => (
              <label key={i} className="flex items-start gap-2 cursor-pointer hover:bg-base rounded px-1 py-1">
                <input type="checkbox" className="mt-0.5 shrink-0" checked={checkedRefs[i] ?? true}
                  onChange={(e) => { const n = [...checkedRefs]; n[i] = e.target.checked; setCheckedRefs(n); }} />
                <span className="text-xs text-ink-2 leading-snug">
                  <span className="font-medium">{ref.title}</span>
                  {ref.year ? <span className="text-ink-3"> · {ref.year}</span> : null}
                  {ref.doi  ? <span className="text-ink-3"> · {ref.doi}</span>  : null}
                </span>
              </label>
            ))}
          </div>
          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button onClick={() => goToTagStep(uploadedPaper)} disabled={savingRefs} className="px-4 py-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50">Skip</button>
            <button onClick={confirmRefs} disabled={savingRefs || checkedRefs.every((c) => !c)}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50">
              {savingRefs ? "Saving…" : `Save ${checkedRefs.filter(Boolean).length} · Next →`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 4 (tags) ─────────────────────────────────────────────────

  if (step === 4 && uploadedPaper) {
    const allSuggested = [...new Set([...tagSuggestions.existing, ...tagSuggestions.new])];
    const remainingTags = tagSuggestions.all_tags.filter((t) => !allSuggested.includes(t));
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <ModalHeader step={4} title="Add tags" subtitle="Click to apply. Tags help you filter and organise your library." />
          <div className="px-6 py-4 space-y-3 max-h-[65vh] overflow-y-auto">
            {tagsLoading ? (
              <p className="text-xs text-ink-3 animate-pulse">Suggesting tags…</p>
            ) : (
              <>
                {allSuggested.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-ink-3 uppercase tracking-wide mb-1.5">Suggested</p>
                    <div className="flex flex-wrap gap-2">
                      {allSuggested.map((tag) => {
                        const isOn = appliedTags.has(tag);
                        const isNew = tagSuggestions.new.includes(tag) && !tagSuggestions.existing.includes(tag);
                        return (
                          <button
                            key={tag}
                            onClick={() => addTagToApplied(tag)}
                            disabled={addingTag || isOn}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              isOn
                                ? "bg-accent text-white border-accent"
                                : "bg-raised text-ink-2 border-line hover:border-violet-400 hover:text-accent"
                            }`}
                          >
                            {isNew && !isOn && <span className="mr-1 text-violet-400">✦</span>}
                            {tag}
                            {isOn && <span className="ml-1">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {remainingTags.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-ink-3 uppercase tracking-wide mb-1.5">Your library tags</p>
                    <div className="flex flex-wrap gap-2">
                      {remainingTags.map((tag) => {
                        const isOn = appliedTags.has(tag);
                        return (
                          <button
                            key={tag}
                            onClick={() => addTagToApplied(tag)}
                            disabled={addingTag || isOn}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              isOn
                                ? "bg-accent text-white border-accent"
                                : "bg-raised text-ink-2 border-line hover:border-violet-400 hover:text-accent"
                            }`}
                          >
                            {tag}
                            {isOn && <span className="ml-1">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {allSuggested.length === 0 && remainingTags.length === 0 && (
                  <p className="text-xs text-ink-3">No tags in your library yet — add one below.</p>
                )}
              </>
            )}
            {appliedTags.size > 0 && (
              <p className="text-xs text-ink-3">{appliedTags.size} tag{appliedTags.size !== 1 ? "s" : ""} applied: {[...appliedTags].join(", ")}</p>
            )}
            <div className="flex gap-2">
              <input
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitCustomTag()}
                placeholder="Add a custom tag…"
                className="flex-1 border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={submitCustomTag}
                disabled={addingTag || !customTag.trim()}
                className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button onClick={() => setStep(5)} className="px-4 py-2 text-sm text-ink-3 hover:text-ink">Skip</button>
            <button onClick={() => setStep(5)} className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent">
              Next →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 5 (project) ─────────────────────────────────────────────

  if (step === 5 && uploadedPaper) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <ModalHeader step={5} title="Add to project" subtitle="Group this paper with related work. You can add it to more projects later." />
          <div className="px-6 py-4 space-y-3">
            {projects.length === 0 ? (
              <p className="text-xs text-ink-3 italic">No projects yet — create one from the Projects page.</p>
            ) : (
              <div className="max-h-52 overflow-y-auto space-y-1.5">
                {projects.map((p) => {
                  const isSelected = p.id === projectOnboardSelectedId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => { if (!projectOnboardAdded) setProjectOnboardSelectedId(isSelected ? "" : p.id); }}
                      disabled={projectOnboardAdded}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-colors ${
                        isSelected
                          ? "border-violet-500 bg-accent-lo text-violet-800"
                          : "border-line bg-raised text-ink-2 hover:border-accent-border hover:bg-accent-lo disabled:opacity-60"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        {isSelected && <span className="text-violet-500">✓</span>}
                        <span className="font-medium">{p.name}</span>
                      </div>
                      {p.description && <p className="text-ink-3 mt-0.5 truncate">{p.description}</p>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button onClick={() => setStep(6)} className="px-4 py-2 text-sm text-ink-3 hover:text-ink">
              {projectOnboardAdded ? "Next →" : "Skip"}
            </button>
            {!projectOnboardAdded && projectOnboardSelectedId && (
              <button
                onClick={async () => {
                  setProjectOnboardAdding(true);
                  try {
                    await addPaperToProject(projectOnboardSelectedId, uploadedPaper.id);
                    setProjectOnboardAdded(true);
                  } catch { /* ignore */ }
                  finally { setProjectOnboardAdding(false); }
                }}
                disabled={projectOnboardAdding}
                className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50"
              >
                {projectOnboardAdding ? "Adding…" : "Add to project"}
              </button>
            )}
            {projectOnboardAdded && (
              <button onClick={() => setStep(6)} className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent">
                Next →
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 6 (people) ───────────────────────────────────────────────

  if (step === 6 && uploadedPaper) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <ModalHeader step={5} title="Link people" subtitle="Authors were auto-extracted. Link additional people — supervisor, colleague, who shared this with you…" />
          <div className="px-6 py-4 space-y-3">
            {uploadedPaper.authors.length > 0 && (
              <div>
                <p className="text-xs font-medium text-ink-3 uppercase tracking-wide mb-1.5">Authors (auto-extracted)</p>
                <div className="flex flex-wrap gap-1.5">
                  {uploadedPaper.authors.map((a) => (
                    <span key={a} className="px-2.5 py-1 text-xs bg-accent-lo text-accent border border-blue-100 rounded-full">{a}</span>
                  ))}
                </div>
              </div>
            )}
            {linkedPeople.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {linkedPeople.map((p, i) => (
                  <span key={i} className="px-2.5 py-1 text-xs bg-accent-lo text-accent border border-accent-border rounded-full">
                    {p.name} · <span className="text-violet-400">{p.role.replace("_", " ")}</span>
                    {p.years_known && <span className="text-gray-400"> · {p.years_known}</span>}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <input
                value={newPersonName}
                onChange={(e) => setNewPersonName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && linkNewPerson()}
                placeholder="Person's name…"
                className="flex-1 min-w-32 border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <select
                value={newPersonRole}
                onChange={(e) => setNewPersonRole(e.target.value)}
                className="border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-raised text-ink-2"
              >
                {INVOLVE_ROLES.map((r) => (
                  <option key={r} value={r}>{r.replace("_", " ")}</option>
                ))}
              </select>
              <select
                value={newPersonYears}
                onChange={(e) => setNewPersonYears(e.target.value)}
                className="border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-raised text-ink-2"
              >
                <option value="">Years known…</option>
                {YEARS_KNOWN_OPTIONS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <button
                onClick={linkNewPerson}
                disabled={linkingPerson || !newPersonName.trim()}
                className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent disabled:opacity-50"
              >
                {linkingPerson ? "…" : "Link"}
              </button>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
            <button onClick={finishOnboarding} className="px-4 py-2 text-sm text-ink-3 hover:text-ink">Skip</button>
            <button onClick={finishOnboarding} className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent">
              Done ✓
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Step 1 ─────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-line-s flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-ink">Confirm paper details</h2>
            <StepDots current={1} />
          </div>
          <div className="flex items-center gap-2">
            {queuePosition && queueTotal && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-raised text-ink-3 border border-line-s">
                {queuePosition} / {queueTotal}
              </span>
            )}
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${source.color}`}>{source.label}</span>
          </div>
        </div>

        <div className="px-6 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <Field label="Title *">
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
              className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </Field>
          <Field label="Authors (comma separated)">
            <input type="text" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Author One, Author Two"
              className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </Field>
          <div className="flex gap-3">
            <Field label="Year" className="w-24 shrink-0">
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2024"
                className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </Field>
            <Field label="DOI / arXiv ID" className="flex-1">
              <input type="text" value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.xxxx/… or arXiv:…"
                className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </Field>
          </div>
          <Field label="Abstract">
            <textarea value={abstract} onChange={(e) => setAbstract(e.target.value)} rows={4} className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
          </Field>
          {!urlMode && (
            <Field label="Document type">
              <div className="flex gap-2">
                {([ ["paper", "📄 Paper"], ["book", "📚 Book"], ["lecture_deck", "🎓 Lecture deck"], ["news_article", "📰 News"] ] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setDocumentType(val)}
                    className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-lg border transition-colors ${documentType === val ? "bg-accent text-white border-accent" : "border-line text-ink-2 hover:border-violet-400 hover:text-accent"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {documentType === "news_article" && (
                <p className="mt-1.5 text-xs text-accent">
                  📰 Reference & figure extraction will be skipped, but you still get an AI summary and claims. Set the outlet under <strong>Venue</strong> and the publication date below.
                </p>
              )}
              {documentType === "news_article" && (
                <Field label="Published date" className="mt-2">
                  <input
                    type="date"
                    value={publishedDate}
                    onChange={(e) => setPublishedDate(e.target.value)}
                    className="w-full border border-line rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </Field>
              )}
              {(documentType === "book" || documentType === "lecture_deck") && (
                <p className="mt-1.5 text-xs text-accent">
                  📌 References & figure extraction will be skipped. After upload, use the <strong>Chapters</strong> tab to auto-detect chapter structure and summaries.
                </p>
              )}
            </Field>
          )}
          {/* PDF attachment — always available in URL mode */}
          {urlMode && (
            <div className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
              !authors.trim() || !abstract.trim()
                ? "border-amber-200 bg-amber-50"
                : "border-line bg-base"
            }`}>
              {(!authors.trim() || !abstract.trim()) && (
                <p className="text-xs font-medium text-amber-800">
                  {!authors.trim() && !abstract.trim()
                    ? "Authors and abstract are missing."
                    : !authors.trim() ? "Authors are missing." : "Abstract is missing."}
                  {" "}Try extracting them from the PDF.
                </p>
              )}
              {pdfFallbackDone ? (
                <p className="text-xs text-accent font-medium">✓ Fields filled from PDF extraction.</p>
              ) : pdfFallbackError ? (
                <div className="space-y-2">
                  <p className="text-xs text-coral">
                    Auto-download blocked (Cloudflare/paywalled).{" "}
                    <a href={url} target="_blank" rel="noreferrer" className="underline font-medium hover:text-red-900">
                      Open paper page ↗
                    </a>
                    {" "}— download the PDF manually and upload it here:
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="file"
                        accept="application/pdf"
                        className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePreImportPdf(f); }}
                      />
                      <span className="px-2.5 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 cursor-pointer flex items-center gap-1.5">
                        {preImportPdfLoading && (
                          <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                          </svg>
                        )}
                        {preImportPdfLoading ? "Extracting…" : preImportPdf ? `✓ ${preImportPdf.name}` : "Upload PDF"}
                      </span>
                    </label>
                    {preImportPdf && <p className="text-xs text-accent">PDF ready — will be attached on import.</p>}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handlePdfFallback}
                    disabled={pdfFallbackLoading}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50 transition-colors"
                  >
                    {pdfFallbackLoading && (
                      <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    )}
                    {pdfFallbackLoading ? "Downloading…" : "↓ Fetch PDF automatically"}
                  </button>
                  <span className="text-xs text-ink-3">or</span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePreImportPdf(f); }}
                    />
                    <span className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-gray-300 text-ink-2 rounded-lg hover:border-violet-400 hover:text-accent transition-colors cursor-pointer">
                      {preImportPdfLoading && (
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                      )}
                      {preImportPdfLoading ? "Reading…" : preImportPdf ? `✓ ${preImportPdf.name}` : "Upload PDF manually"}
                    </span>
                  </label>
                  {preImportPdf && <p className="text-xs text-accent">PDF will be attached on import.</p>}
                </div>
              )}
            </div>
          )}

          {duplicate && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs">
              <span className="text-amber mt-0.5 shrink-0">⚠</span>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-amber-800">Possible duplicate — </span>
                {duplicate.drive_file_id ? (
                  <span className="text-amber">"{duplicate.title}" already has a PDF in your library.</span>
                ) : (
                  <span className="text-amber">"{duplicate.title}" exists as a reference without a PDF. Uploading now will enrich that existing paper.</span>
                )}
              </div>
              <a
                href={`/paper/${duplicate.id}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-amber underline hover:text-amber-900 font-medium"
              >
                View →
              </a>
            </div>
          )}
          {error && <p className="text-xs text-coral">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-line-s flex justify-end gap-2">
          <button onClick={onCancel} disabled={saving} className="px-4 py-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50">
            {error ? "Cancel this paper" : queueTotal ? "← Queue" : "Cancel"}
          </button>
          {settings.showSummaryPromptStep && !skipSummaryStep ? (
            <button onClick={() => setStep(2)} disabled={!title.trim()}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50">
              Next →
            </button>
          ) : (
            <button onClick={confirm} disabled={saving || !title.trim()}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent disabled:opacity-50 flex items-center gap-2">
              {saving && <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>}
              {saving ? (urlMode ? "Importing…" : "Uploading…") : urlMode ? "Import →" : "Upload →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function ModalHeader({ step, title, subtitle }: { step: number; title: string; subtitle: string }) {
  return (
    <div className="px-6 py-4 border-b border-line-s">
      <div className="flex items-center justify-between mb-0.5">
        <h2 className="font-semibold text-ink">{title}</h2>
        <StepDots current={step} />
      </div>
      <p className="text-xs text-ink-3">{subtitle}</p>
    </div>
  );
}

function StepDots({ current }: { current: number }) {
  return (
    <div className="flex gap-1 items-center">
      {[0, 1, 2, 3, 4, 5, 6].map((n) => (
        <span key={n} className={`w-1.5 h-1.5 rounded-full transition-colors ${n === current ? "bg-accent" : n < current ? "bg-violet-300" : "bg-raised"}`} />
      ))}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-ink-3 mb-1">{label}</label>
      {children}
    </div>
  );
}
