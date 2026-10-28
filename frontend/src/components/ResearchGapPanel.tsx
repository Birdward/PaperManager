import { useState } from "react";
import { findResearchGaps } from "../api/client";
import ReactMarkdown from "react-markdown";
import { mdPlugins } from "../lib/markdown";
import { CHAT_MODEL } from "../lib/chatModels";

interface Props {
  onClose: () => void;
  projectId?: string;
  paperIds?: string[];
}

export default function ResearchGapPanel({ onClose, projectId, paperIds }: Props) {
  const [topic, setTopic] = useState("");
  const [scope, setScope] = useState<"library" | "project">(projectId ? "project" : "library");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [papersConsidered, setPapersConsidered] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    if (!topic.trim()) {
      setError("Please enter a topic or research question");
      return;
    }

    setLoading(true);
    setError(null);
    setAnalysis(null);

    try {
      const result = await findResearchGaps(
        topic,
        scope === "project" ? projectId : undefined,
        paperIds,
        CHAT_MODEL
      );
      setAnalysis(result.analysis);
      setPapersConsidered(result.papers_considered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze research gaps");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (analysis) {
      navigator.clipboard.writeText(analysis);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-800">Research Gap Finder</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!analysis && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Topic / Research Question
                </label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g., self-supervised learning for medical imaging"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  disabled={loading}
                  onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
                />
              </div>

              {!paperIds && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Scope</label>
                  <div className="flex gap-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        value="library"
                        checked={scope === "library"}
                        onChange={(e) => setScope(e.target.value as "library" | "project")}
                        disabled={loading}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-700">Whole library</span>
                    </label>
                    {projectId && (
                      <label className="flex items-center">
                        <input
                          type="radio"
                          value="project"
                          checked={scope === "project"}
                          onChange={(e) => setScope(e.target.value as "library" | "project")}
                          disabled={loading}
                          className="mr-2"
                        />
                        <span className="text-sm text-gray-700">This project</span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                  {error}
                </div>
              )}

              <button
                onClick={handleAnalyze}
                disabled={loading || !topic.trim()}
                className="w-full bg-violet-600 text-white px-6 py-3 rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {loading ? "Analyzing..." : "Analyze"}
              </button>

              <p className="text-xs text-gray-500 text-center">
                This will search the web and analyze your library to identify research gaps
              </p>
            </div>
          )}

          {loading && !analysis && (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-violet-600 mb-4"></div>
              <p className="text-gray-600">
                Analyzing papers + searching the web...
              </p>
            </div>
          )}

          {analysis && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 px-4 py-3 rounded-lg">
                <p className="text-sm text-blue-800">
                  Analysis based on {papersConsidered} paper{papersConsidered !== 1 ? "s" : ""} in your library
                </p>
              </div>

              <div className="prose prose-sm max-w-none">
                <ReactMarkdown {...mdPlugins}>{analysis}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {analysis && (
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
            <button
              onClick={handleCopy}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Copy
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
