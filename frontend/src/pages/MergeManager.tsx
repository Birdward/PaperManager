import { useState } from "react";
import { scanDuplicates, executeMerge, type DuplicatePair } from "../api/client";

export default function MergeManager() {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [totalPapers, setTotalPapers] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [resolved, setResolved] = useState<Set<number>>(new Set());
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<string | null>(null);

  const runScan = async () => {
    setScanning(true);
    setScanError(null);
    setPairs(null);
    setResolved(new Set());
    setCurrentIndex(0);
    setMergeResult(null);
    try {
      const result = await scanDuplicates();  // detection is rule-based (DOI and title); no model
      setPairs(result.pairs);
      setTotalPapers(result.total_papers);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const activePairs = pairs?.filter((_, i) => !resolved.has(i)) ?? [];
  const currentPair = activePairs[currentIndex] ?? null;

  const skip = () => {
    if (currentIndex < activePairs.length - 1) setCurrentIndex((i) => i + 1);
  };

  const doMerge = async (keepId: string, removeId: string) => {
    if (!pairs) return;
    setMerging(true);
    setMergeResult(null);
    try {
      const res = await executeMerge(keepId, removeId);
      setMergeResult(`Merged — ${res.relationships_moved} connection(s) moved.`);
      // Mark original index as resolved
      const originalIndex = pairs.findIndex(
        (p) => (p.paper_a.id === keepId || p.paper_a.id === removeId) &&
                (p.paper_b.id === keepId || p.paper_b.id === removeId)
      );
      if (originalIndex !== -1) {
        setResolved((prev) => new Set([...prev, originalIndex]));
      }
      // advance to next
      setCurrentIndex((i) => Math.min(i, activePairs.length - 2));
    } catch (err) {
      setMergeResult(`Error: ${err instanceof Error ? err.message : "Merge failed"}`);
    } finally {
      setMerging(false);
    }
  };

  const pending = activePairs.length;
  const done = (pairs?.length ?? 0) - pending;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Merge Manager</h1>
        <p className="text-sm text-gray-500 mt-1">
          Scans all papers for near-duplicate titles, then lets you merge them one by one —
          moving all connections to the paper you keep.
        </p>
      </div>

      {/* Scan controls */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-gray-500">Finds duplicates by DOI and title.</span>
          <button
            onClick={runScan}
            disabled={scanning}
            className="ml-auto px-5 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {scanning ? "Scanning…" : "Run scan"}
          </button>
        </div>
        {scanning && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <svg className="animate-spin h-4 w-4 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Comparing {totalPapers > 0 ? totalPapers : "all"} papers…
          </div>
        )}
        {scanError && <p className="text-sm text-red-500">{scanError}</p>}
        {pairs !== null && !scanning && (
          <p className="text-sm text-gray-500">
            Scanned <span className="font-medium text-gray-800">{totalPapers}</span> papers —{" "}
            <span className="font-medium text-violet-700">{pairs.length}</span> potential duplicate pair{pairs.length !== 1 ? "s" : ""} found.
            {done > 0 && <span className="text-green-600 ml-2">{done} resolved.</span>}
          </p>
        )}
      </div>

      {/* Merge editor */}
      {pairs !== null && pending === 0 && (
        <div className="text-center py-16 text-gray-400 text-sm">
          All pairs resolved. Run another scan to check again.
        </div>
      )}

      {currentPair && (
        <div className="space-y-4">
          {/* Progress */}
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>
              Pair {currentIndex + 1} of {pending} remaining
            </span>
            <span className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full font-medium">
              {(currentPair.similarity * 100).toFixed(0)}% similar
            </span>
          </div>

          {/* Reason */}
          <p className="text-sm text-gray-500 italic">{currentPair.reason}</p>

          {mergeResult && (
            <p className={`text-sm font-medium ${mergeResult.startsWith("Error") ? "text-red-500" : "text-green-600"}`}>
              {mergeResult}
            </p>
          )}

          {/* Side-by-side comparison */}
          <div className="grid grid-cols-2 gap-4">
            {([currentPair.paper_a, currentPair.paper_b] as const).map((paper, side) => (
              <div key={paper.id} className="bg-white border border-gray-200 rounded-xl p-5 space-y-3 flex flex-col">
                <div className="space-y-1 flex-1">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    {side === 0 ? "Paper A" : "Paper B"}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 leading-snug">{paper.title}</p>
                  <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                    {paper.year && <span>{paper.year}</span>}
                    {paper.doi && <span className="font-mono">{paper.doi}</span>}
                    {paper.metadata_source && (
                      <span className="bg-gray-100 px-1.5 py-0.5 rounded">{paper.metadata_source}</span>
                    )}
                    {paper.drive_file_id && (
                      <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">has PDF</span>
                    )}
                  </div>
                  {paper.abstract && (
                    <p className="text-xs text-gray-500 line-clamp-4 leading-relaxed">{paper.abstract}</p>
                  )}
                </div>

                <button
                  onClick={() => doMerge(
                    paper.id,
                    side === 0 ? currentPair.paper_b.id : currentPair.paper_a.id
                  )}
                  disabled={merging}
                  className="mt-auto w-full px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  {merging ? "Merging…" : "Keep this one"}
                </button>
              </div>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="text-sm text-gray-400 hover:text-gray-600 disabled:opacity-30 transition-colors"
            >
              ← Previous
            </button>
            <button
              onClick={skip}
              disabled={currentIndex >= pending - 1}
              className="text-sm text-gray-400 hover:text-gray-600 disabled:opacity-30 transition-colors"
            >
              Skip →
            </button>
          </div>
        </div>
      )}

      {/* Pair list overview */}
      {pairs !== null && pairs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">All pairs</p>
          </div>
          <ul className="divide-y divide-gray-50">
            {pairs.map((pair, i) => {
              const isResolved = resolved.has(i);
              const isActive = activePairs[currentIndex] === pair;
              return (
                <li
                  key={i}
                  onClick={() => {
                    if (isResolved) return;
                    const activeIdx = activePairs.indexOf(pair);
                    if (activeIdx !== -1) setCurrentIndex(activeIdx);
                  }}
                  className={`px-5 py-3 flex items-start gap-3 text-sm cursor-pointer transition-colors ${
                    isResolved
                      ? "opacity-40 cursor-default"
                      : isActive
                      ? "bg-violet-50"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <span className={`shrink-0 mt-0.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                    isResolved
                      ? "bg-green-100 text-green-600"
                      : "bg-violet-100 text-violet-700"
                  }`}>
                    {isResolved ? "done" : `${(pair.similarity * 100).toFixed(0)}%`}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-gray-800 truncate font-medium">{pair.paper_a.title}</p>
                    <p className="text-gray-500 truncate">{pair.paper_b.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5 italic">{pair.reason}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
