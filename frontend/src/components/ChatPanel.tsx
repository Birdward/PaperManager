import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { mdPlugins } from "../lib/markdown";
import {
  listPaperConversations, getPaperConversationMessages,
  renamePaperConversation, compactPaperConversation,
  deletePaperConversation, chatWithPaper, type PaperChatCoverage, type PaperChatContext,
} from "../api/client";
import type { Conversation, KnowledgeMessage } from "../types";
import { CHAT_MODEL_LABELS, useChatModels, type ChatModel } from "../lib/chatModels";

type Model = ChatModel;
const MODEL_LABELS = CHAT_MODEL_LABELS;


interface Props {
  paperId: string;
}

export default function ChatPanel({ paperId }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId]   = useState<string | null>(null);
  const [messages, setMessages]           = useState<KnowledgeMessage[]>([]);
  // Pages each fresh answer could see, by answer text (a new conversation reloads its messages
  // from the server with new ids); shown when a long paper was read in part.
  const [coverage, setCoverage]           = useState<Record<string, PaperChatCoverage>>({});
  // Size of the last request in each conversation, as reported by Claude (paper + notes + chat).
  const [sentByConv, setSentByConv]       = useState<Record<string, PaperChatContext>>({});
  const [input, setInput]                 = useState("");
  const [loading, setLoading]             = useState(false);
  const [loadingMsgs, setLoadingMsgs]     = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [model, setModel]                 = useState<Model>("litellm");
  const models = useChatModels();

  // Title editing
  const [editingTitle, setEditingTitle]   = useState(false);
  const [titleDraft, setTitleDraft]       = useState("");

  // Compact
  const [compacting, setCompacting]       = useState(false);

  // Saved-to-note feedback
  const [savedMsgIdx, setSavedMsgIdx]     = useState<number | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);

  // Load conversation list
  useEffect(() => {
    listPaperConversations(paperId)
      .then(setConversations)
      .catch(() => {});
  }, [paperId]);

  // Load messages when active conversation changes
  useEffect(() => {
    if (!activeConvId) { setMessages([]); return; }
    setLoadingMsgs(true);
    getPaperConversationMessages(paperId, activeConvId)
      .then(setMessages)
      .catch(() => setMessages([]))
      .finally(() => setLoadingMsgs(false));
  }, [activeConvId, paperId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  const send = async () => {
    const question = input.trim();
    if (!question || loading) return;
    setInput("");
    setError(null);

    // Optimistic append
    const userMsg: KnowledgeMessage = {
      id: `tmp-${Date.now()}`, role: "user", content: question,
      created_at: new Date().toISOString(), paper_refs: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const history = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await chatWithPaper(paperId, question, history, model, activeConvId ?? undefined);

      const assistantMsg: KnowledgeMessage = {
        id: `tmp-a-${Date.now()}`, role: "assistant", content: res.answer,
        created_at: new Date().toISOString(), paper_refs: [],
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (res.coverage) setCoverage((prev) => ({ ...prev, [res.answer]: res.coverage! }));
      const convId = activeConvId ?? res.conversation_id;
      if (res.context && convId) setSentByConv((prev) => ({ ...prev, [convId]: res.context! }));

      // If this was a new conversation, update the list
      if (!activeConvId && res.conversation_id) {
        setActiveConvId(res.conversation_id);
        const newConv: Conversation = {
          id: res.conversation_id,
          title: question.slice(0, 60) + (question.length > 60 ? "…" : ""),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          compacted: false,
          message_count: 2,
        };
        setConversations((prev) => [newConv, ...prev]);
      } else if (activeConvId) {
        setConversations((prev) =>
          prev.map((c) => c.id === activeConvId
            ? { ...c, message_count: c.message_count + 2, updated_at: new Date().toISOString() }
            : c
          )
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat failed");
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const saveToNote = async (content: string, idx: number) => {
    try {
      const note = await (await fetch(
        `${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/papers/${paperId}/note`,
        { credentials: "include" }
      )).json() as { content: string };
      const append = `\n\n---\n**Claude (${new Date().toLocaleDateString()}):**\n\n${content}`;
      await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:8000"}/papers/${paperId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: (note.content ?? "") + append }),
      });
      setSavedMsgIdx(idx);
      setTimeout(() => setSavedMsgIdx(null), 2000);
    } catch { /* silent */ }
  };

  const handleCompact = async () => {
    if (!activeConvId || compacting) return;
    setCompacting(true);
    try {
      await compactPaperConversation(paperId, activeConvId);
      // Reload messages
      const msgs = await getPaperConversationMessages(paperId, activeConvId);
      setMessages(msgs);
      setConversations((prev) =>
        prev.map((c) => c.id === activeConvId ? { ...c, compacted: true } : c)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compact failed");
    } finally {
      setCompacting(false);
    }
  };

  const handleRename = async () => {
    if (!activeConvId || !titleDraft.trim()) return;
    await renamePaperConversation(paperId, activeConvId, titleDraft.trim());
    setConversations((prev) =>
      prev.map((c) => c.id === activeConvId ? { ...c, title: titleDraft.trim() } : c)
    );
    setEditingTitle(false);
  };

  const handleDeleteConv = async (convId: string) => {
    await deletePaperConversation(paperId, convId);
    setConversations((prev) => prev.filter((c) => c.id !== convId));
    if (activeConvId === convId) { setActiveConvId(null); setMessages([]); }
  };

  // ── Conversation list view ─────────────────────────────────────────────────
  if (!activeConvId) {
    return (
      <div className="flex flex-col h-full gap-3">
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-gray-700">Chat</h2>
          <button
            onClick={() => { setActiveConvId(null); setMessages([]); inputRef.current?.focus(); }}
            className="text-xs bg-violet-600 text-white px-3 py-1 rounded-lg hover:bg-violet-700 font-medium"
            onClick={() => {
              // Start new conversation inline — clear activeConvId so send() creates one
              setMessages([]);
              setActiveConvId(null);
              setEditingTitle(false);
              // Jump straight to input
              setTimeout(() => inputRef.current?.focus(), 50);
            }}
          >
            + New chat
          </button>
        </div>

        {conversations.length === 0 ? (
          <p className="text-xs text-gray-400 text-center mt-6">No conversations yet.<br/>Ask your first question below.</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
            {conversations.map((c) => (
              <div
                key={c.id}
                className="group flex items-start gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2.5 hover:border-violet-200 transition-colors cursor-pointer"
                onClick={() => setActiveConvId(c.id)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-800 truncate">{c.title}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {c.started_by && <span className="font-medium text-violet-500">{c.started_by} · </span>}
                    {c.message_count} message{c.message_count !== 1 ? "s" : ""}
                    {c.compacted && " · compacted"}
                    {" · "}{new Date(c.updated_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteConv(c.id); }}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 text-sm leading-none transition-all"
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Input for new conversation */}
        <div className="flex flex-col gap-1.5 shrink-0">
          <div className="flex rounded border border-gray-200 overflow-hidden text-[10px] self-start">
            {models.map((m) => (
              <button key={m} onClick={() => setModel(m)}
                className={`px-1.5 py-0.5 transition-colors ${model === m ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>
                {MODEL_LABELS[m]}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={loading}
              placeholder="Ask a new question…"
              className="flex-1 border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 disabled:opacity-50"
            />
            <button onClick={send} disabled={loading || !input.trim()}
              className="px-3 py-1.5 bg-violet-600 text-white text-sm rounded hover:bg-violet-700 disabled:opacity-50">
              Ask
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Context bar helpers ───────────────────────────────────────────────────
  const estimatedTokens = messages
    .filter((m) => m.role !== "system")
    .reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);

  // The real size of the last request when Claude reported it; otherwise only the messages are known.
  const sent = activeConvId ? sentByConv[activeConvId] : undefined;
  const contextPercent = sent?.window ? Math.min(100, Math.round((sent.tokens / sent.window) * 1000) / 10) : null;
  const contextColor =
    (contextPercent ?? 0) >= 75 ? "bg-red-400" : (contextPercent ?? 0) >= 45 ? "bg-amber-400" : "bg-violet-400";

  const fmtTokens = (n: number) =>
    n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  // ── Active conversation view ───────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full gap-2">
      {/* Header */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { setActiveConvId(null); setEditingTitle(false); }}
          className="text-gray-400 hover:text-gray-600 text-xs shrink-0"
          title="Back to conversation list"
        >
          ← Back
        </button>

        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditingTitle(false); }}
            onBlur={handleRename}
            className="flex-1 text-xs border border-violet-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-violet-300"
          />
        ) : (
          <p
            className="flex-1 text-xs font-medium text-gray-700 truncate cursor-pointer hover:text-violet-600 transition-colors"
            title="Click to rename"
            onClick={() => { setTitleDraft(activeConv?.title ?? ""); setEditingTitle(true); }}
          >
            {activeConv?.title ?? "Chat"}
            <span className="text-gray-300 ml-1 text-[10px]">✎</span>
          </p>
        )}

        <div className="flex items-center gap-1 shrink-0">
          <div className="flex rounded border border-gray-200 overflow-hidden text-[10px]">
            {models.map((m) => (
              <button key={m} onClick={() => setModel(m)}
                className={`px-1.5 py-0.5 transition-colors ${model === m ? "bg-violet-600 text-white" : "text-gray-500 hover:bg-gray-50"}`}>
                {MODEL_LABELS[m]}
              </button>
            ))}
          </div>
          <button
            onClick={handleCompact}
            disabled={compacting || messages.length < 4}
            title="Summarise this conversation to save context space"
            className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 transition-colors"
          >
            {compacting ? "…" : "Compact"}
          </button>
        </div>
      </div>

      {/* Context bar */}
      {messages.length > 0 && (
        <div className="shrink-0 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-[10px] text-gray-500 space-y-1">
          <div className="flex items-center justify-between">
            <span>
              Context:{" "}
              {sent ? (
                <span className="font-medium text-gray-700">
                  {fmtTokens(sent.tokens)}{sent.window ? ` / ${fmtTokens(sent.window)}` : ""} tokens
                </span>
              ) : (
                <span className="font-medium text-gray-700">≈{fmtTokens(estimatedTokens)} tokens of messages</span>
              )}
              {" · "}{messages.filter((m) => m.role !== "system").length} messages
              {sent?.model && <span>{" · "}{sent.model}</span>}
              {activeConv?.compacted && <span className="ml-1 text-amber-600 font-medium">· compacted</span>}
            </span>
            {contextPercent !== null && <span className="text-[9px] text-gray-400">{contextPercent}%</span>}
          </div>
          {contextPercent !== null && (
            <div className="h-1 w-full rounded-full bg-gray-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${contextColor}`}
                style={{ width: `${Math.max(contextPercent, 0.5)}%` }}
              />
            </div>
          )}
          <p className="text-[9px] text-gray-400">
            {sent
              ? "The last question as sent to Claude: the paper, your notes and highlights, and this conversation"
              : "The paper and your notes are sent too; the full size shows after the next answer"}
          </p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {loadingMsgs ? (
          <p className="text-xs text-gray-400 text-center mt-4">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-gray-400 text-center mt-4">Ask a question about this paper.</p>
        ) : (
          messages.map((msg, i) => (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "system" ? (
                <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  <span className="font-semibold text-amber-800">Compacted summary</span>
                  <div className="mt-1 prose prose-xs max-w-none overflow-x-auto">
                    <ReactMarkdown {...mdPlugins}>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm relative group ${
                  msg.role === "user"
                    ? "bg-violet-600 text-white"
                    : "bg-white border border-gray-200 text-gray-800"
                }`}>
                  {msg.role === "assistant" ? (
                    <>
                      <div className="prose prose-sm max-w-none overflow-x-auto">
                        <ReactMarkdown {...mdPlugins}>{msg.content}</ReactMarkdown>
                      </div>
                      {coverage[msg.content] && !coverage[msg.content].complete && (
                        <p className="mt-1.5 text-[10px] leading-snug text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-1"
                          title="Long documents are given to the chat in part; it reads further pages when it needs them.">
                          ⚠ Long paper: this answer used PDF pages {coverage[msg.content].pages_read} of {coverage[msg.content].total_pages}.
                          {" "}Ask about a specific chapter or page range to cover other parts.
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => navigator.clipboard.writeText(msg.content)}
                          className="text-[10px] text-gray-400 hover:text-gray-600">
                          ⎘ Copy
                        </button>
                        <span className="text-gray-200">·</span>
                        <button onClick={() => saveToNote(msg.content, i)}
                          className={`text-[10px] transition-colors ${savedMsgIdx === i ? "text-green-600" : "text-gray-400 hover:text-violet-600"}`}>
                          {savedMsgIdx === i ? "✓ Saved to note" : "📌 Save to note"}
                        </button>
                      </div>
                    </>
                  ) : msg.content}
                </div>
              )}
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
              {MODEL_LABELS[model]} is thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="text-xs text-red-500 shrink-0">{error}</p>}

      <div className="flex gap-2 shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={loading}
          placeholder="Ask a follow-up…"
          className="flex-1 border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 disabled:opacity-50"
        />
        <button onClick={send} disabled={loading || !input.trim()}
          className="px-3 py-1.5 bg-violet-600 text-white text-sm rounded hover:bg-violet-700 disabled:opacity-50">
          Ask
        </button>
      </div>
    </div>
  );
}
