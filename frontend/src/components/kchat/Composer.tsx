// Modelled on the thesis desk's Composer: one shell holding attachments, the text and a control bar.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** Scope mentions as the backend parses them (routers/knowledge_chat.py `_MENTION_RE`), plus @user. */
const MENTION = /@(project|tag|topic|paper|blog|person|user):(?:"([^"]+)"|'([^']+)'|([^\s@,]+))/gi;

export type Mention = { type: string; value: string; raw: string };
export function parseMentions(text: string): Mention[] {
  return [...text.matchAll(MENTION)].map((m) => ({ type: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4], raw: m[0] }));
}

/** How a value is written into the text: quoted when it holds a space, comma, colon or @. */
export const mentionText = (type: string, value: string) =>
  `@${type}:${/[\s,:@]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value}`;

export type Entities = {
  tags: string[]; topics: string[]; projects: string[]; people: string[]; users: string[];
  papers: { id: string; title: string; year?: number | null }[];
};
export type AttachedPaper = { id: string; title: string; year?: number | null };

type Option = { type: string; value: string; label: string; paper?: AttachedPaper };

function suggestions(before: string, e: Entities): Option[] {
  const m = before.match(/@(project|tag|topic|paper|user|person)?:?([\w-]*)$/i);
  if (!m) return [];
  const type = m[1]?.toLowerCase();
  const p = m[2].toLowerCase();
  const out: Option[] = [];
  const add = (t: string, list: string[], n: number) => {
    if (type && type !== t) return;
    list.filter((x) => x.toLowerCase().includes(p)).slice(0, n).forEach((x) => out.push({ type: t, value: x, label: x }));
  };
  add("project", e.projects, 5);
  add("topic", e.topics, 5);
  add("tag", e.tags, 5);
  add("person", e.people, 4);
  add("user", e.users, 3);
  if (!type || type === "paper") {
    e.papers.filter((x) => x.title.toLowerCase().includes(p)).slice(0, 4)
      .forEach((x) => out.push({ type: "paper", value: x.title, label: x.title, paper: x }));
  }
  return out.slice(0, 8);
}

const SCOPE_HINT: Record<string, string> = {
  project: "papers in the project", topic: "papers about the topic", tag: "papers with the tag",
  paper: "papers whose title matches", person: "papers by the person", user: "asks a teammate's chats", blog: "blog posts",
};

type Props = {
  entities: Entities;
  attached: AttachedPaper[];
  onAttach: (p: AttachedPaper) => void;
  onDetach: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  running: boolean;
  useWeb: boolean; onUseWeb: (v: boolean) => void;
  autoConcepts: boolean; onAutoConcepts: (v: boolean) => void;
  /** Text put into the box from outside (an edited question, a starter); `n` changes per use. */
  draft?: { text: string; n: number };
};

export function Composer(p: Props) {
  const [text, setText] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [active, setActive] = useState(0);
  const [picker, setPicker] = useState(false);
  const [pq, setPq] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!p.draft) return;
    setText(p.draft.text);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.draft?.n]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text]);

  const onChange = (val: string) => {
    setText(val);
    const cursor = ta.current?.selectionStart ?? val.length;
    setOptions(suggestions(val.slice(0, cursor), p.entities));
    setActive(0);
  };

  const choose = (o: Option) => {
    const cursor = ta.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursor).replace(/@[\w:-]*$/, "");
    if (o.paper) {
      // A paper picked from the list is attached by id rather than matched by title.
      p.onAttach(o.paper);
      setText(before + text.slice(cursor));
    } else {
      setText(`${before}${mentionText(o.type, o.value)} ${text.slice(cursor)}`);
    }
    setOptions([]);
    requestAnimationFrame(() => ta.current?.focus());
  };

  const send = () => {
    const t = text.trim();
    if (!t || p.running) return;
    p.onSend(t);
    setText("");
    setOptions([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(options[active]); return; }
      if (e.key === "Escape") { setOptions([]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const mentions = parseMentions(text);
  const removeMention = (m: Mention) => setText((t) => t.replace(m.raw, "").replace(/\s{2,}/g, " ").trimStart());
  const pickerList = pq.trim()
    ? p.entities.papers.filter((x) => x.title.toLowerCase().includes(pq.toLowerCase()) && !p.attached.some((a) => a.id === x.id)).slice(0, 8)
    : [];

  return (
    <div className="kc-composer">
      <div className="kc-composer-shell">
        {(mentions.length > 0 || p.attached.length > 0) && (
          <div className="kc-chips">
            {mentions.map((m, i) => (
              <span key={`m${i}`} className={`kc-chip scope k-${m.type}`} title={SCOPE_HINT[m.type]}>
                <b>{m.type}</b>{m.value}
                <button type="button" onClick={() => removeMention(m)} aria-label="Remove scope">×</button>
              </span>
            ))}
            {p.attached.map((a) => (
              <span key={a.id} className="kc-chip paper" title="Attached library paper: always in context">
                {a.title}{a.year ? ` · ${a.year}` : ""}
                <button type="button" onClick={() => p.onDetach(a.id)} aria-label="Detach paper">×</button>
              </span>
            ))}
          </div>
        )}
        <div className="kc-input">
          <textarea ref={ta} value={text} rows={2} onKeyDown={onKey} onChange={(e) => onChange(e.target.value)}
            placeholder="Ask your library…  @project: @topic: @tag: @paper: @person: @user: to scope"
            aria-label="Question" />
          {options.length > 0 && (
            <div className="kc-suggest" role="listbox">
              {options.map((o, i) => (
                <button type="button" key={`${o.type}:${o.value}`} className={i === active ? "on" : ""}
                  onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
                  <span className={`kc-suggest-type k-${o.type}`}>{o.paper ? "attach" : o.type}</span>
                  <span className="kc-suggest-label">{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {picker && (
          <div className="kc-picker">
            <input autoFocus type="search" value={pq} placeholder="Find a library paper to attach" aria-label="Find a paper"
              onChange={(e) => setPq(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setPicker(false); }} />
            {pickerList.map((x) => (
              <button type="button" key={x.id} onClick={() => { p.onAttach(x); setPq(""); setPicker(false); ta.current?.focus(); }}>
                <span className="kc-suggest-label">{x.title}</span>{x.year && <span className="kc-muted"> {x.year}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="kc-composer-bar">
          <button type="button" className={`kc-mini ${picker ? "on" : ""}`} title="Attach a paper from the library" onClick={() => { setPicker((v) => !v); setPq(""); }}>+ paper</button>
          <button type="button" className={`kc-mini ${p.useWeb ? "on" : ""}`} title={p.useWeb ? "Web search on" : "Web search off"} onClick={() => p.onUseWeb(!p.useWeb)}>web</button>
          <button type="button" className={`kc-mini ${p.autoConcepts ? "on" : ""}`}
            title={p.autoConcepts ? "Concept cards are made for every answer" : "Concept cards only when you press Visualise"}
            onClick={() => p.onAutoConcepts(!p.autoConcepts)}>concepts{p.autoConcepts ? " · auto" : ""}</button>
          <span className="kc-spacer" />
          <span className="kc-hint">Enter to send · Shift+Enter for a newline</span>
          {p.running
            ? <button type="button" className="kc-send stop" onClick={p.onStop}>■ Stop</button>
            : <button type="button" className="kc-send" onClick={send} disabled={!text.trim()}>Send</button>}
        </div>
      </div>
    </div>
  );
}
