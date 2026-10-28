import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  getBlogPost,
  updateBlogPost,
  importBlogPost,
  summarizeBlogPost,
  chatWithBlogPost,
  getBlogPostNote,
  saveBlogPostNote,
  getBlogPostTags,
  addBlogPostTag,
  removeBlogPostTag,
  getBlogPostPeople,
  linkPersonToBlogPost,
  unlinkPersonFromBlogPost,
  getBlogPostProjects,
  addBlogPostToProject,
  removeBlogPostFromProject,
} from "../api/client";
import { listProjects } from "../api/client";
import type { BlogPost, ChatMessage, Project } from "../types";

type LeftTab  = "original" | "content" | "figures" | "references" | "summary";
type RightTab = "notes" | "chat" | "connections";

const STATUS_OPTIONS = ["unread", "reading", "read"] as const;
const STATUS_COLORS: Record<string, string> = {
  unread:  "bg-blue-100 text-blue-700",
  reading: "bg-amber-100 text-amber-700",
  read:    "bg-green-100 text-green-700",
};

export default function BlogPostDetail() {
  const { postId } = useParams<{ postId: string }>();
  const navigate   = useNavigate();

  const [post, setPost]           = useState<BlogPost | null>(null);
  const [leftTab, setLeftTab]     = useState<LeftTab>("original");
  const [rightTab, setRightTab]   = useState<RightTab>("notes");
  const [loading, setLoading]     = useState(true);
  const [importing, setImporting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  // Notes
  const [note, setNote]           = useState("");
  const [noteLoaded, setNoteLoaded] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved]   = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chat
  const [question, setQuestion]     = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Connections (tags / people / projects)
  const [tags, setTags]       = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople]   = useState<{ id: string; name: string; role: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);

  const [newTag, setNewTag]         = useState("");
  const [newPerson, setNewPerson]   = useState("");
  const [newPersonRole, setNewPersonRole] = useState("author");
  const [addingTag, setAddingTag]   = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);

  useEffect(() => {
    if (!postId) return;
    setLoading(true);
    getBlogPost(postId)
      .then(p => {
        setPost(p);
        if (p.reading_status === "unread") {
          updateBlogPost(postId, { reading_status: "reading" })
            .then(updated => setPost(updated))
            .catch(() => {});
        }
      })
      .catch(() => navigate("/blogs"))
      .finally(() => setLoading(false));
  }, [postId, navigate]);

  useEffect(() => {
    if (rightTab !== "notes" || !postId || noteLoaded) return;
    getBlogPostNote(postId)
      .then(n => setNote(n.content))
      .catch(() => setNote(""))
      .finally(() => setNoteLoaded(true));
  }, [rightTab, postId, noteLoaded]);

  useEffect(() => {
    if (rightTab !== "connections" || !postId || connectionsLoaded) return;
    Promise.all([
      getBlogPostTags(postId),
      getBlogPostPeople(postId),
      getBlogPostProjects(postId),
      listProjects(),
    ]).then(([t, p, pr, all]) => {
      setTags(t);
      setPeople(p);
      setProjects(pr);
      setAllProjects(all);
      setConnectionsLoaded(true);
    }).catch(() => setConnectionsLoaded(true));
  }, [rightTab, postId, connectionsLoaded]);

  const handleImport = async () => {
    if (!postId) return;
    setImporting(true);
    try {
      const result = await importBlogPost(postId);
      if (result.imported) setPost(await getBlogPost(postId));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleSummarize = async () => {
    if (!postId) return;
    setSummarizing(true);
    try {
      const result = await summarizeBlogPost(postId);
      setPost(prev => prev ? { ...prev, summary: result.summary } : prev);
      setLeftTab("summary");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Summarization failed");
    } finally {
      setSummarizing(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    if (!postId) return;
    setPost(await updateBlogPost(postId, { reading_status: status }));
  };

  const handleNoteChange = (val: string) => {
    setNote(val);
    setNoteSaved(false);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(async () => {
      if (!postId) return;
      setSavingNote(true);
      try { await saveBlogPostNote(postId, val); setNoteSaved(true); }
      finally { setSavingNote(false); }
    }, 800);
  };

  const handleChat = async () => {
    if (!question.trim() || !postId) return;
    const q = question.trim();
    setQuestion("");
    const userMsg: ChatMessage = { role: "user", content: q };
    setChatHistory(h => [...h, userMsg]);
    setChatLoading(true);
    try {
      const resp = await chatWithBlogPost(postId, q, [...chatHistory, userMsg]);
      setChatHistory(h => [...h, { role: "assistant", content: resp.answer }]);
    } catch (e: unknown) {
      setChatHistory(h => [...h, { role: "assistant", content: `Error: ${e instanceof Error ? e.message : "Chat failed"}` }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const handleAddTag = async () => {
    if (!newTag.trim() || !postId) return;
    setAddingTag(true);
    try {
      const tag = await addBlogPostTag(postId, newTag.trim());
      setTags(prev => [...prev.filter(t => t.id !== tag.id), tag]);
      setNewTag("");
    } catch { /* ignore */ }
    finally { setAddingTag(false); }
  };

  const handleRemoveTag = async (tagName: string) => {
    if (!postId) return;
    await removeBlogPostTag(postId, tagName);
    setTags(prev => prev.filter(t => t.name !== tagName));
  };

  const handleAddPerson = async () => {
    if (!newPerson.trim() || !postId) return;
    setAddingPerson(true);
    try {
      const p = await linkPersonToBlogPost(postId, newPerson.trim(), newPersonRole);
      setPeople(prev => [...prev.filter(x => x.id !== p.id), { ...p, role: newPersonRole }]);
      setNewPerson("");
    } catch { /* ignore */ }
    finally { setAddingPerson(false); }
  };

  const handleRemovePerson = async (personId: string) => {
    if (!postId) return;
    await unlinkPersonFromBlogPost(postId, personId);
    setPeople(prev => prev.filter(p => p.id !== personId));
  };

  const handleAddToProject = async (projectId: string) => {
    if (!postId) return;
    await addBlogPostToProject(postId, projectId);
    const proj = allProjects.find(p => p.id === projectId);
    if (proj) setProjects(prev => [...prev.filter(p => p.id !== projectId), { id: proj.id, name: proj.name }]);
  };

  const handleRemoveFromProject = async (projectId: string) => {
    if (!postId) return;
    await removeBlogPostFromProject(postId, projectId);
    setProjects(prev => prev.filter(p => p.id !== projectId));
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>
  );
  if (!post) return null;

  const pubDate = post.published_at
    ? new Date(post.published_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "";

  const references: { title: string; url: string }[] = (() => {
    try { return post.references_json ? JSON.parse(post.references_json) : []; }
    catch { return []; }
  })();

  const figures = post.figures ?? [];

  const contentToShow = post.content_md?.trim() ? post.content_md : post.content ?? "";

  const mdPlugins = { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
              <Link to="/blogs" className="hover:text-violet-600">Blogs</Link>
              <span>/</span>
              {post.blog_name && <span className="text-gray-500">{post.blog_name}</span>}
            </div>
            <h1 className="text-lg font-semibold text-gray-900 leading-snug">{post.title}</h1>
            <div className="flex items-center gap-3 mt-1">
              {post.author && <span className="text-xs text-gray-500">{post.author}</span>}
              {pubDate && <span className="text-xs text-gray-400">{pubDate}</span>}
              <a href={post.url} target="_blank" rel="noopener noreferrer"
                className="text-xs text-violet-600 hover:underline">
                Open original ↗
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              value={post.reading_status}
              onChange={e => handleStatusChange(e.target.value)}
              className={`text-xs font-medium px-2 py-1 rounded cursor-pointer focus:outline-none ${STATUS_COLORS[post.reading_status]}`}
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <button onClick={handleImport} disabled={importing}
              className="px-3 py-1.5 text-xs font-medium rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
              {importing ? "Importing…" : post.imported ? "Re-import" : "Import"}
            </button>

            {post.imported && (
              <button onClick={handleSummarize} disabled={summarizing}
                className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition-colors">
                {summarizing ? "Summarizing…" : post.summary ? "Re-summarize" : "AI Summary"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Two-panel body ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* LEFT PANEL */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
          {/* Left tabs */}
          <div className="flex gap-0 border-b border-gray-200 bg-white shrink-0 px-4">
            {(["original", "content", "figures", "references", "summary"] as LeftTab[]).map(t => (
              <button key={t} onClick={() => setLeftTab(t)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize whitespace-nowrap ${
                  leftTab === t
                    ? "border-violet-500 text-violet-700"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}>
                {t}
                {t === "figures" && figures.length > 0 && (
                  <span className="ml-1 text-xs text-gray-400">({figures.length})</span>
                )}
                {t === "references" && references.length > 0 && (
                  <span className="ml-1 text-xs text-gray-400">({references.length})</span>
                )}
                {t === "summary" && post.summary && (
                  <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-violet-400 align-middle" />
                )}
              </button>
            ))}
          </div>

          {/* Left content */}
          <div className="flex-1 min-h-0 overflow-hidden">

            {/* Original — iframe */}
            {leftTab === "original" && (
              <iframe
                src={post.url}
                title={post.title}
                className="w-full h-full border-0"
                sandbox="allow-scripts allow-same-origin allow-popups"
              />
            )}

            {/* Content — rendered markdown with LaTeX */}
            {leftTab === "content" && (
              <div className="h-full overflow-y-auto p-6">
                {!post.imported ? (
                  <NotImportedPrompt importing={importing} onImport={handleImport} />
                ) : (
                  <div className="max-w-3xl mx-auto bg-white rounded-xl border border-gray-200 p-8">
                    {post.content_md?.trim() && (
                      <p className="text-xs text-violet-500 mb-4 font-medium">
                        Formatted by Claude
                      </p>
                    )}
                    <div className="prose prose-sm prose-gray max-w-none">
                      <ReactMarkdown {...mdPlugins}>{contentToShow}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Figures */}
            {leftTab === "figures" && (
              <div className="h-full overflow-y-auto p-6">
                {!post.imported ? (
                  <NotImportedPrompt importing={importing} onImport={handleImport} />
                ) : figures.length === 0 ? (
                  <p className="text-sm text-gray-400">No figures found in this post.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-4 max-w-4xl mx-auto">
                    {figures.map((url, i) => (
                      <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <img
                          src={url}
                          alt={`Figure ${i + 1}`}
                          className="w-full object-contain max-h-64"
                          onError={e => (e.currentTarget.style.display = "none")}
                        />
                        <div className="px-3 py-2 border-t border-gray-100">
                          <p className="text-xs text-gray-400 truncate">Figure {i + 1}</p>
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-violet-600 hover:underline truncate block">
                            {url}
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* References */}
            {leftTab === "references" && (
              <div className="h-full overflow-y-auto p-6">
                {!post.imported ? (
                  <NotImportedPrompt importing={importing} onImport={handleImport} />
                ) : references.length === 0 ? (
                  <p className="text-sm text-gray-400">No references found in this post.</p>
                ) : (
                  <div className="max-w-2xl mx-auto space-y-2">
                    {references.map((ref, i) => (
                      <div key={i} className="bg-white rounded-lg border border-gray-200 px-4 py-3">
                        <a href={ref.url} target="_blank" rel="noopener noreferrer"
                          className="text-sm text-violet-700 hover:underline font-medium">
                          {ref.title}
                        </a>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{ref.url}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            {leftTab === "summary" && (
              <div className="h-full overflow-y-auto p-6">
                {!post.summary ? (
                  <div className="text-center py-16 text-gray-400">
                    <p className="text-sm mb-3">No summary yet.</p>
                    {post.imported && (
                      <button onClick={handleSummarize} disabled={summarizing}
                        className="px-4 py-2 text-sm font-medium rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors">
                        {summarizing ? "Summarizing…" : "Generate AI Summary"}
                      </button>
                    )}
                    {!post.imported && (
                      <p className="text-xs mt-2">Import the post first, then generate a summary.</p>
                    )}
                  </div>
                ) : (
                  <div className="max-w-2xl mx-auto bg-white rounded-xl border border-gray-200 p-6">
                    <div className="prose prose-sm prose-gray max-w-none">
                      <ReactMarkdown {...mdPlugins}>{post.summary}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="flex flex-col w-96 shrink-0 bg-white">
          {/* Right tabs */}
          <div className="flex border-b border-gray-200 shrink-0 px-4">
            {(["notes", "chat", "connections"] as RightTab[]).map(t => (
              <button key={t} onClick={() => setRightTab(t)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                  rightTab === t
                    ? "border-violet-500 text-violet-700"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}>
                {t}
              </button>
            ))}
          </div>

          {/* Notes */}
          {rightTab === "notes" && (
            <div className="flex-1 flex flex-col p-4 min-h-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-600">Notes</span>
                <span className="text-xs text-gray-400">
                  {savingNote ? "Saving…" : noteSaved ? "Saved ✓" : ""}
                </span>
              </div>
              <textarea
                value={note}
                onChange={e => handleNoteChange(e.target.value)}
                placeholder="Write your notes here… markdown supported"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400"
              />
            </div>
          )}

          {/* Chat */}
          {rightTab === "chat" && (
            <div className="flex flex-col flex-1 min-h-0 p-4">
              {!post.imported ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-xs text-center px-4">
                  Import the post first to enable chat.
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0">
                    {chatHistory.length === 0 && (
                      <p className="text-xs text-gray-400 text-center pt-6">
                        Ask anything about this post.
                      </p>
                    )}
                    {chatHistory.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
                          msg.role === "user"
                            ? "bg-violet-600 text-white"
                            : "bg-gray-100 text-gray-800"
                        }`}>
                          <pre className="whitespace-pre-wrap font-sans leading-relaxed text-xs">{msg.content}</pre>
                        </div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="bg-gray-100 rounded-xl px-3 py-2 text-xs text-gray-400 animate-pulse">
                          Thinking…
                        </div>
                      </div>
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  <div className="flex gap-2 shrink-0">
                    <input
                      value={question}
                      onChange={e => setQuestion(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleChat()}
                      placeholder="Ask about this post…"
                      disabled={chatLoading}
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-400 disabled:opacity-50"
                    />
                    <button
                      onClick={handleChat}
                      disabled={chatLoading || !question.trim()}
                      className="px-3 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 transition-colors"
                    >
                      →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Connections */}
          {rightTab === "connections" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-6">

              {/* Tags */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Tags</h3>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map(tag => (
                    <span key={tag.id} className="flex items-center gap-1 bg-violet-50 text-violet-700 text-xs px-2 py-0.5 rounded-full">
                      {tag.name}
                      <button onClick={() => handleRemoveTag(tag.name)} className="hover:text-red-500 leading-none">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input
                    value={newTag}
                    onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAddTag()}
                    placeholder="Add tag…"
                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-400"
                  />
                  <button onClick={handleAddTag} disabled={addingTag || !newTag.trim()}
                    className="text-xs px-2 py-1 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
                    Add
                  </button>
                </div>
              </section>

              {/* People */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">People</h3>
                <div className="space-y-1 mb-2">
                  {people.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1">
                      <span className="font-medium text-gray-700">{p.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400">{p.role}</span>
                        <button onClick={() => handleRemovePerson(p.id)} className="text-gray-300 hover:text-red-500">×</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 mb-1">
                  <input
                    value={newPerson}
                    onChange={e => setNewPerson(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAddPerson()}
                    placeholder="Person name…"
                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-400"
                  />
                  <select
                    value={newPersonRole}
                    onChange={e => setNewPersonRole(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-1 py-1 focus:outline-none">
                    <option value="author">author</option>
                    <option value="contributor">contributor</option>
                    <option value="reviewer">reviewer</option>
                  </select>
                  <button onClick={handleAddPerson} disabled={addingPerson || !newPerson.trim()}
                    className="text-xs px-2 py-1 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
                    Add
                  </button>
                </div>
              </section>

              {/* Projects */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Projects</h3>
                <div className="space-y-1 mb-2">
                  {projects.map(pr => (
                    <div key={pr.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1">
                      <span className="font-medium text-gray-700">{pr.name}</span>
                      <button onClick={() => handleRemoveFromProject(pr.id)} className="text-gray-300 hover:text-red-500">×</button>
                    </div>
                  ))}
                </div>
                {allProjects.filter(p => !projects.find(x => x.id === p.id)).length > 0 && (
                  <select
                    defaultValue=""
                    onChange={e => e.target.value && handleAddToProject(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-400">
                    <option value="" disabled>Add to project…</option>
                    {allProjects
                      .filter(p => !projects.find(x => x.id === p.id))
                      .map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                  </select>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotImportedPrompt({ importing, onImport }: { importing: boolean; onImport: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-gray-400 py-16">
      <p className="text-sm mb-3">Content not imported yet.</p>
      <button
        onClick={onImport}
        disabled={importing}
        className="px-4 py-2 text-sm font-medium rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
      >
        {importing ? "Importing…" : "Import content"}
      </button>
    </div>
  );
}
