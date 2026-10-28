import { useCallback, useRef, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";
import { parsePdf, preprocessPdf, getPreprocessStatus, preanalyzePdf, getPreanalysisStatus, previewUrl, deletePaper, checkDuplicate } from "../api/client";
import UploadConfirmModal from "./UploadConfirmModal";
import type { ParsedMeta, T_IngestOut } from "../types";
import type { TagSuggestions } from "../api/client";
import {
  persistItem, removePersistedItem, loadPersistedQueue,
  fileToBuffer, bufferToFile,
} from "../lib/queueStorage";

interface Props {
  onUploaded: (paper: T_IngestOut) => void;
  debug?: boolean;
}

type Tab = "pdf" | "url" | "bulk" | "queue";
type PdfStatus = "parsing" | "uploading" | "ready" | "duplicate" | "error" | "done";

type QueuedPdf = {
  id: string;
  file: File;
  meta: ParsedMeta | null;
  status: PdfStatus;
  error: string | null;
  uploadResult?: T_IngestOut;
  duplicateId?: string;
  duplicateTitle?: string;
  duplicateHasPdf?: boolean;
  /** SHA-256 cache key from POST /papers/preprocess — Docling runs once per key. */
  preprocessKey?: string;
  preprocessStatus?: "pending" | "running" | "ready" | "error";
  /** SHA-256 cache key from POST /papers/preanalyze — LLM analysis runs once per key. */
  analysisKey?: string;
  analysisStatus?: "pending" | "running" | "ready" | "error";
  /** Precomputed tag suggestions, ready before the user opens the modal. */
  tagSuggestions?: TagSuggestions;
};

export default function PaperDrop({ onUploaded, debug }: Props) {
  const navigate = useNavigate();
  const [open, setOpen]   = useState(false);
  const [tab, setTab]     = useState<Tab>("pdf");
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // PDF queue
  const [queue, setQueue]         = useState<QueuedPdf[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  // URL state
  const [urlValue, setUrlValue]     = useState("");
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [urlMeta, setUrlMeta]       = useState<ParsedMeta | null>(null);
  const persistSigById = useRef<Map<string, string>>(new Map());
  const fileBytesById = useRef<Map<string, ArrayBuffer>>(new Map());

  // ── Restore queue from IndexedDB on mount ──────────────────────────────────
  useEffect(() => {
    loadPersistedQueue().then((stored) => {
      if (!stored.length) return;
      const restored: QueuedPdf[] = stored.map((s) => ({
        id: s.id,
        file: bufferToFile(s.fileBytes, s.fileName, s.fileType),
        meta: s.meta,
        status: s.status,
        error: s.error,
        duplicateId: s.duplicateId,
        duplicateTitle: s.duplicateTitle,
        duplicateHasPdf: s.duplicateHasPdf,
        uploadResult: s.uploadResult,
        preprocessKey: s.preprocessKey,
        preprocessStatus: s.preprocessStatus as QueuedPdf["preprocessStatus"],
        analysisKey: s.analysisKey,
        analysisStatus: s.analysisStatus as QueuedPdf["analysisStatus"],
        tagSuggestions: s.tagSuggestions as QueuedPdf["tagSuggestions"],
      }));
      setQueue(restored);
      setTab("queue");
      // The precompute results live in a backend disk cache that may have been
      // cleared (e.g. backend restart). Re-verify each restored row and kick off
      // a fresh precompute for anything that is no longer ready, so the queue
      // ends up fully precomputed again without the user doing anything.
      restored.forEach((item) => { void ensurePrecompute(item); });
    }).catch(() => { /* IndexedDB unavailable — silent fail */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist queue changes to IndexedDB ────────────────────────────────────
  useEffect(() => {
    const liveIds = new Set(queue.map((q) => q.id));
    // Drop stale cache entries for removed queue rows.
    [...persistSigById.current.keys()].forEach((id) => {
      if (!liveIds.has(id)) persistSigById.current.delete(id);
    });
    [...fileBytesById.current.keys()].forEach((id) => {
      if (!liveIds.has(id)) fileBytesById.current.delete(id);
    });

    queue.forEach((item) => {
      if (item.status === "done" || item.status === "uploading" || item.status === "parsing") {
        // Transient states — remove from store if previously saved
        removePersistedItem(item.id).catch(() => {});
        persistSigById.current.delete(item.id);
        fileBytesById.current.delete(item.id);
        return;
      }

      const persistSig = JSON.stringify({
        status: item.status,
        error: item.error,
        meta: item.meta,
        duplicateId: item.duplicateId,
        duplicateTitle: item.duplicateTitle,
        duplicateHasPdf: item.duplicateHasPdf,
        uploadResultId: item.uploadResult?.id,
        preprocessKey: item.preprocessKey,
        preprocessStatus: item.preprocessStatus,
        analysisKey: item.analysisKey,
        analysisStatus: item.analysisStatus,
        hasTagSuggestions: !!item.tagSuggestions,
      });
      if (persistSigById.current.get(item.id) === persistSig) return;

      const cachedBytes = fileBytesById.current.get(item.id);
      const doPersist = (bytes: ArrayBuffer) => {
        persistItem({
          id: item.id,
          fileName: item.file.name,
          fileType: item.file.type,
          fileBytes: bytes,
          meta: item.meta,
          status: item.status as "ready" | "error",
          error: item.error,
          duplicateId: item.duplicateId,
          duplicateTitle: item.duplicateTitle,
          duplicateHasPdf: item.duplicateHasPdf,
          uploadResult: item.uploadResult,
          preprocessKey: item.preprocessKey,
          preprocessStatus: item.preprocessStatus,
          analysisKey: item.analysisKey,
          analysisStatus: item.analysisStatus,
          tagSuggestions: item.tagSuggestions,
        })
          .then(() => {
            persistSigById.current.set(item.id, persistSig);
          })
          .catch(() => {});
      };

      if (cachedBytes) {
        doPersist(cachedBytes);
        return;
      }

      fileToBuffer(item.file)
        .then((bytes) => {
          fileBytesById.current.set(item.id, bytes);
          doPersist(bytes);
        })
        .catch(() => {});
    });
  }, [queue]);

  // Auto-switch to queue tab when items arrive
  useEffect(() => {
    if (queue.length > 0 && tab !== "queue") setTab("queue");
  }, [queue.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll Docling preprocess status for queued items
  useEffect(() => {
    const pending = queue.filter(
      (q) => q.preprocessKey && q.preprocessStatus && !["ready", "error"].includes(q.preprocessStatus),
    );
    if (!pending.length) return;
    const interval = setInterval(() => {
      pending.forEach((item) => {
        if (!item.preprocessKey) return;
        getPreprocessStatus(item.preprocessKey)
          .then(({ status }) => {
            if (status === item.preprocessStatus) return;
            updateItem(item.id, {
              preprocessStatus: status as QueuedPdf["preprocessStatus"],
            });
          })
          .catch(() => {});
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll LLM analysis status for queued items (summary/claims/refs/tags precompute)
  useEffect(() => {
    const pending = queue.filter(
      (q) => q.analysisKey && q.analysisStatus && !["ready", "error"].includes(q.analysisStatus),
    );
    if (!pending.length) return;
    const interval = setInterval(() => {
      pending.forEach((item) => {
        if (!item.analysisKey) return;
        getPreanalysisStatus(item.analysisKey)
          .then(({ status, tag_suggestions, meta }) => {
            if (status === item.analysisStatus) return;
            updateItem(item.id, {
              analysisStatus: status as QueuedPdf["analysisStatus"],
              ...(tag_suggestions ? { tagSuggestions: tag_suggestions } : {}),
              ...(meta?.title ? { meta } : {}),
            });
          })
          .catch(() => {});
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-remove done rows after 3 s (also cleans IndexedDB)
  useEffect(() => {
    const done = queue.filter((q) => q.status === "done");
    if (!done.length) return;
    const timer = setTimeout(() => {
      done.forEach((q) => removePersistedItem(q.id).catch(() => {}));
      setQueue((prev) => prev.filter((q) => q.status !== "done"));
    }, 3000);
    return () => clearTimeout(timer);
  }, [queue]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const updateItem = (id: string, patch: Partial<QueuedPdf>) =>
    setQueue((prev) => prev.map((q) => q.id === id ? { ...q, ...patch } : q));

  // Stage 1b: kick off Docling figure/table precompute (background on backend).
  const firePreprocess = async (item: QueuedPdf) => {
    try {
      const { preprocess_key, status } = await preprocessPdf(item.file);
      updateItem(item.id, {
        preprocessKey: preprocess_key,
        preprocessStatus: status === "pending" ? "pending" : status as QueuedPdf["preprocessStatus"],
      });
    } catch {
      /* non-fatal — upload will run Docling inline if needed */
    }
  };

  // Stage 1c: kick off heavy LLM analysis precompute (background on backend).
  const firePreanalyze = async (item: QueuedPdf) => {
    try {
      const { analysis_key, status } = await preanalyzePdf(item.file);
      updateItem(item.id, {
        analysisKey: analysis_key,
        analysisStatus: status === "pending" ? "pending" : status as QueuedPdf["analysisStatus"],
      });
    } catch {
      /* non-fatal — upload will run the analysis inline if needed */
    }
  };

  // After restoring the queue from IndexedDB, the backend disk cache that holds
  // the precomputed results may be gone (e.g. backend restarted) or may not have
  // finished yet. Re-verify each row and restart precompute for whatever is no
  // longer ready, so the queue self-heals back to fully precomputed.
  const ensurePrecompute = async (item: QueuedPdf) => {
    if (item.status !== "ready") return;

    let preprocessOk = false;
    if (item.preprocessKey && item.preprocessStatus === "ready") {
      try {
        const { status } = await getPreprocessStatus(item.preprocessKey);
        preprocessOk = status === "ready";
        if (status !== item.preprocessStatus) {
          updateItem(item.id, { preprocessStatus: status as QueuedPdf["preprocessStatus"] });
        }
      } catch {
        preprocessOk = false;
      }
    }
    if (!preprocessOk) await firePreprocess(item);

    let analysisOk = false;
    if (item.analysisKey && item.analysisStatus === "ready") {
      try {
        const { status, tag_suggestions, meta } = await getPreanalysisStatus(item.analysisKey);
        analysisOk = status === "ready";
        updateItem(item.id, {
          analysisStatus: status as QueuedPdf["analysisStatus"],
          ...(tag_suggestions ? { tagSuggestions: tag_suggestions } : {}),
          ...(meta?.title ? { meta } : {}),
        });
      } catch {
        analysisOk = false;
      }
    }
    if (!analysisOk) await firePreanalyze(item);
  };

  const prepareItem = async (item: QueuedPdf, meta: ParsedMeta) => {
    // Check for duplicates before showing the modal (with timeout)
    try {
      const dupPromise = checkDuplicate(meta.doi || undefined, meta.title || undefined);
      const timeoutPromise = new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error("Duplicate check timeout")), 8000)
      );
      const dup = await Promise.race([dupPromise, timeoutPromise]);
      
      if (dup) {
        if (dup.hasPdf) {
          updateItem(item.id, {
            meta,
            status: "duplicate",
            duplicateId: dup.id,
            duplicateTitle: dup.title,
            duplicateHasPdf: true,
          });
          return;
        }
        // Existing reference stub (no PDF): keep row reviewable so upload can enrich it.
        updateItem(item.id, {
          meta,
          status: "ready",
          duplicateId: dup.id,
          duplicateTitle: dup.title,
          duplicateHasPdf: false,
        });
        return;
      }
    } catch (e) { 
      console.warn("Duplicate check failed or timed out:", e);
      /* best-effort — proceed if check fails */ 
    }

    updateItem(item.id, { meta, status: "ready" });
  };

  const onDrop = useCallback((files: File[]) => {
    if (!files.length) return;
    setError(null);

    const newItems: QueuedPdf[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      meta: null,
      status: "parsing" as PdfStatus,
      error: null,
    }));

    setQueue((prev) => [...prev, ...newItems]);

    // Each file uploads its full bytes twice (once for /parse, once for
    // /preprocess). Firing them all at once exhausts the browser's per-host
    // connection limit (Safari allows ~6), and the surplus uploads stall and
    // abort with "Load failed" behind the HTTPS reverse proxy. So we process
    // files through a small concurrency pool and run the two stages
    // sequentially per file — never more than CONCURRENCY uploads in flight.
    const CONCURRENCY = 2;
    let cursor = 0;

    const processOne = async (item: QueuedPdf) => {
      // Stage 1a: metadata preview (fast — no LLM). Abort after 60s so a stuck
      // request frees its connection slot instead of hanging the pool.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const meta = await parsePdf(item.file, ctrl.signal);
        clearTimeout(timer);
        await prepareItem(item, meta);
      } catch (e) {
        clearTimeout(timer);
        const timedOut = e instanceof DOMException && e.name === "AbortError";
        updateItem(item.id, {
          status: "error",
          error: timedOut
            ? "Metadata extraction timed out — try again or upload anyway"
            : e instanceof Error ? e.message : "Could not read PDF",
        });
      }

      // Stage 1b: Docling figures + tables. The backend returns immediately
      // (work runs in a background thread), so this is a quick request.
      await firePreprocess(item);

      // Stage 1c: Heavy LLM analysis (summary, topics, claims, references,
      // tag suggestions). Runs in a background thread on the backend and is
      // reused at upload time, so clicking through the queue is instant.
      await firePreanalyze(item);
    };

    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= newItems.length) break;
        await processOne(newItems[i]);
      }
    };

    const poolSize = Math.min(CONCURRENCY, newItems.length);
    void Promise.all(Array.from({ length: poolSize }, () => worker()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  });

  const handleDeleteRow = async (item: QueuedPdf) => {
    if (item.uploadResult) {
      try { await deletePaper(item.uploadResult.id); } catch { /* best-effort */ }
    }
    removePersistedItem(item.id).catch(() => {});
    setQueue((prev) => prev.filter((q) => q.id !== item.id));
    if (queue[activeIdx]?.id === item.id) setActiveIdx(-1);
  };

  const handleClickRow = (idx: number) => {
    const item = queue[idx];
    if (item.status === "ready") setActiveIdx(idx);
  };

  const handleUrlSubmit = async () => {
    if (!urlValue.trim()) return;
    setLoadingUrl(true);
    setError(null);
    try {
      const meta = await previewUrl(urlValue.trim());
      setPendingUrl(urlValue.trim());
      setUrlMeta(meta);
      setUrlValue("");
      setOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not resolve URL");
    } finally {
      setLoadingUrl(false);
    }
  };

  const pendingCount = queue.filter((q) => q.status !== "done").length;

  return (
    <>
      <div className="relative" ref={panelRef}>
        {/* Plus button with queue badge */}
        <button
          onClick={() => { setOpen((o) => !o); setError(null); }}
          title="Add paper"
          className={`relative flex items-center justify-center w-9 h-9 rounded-lg border transition-colors shrink-0
            ${open
              ? "bg-violet-600 border-violet-600 text-white"
              : "border-gray-200 text-gray-500 hover:border-violet-400 hover:text-violet-600 bg-white"
            }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {pendingCount > 0 && (
            <span className="absolute -top-2.5 -right-2.5 min-w-[22px] h-[22px] px-1.5 rounded-full bg-violet-500 text-white text-xs font-semibold flex items-center justify-center border-2 border-white leading-none">
              {pendingCount}
            </span>
          )}
        </button>

        {/* Floating panel */}
        {open && (
          <div className="absolute right-0 top-11 z-50 w-[480px] bg-white border border-gray-200 rounded-xl shadow-xl p-5 space-y-4">
            {/* Tab bar */}
            <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm font-medium">
              <button
                onClick={() => { setTab("pdf"); setError(null); }}
                className={`flex-1 py-2.5 transition-colors ${tab === "pdf" ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
              >
                PDF
              </button>
              <button
                onClick={() => { setTab("url"); setError(null); }}
                className={`flex-1 py-2.5 border-l border-gray-200 transition-colors ${tab === "url" ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
              >
                URL / DOI
              </button>
              <button
                onClick={() => { setTab("bulk"); setError(null); }}
                className={`flex-1 py-2.5 border-l border-gray-200 transition-colors ${tab === "bulk" ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
              >
                Bulk
              </button>
              {queue.length > 0 && (
                <button
                  onClick={() => setTab("queue")}
                  className={`flex-1 py-2.5 border-l border-gray-200 transition-colors flex items-center justify-center gap-1.5 ${tab === "queue" ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}
                >
                  Queue
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${tab === "queue" ? "bg-white/25 text-white" : "bg-violet-100 text-violet-600"}`}>
                    {pendingCount}
                  </span>
                </button>
              )}
            </div>

            {/* PDF drop zone */}
            {tab === "pdf" && (
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-xl px-6 py-10 text-center cursor-pointer transition-colors
                  ${isDragActive ? "border-violet-500 bg-violet-50" : "border-gray-300 hover:border-violet-400 hover:bg-gray-50"}`}
              >
                <input {...getInputProps()} />
                <svg className="w-8 h-8 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <p className="text-sm text-gray-500 font-medium">
                  {isDragActive ? "Drop PDFs here…" : "Drag & drop PDFs, or click to select"}
                </p>
                <p className="text-xs text-gray-400 mt-1">Select multiple — all start processing in parallel</p>
              </div>
            )}

            {/* URL input */}
            {tab === "url" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                    placeholder="https://arxiv.org/abs/2104.09864"
                    disabled={loadingUrl}
                    className="flex-1 border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 disabled:opacity-60"
                  />
                  <button
                    onClick={handleUrlSubmit}
                    disabled={loadingUrl || !urlValue.trim()}
                    className="px-4 py-2.5 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors font-medium"
                  >
                    {loadingUrl ? (
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    ) : "Add"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {["arxiv.org", "doi.org", "pubmed", "biorxiv.org"].map((s) => (
                    <span key={s} className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{s}</span>
                  ))}
                  <span className="text-xs text-gray-400">· plain DOIs & arXiv IDs</span>
                </div>
              </div>
            )}

            {/* Bulk import */}
            {tab === "bulk" && (
              <div className="space-y-3 text-center py-4">
                <svg className="w-8 h-8 mx-auto text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
                </svg>
                <p className="text-sm text-gray-600 font-medium">Import multiple papers at once</p>
                <p className="text-xs text-gray-400">Paste a JSON list of arXiv IDs, DOIs, or URLs</p>
                <button
                  onClick={() => { setOpen(false); navigate("/bulk-import"); }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors"
                >
                  Open Bulk Import
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </button>
              </div>
            )}

            {/* Queue panel */}
            {tab === "queue" && (
              <div className="space-y-1 max-h-[55vh] overflow-y-auto -mx-1 px-1">
                {queue.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">Queue is empty</p>
                ) : (
                  queue.map((item, idx) => (
                    <QueueRow
                      key={item.id}
                      item={item}
                      isActive={activeIdx === idx}
                      onClick={() => handleClickRow(idx)}
                      onDelete={() => handleDeleteRow(item)}
                    />
                  ))
                )}
                {queue.length > 0 && (
                  <div className="pt-2 border-t border-gray-100">
                    <button
                      onClick={() => setTab("pdf")}
                      className="w-full py-2 text-xs text-violet-600 hover:text-violet-700 font-medium flex items-center justify-center gap-1"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Add more PDFs
                    </button>
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
        )}
      </div>

      {/* Onboarding modal — shown when user clicks a ready row */}
      {activeIdx >= 0 && queue[activeIdx]?.meta && queue[activeIdx].status === "ready" && (() => {
        const reviewable = queue.filter((q) => !["error", "duplicate"].includes(q.status));
        const pos = reviewable.findIndex((q) => q.id === queue[activeIdx].id) + 1;
        return (
          <UploadConfirmModal
            file={queue[activeIdx].file}
            meta={queue[activeIdx].meta!}
            preprocessKey={queue[activeIdx].preprocessKey}
            analysisKey={queue[activeIdx].analysisKey}
            precomputedTagSuggestions={queue[activeIdx].tagSuggestions}
            skipSummaryStep={true}
            queuePosition={reviewable.length > 1 ? pos : undefined}
            queueTotal={reviewable.length > 1 ? reviewable.length : undefined}
            onConfirmed={(paper) => {
              updateItem(queue[activeIdx].id, { status: "done", uploadResult: paper });
              setActiveIdx(-1);
              onUploaded(paper);
            }}
            onCancel={() => setActiveIdx(-1)}
            debug={debug}
          />
        );
      })()}

      {/* URL modal */}
      {urlMeta && pendingUrl && (
        <UploadConfirmModal
          file={null}
          meta={urlMeta}
          url={pendingUrl}
          onConfirmed={(paper) => { setPendingUrl(null); setUrlMeta(null); onUploaded(paper); }}
          onCancel={() => { setPendingUrl(null); setUrlMeta(null); }}
          debug={debug}
        />
      )}
    </>
  );
}

// ── Queue row ────────────────────────────────────────────────────────────────

function QueueRow({
  item,
  isActive,
  onClick,
  onDelete,
}: {
  item: QueuedPdf;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  // A queued PDF is only "fully ready" (green, clickable) once metadata parsing,
  // Docling layout extraction AND the LLM analysis have all finished. Until then
  // the row shows a "preparing" state and is not clickable, so the user only
  // clicks through rows whose summary/figures/suggestions are already cached.
  const bgAllReady =
    item.preprocessStatus === "ready" && item.analysisStatus === "ready";
  // A stage is still "working" only when its job actually started (has a key)
  // and hasn't settled. If the start request failed (no key), don't block
  // forever — treat it as settled-but-incomplete (amber, clickable).
  const preprocessWorking =
    !!item.preprocessKey && item.preprocessStatus !== "ready" && item.preprocessStatus !== "error";
  const analysisWorking =
    !!item.analysisKey && item.analysisStatus !== "ready" && item.analysisStatus !== "error";
  const bgWorking = preprocessWorking || analysisWorking;

  const fullyReady = item.status === "ready" && bgAllReady;
  const preparing  = item.status === "ready" && bgWorking;
  const prepFailed = item.status === "ready" && !bgWorking && !bgAllReady;

  // Only fully-ready rows (everything precomputed) are clickable. Rows whose
  // background prep failed are still clickable (upload will compute inline).
  const isClickable = fullyReady || prepFailed;
  const title = item.meta?.title || item.uploadResult?.title || item.duplicateTitle || item.file.name;

  const layoutLabel =
    item.preprocessStatus === "ready" ? "layout ✓"
      : item.preprocessStatus === "error" ? "layout failed"
        : "layout…";
  const analysisLabel =
    item.analysisStatus === "ready" ? "analysis ✓"
      : item.analysisStatus === "error" ? "analysis failed"
        : "analysis…";
  const prepHint = ` · ${layoutLabel} · ${analysisLabel}`;

  const statusIcon = (() => {
    if (item.status === "ready") {
      if (fullyReady) return <span className="w-2 h-2 rounded-full bg-green-400 shrink-0 mt-0.5" />;
      if (preparing)  return <Spinner color="text-violet-400" />;
      return <span className="text-amber-500 shrink-0 leading-none mt-0.5">⚠</span>; // prepFailed
    }
    return {
      parsing:   <Spinner color="text-violet-400" />,
      uploading: <Spinner color="text-violet-600" />,
      duplicate: <span className="text-amber-500 shrink-0 leading-none mt-0.5">⚠</span>,
      error:     <span className="text-red-400 shrink-0 leading-none mt-0.5">✕</span>,
      done:      <span className="text-gray-300 shrink-0 leading-none mt-0.5">✓</span>,
    }[item.status as Exclude<PdfStatus, "ready">];
  })();

  const readyText = (() => {
    const stub = item.duplicateId && item.duplicateHasPdf === false;
    if (fullyReady) {
      return stub
        ? "Reference exists without PDF — click to attach PDF"
        : "Ready — click to review";
    }
    if (preparing) return `Preparing…${prepHint}`;
    // prepFailed — clickable, but background precompute didn't fully complete.
    return stub
      ? `Reference exists without PDF — click to attach PDF${prepHint}`
      : `Ready — click to review (background prep incomplete)${prepHint}`;
  })();

  const statusText = item.status === "ready" ? readyText : {
    parsing:   "Extracting metadata…",
    uploading: "Uploading…",
    duplicate: "Already in your library",
    error:     item.error ?? "Something went wrong",
    done:      "Added ✓",
  }[item.status as Exclude<PdfStatus, "ready">];

  const statusColor = item.status === "ready"
    ? (fullyReady ? "text-green-600" : preparing ? "text-violet-400" : "text-amber-600")
    : {
        parsing:   "text-violet-400",
        uploading: "text-violet-500",
        duplicate: "text-amber-600",
        error:     "text-red-500",
        done:      "text-gray-300",
      }[item.status as Exclude<PdfStatus, "ready">];

  return (
    <div
      onClick={isClickable ? onClick : undefined}
      className={`group flex items-start gap-2.5 px-3 py-2.5 rounded-lg transition-colors ${
        isClickable
          ? "cursor-pointer hover:bg-violet-50"
          : "cursor-default"
      } ${isActive ? "bg-violet-50 ring-1 ring-violet-200" : ""} ${
        item.status === "done" ? "opacity-40" : ""
      }`}
    >
      <div className="mt-1 shrink-0">{statusIcon}</div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{title}</p>
        <p className={`text-xs mt-0.5 ${statusColor}`}>{statusText}</p>
        {item.duplicateId && item.duplicateHasPdf === false && (
          <a
            href={`/paper/${item.duplicateId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-violet-600 hover:underline mt-0.5 inline-block"
          >
            Open existing reference →
          </a>
        )}
        {item.status === "duplicate" && item.duplicateId && (
          <a
            href={`/paper/${item.duplicateId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-violet-600 hover:underline mt-0.5 inline-block"
          >
            View existing →
          </a>
        )}
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Remove"
        className="shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded text-gray-300 hover:text-red-400 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <svg className={`animate-spin h-3.5 w-3.5 ${color} shrink-0`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}
