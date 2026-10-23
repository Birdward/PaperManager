// Ported from the thesis desk's Markdown renderer (KaTeX, GFM, highlighted code,
// ```concept and ```structure cards), with library links instead of repository paths.
import { createContext, lazy, memo, Suspense, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { apiUrl } from "../../api/client";
import ConceptBlock from "./ConceptBlock";
import { PAPER_LINK } from "./sections";

// 3Dmol and the viewer code load only when an answer holds a structure.
const StructureBlock = lazy(() => import("./structure/StructureBlock"));

/**
 * Models often write display maths as \[ ... \] and inline as \( ... \);
 * remark-math only understands $ delimiters, so normalise first.
 */
export function normaliseMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n$$\n${body}\n$$\n`)
    .replace(/\\\((.+?)\\\)/g, (_m, body) => `$${body}$`);
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };
const hastText = (n: HastNode): string => n.value ?? (n.children ?? []).map(hastText).join("");

/** The source of a fenced block in `lang` (```concept, ```structure), or null for any other <pre>. */
function fencedSource(pre: HastNode | undefined, lang: string): string | null {
  const code = pre?.children?.find((c) => c.tagName === "code");
  const cls = code?.properties?.className;
  return code && Array.isArray(cls) && cls.includes(`language-${lang}`) ? hastText(code) : null;
}

/** Figure images of library papers are backend paths; anything else must be an absolute https URL. */
export function imageUrl(src: string): string | null {
  if (/^\/papers\/[0-9a-f-]{36}\/figures\/[\w-]+\/image$/i.test(src)) return apiUrl(src);
  if (/^https:\/\//i.test(src)) return src;
  return null;
}

/** What the chat page does when a citation or a figure in an answer is clicked. */
export type ChatLinks = {
  openPaper: (id: string, title: string) => void;
  openFigure: (src: string, caption: string) => void;
};
export const ChatLinksContext = createContext<ChatLinks | null>(null);

function MdImage({ src, alt }: { src: string; alt: string }) {
  const links = useContext(ChatLinksContext);
  const url = imageUrl(src);
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span className="kc-figure kc-figure-broken" title={src}>
        <span className="kc-figure-broken-label">figure not shown</span>
        <code>{src}</code>
      </span>
    );
  }
  return (
    <button type="button" className="kc-figure" title="Open the figure beside the chat"
      onClick={() => links?.openFigure(url, alt)}>
      <img src={url} alt={alt} loading="lazy" onError={() => setBroken(true)} />
      {alt && <span className="kc-figure-caption">{alt}</span>}
    </button>
  );
}

/** `streaming`: the answer is still arriving, so an unreadable card may just be unfinished. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const links = useContext(ChatLinksContext);
  return (
    <div className="kc-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { strict: false, throwOnError: false }],
          [rehypeHighlight, { detect: false }],
        ]}
        components={{
          pre({ node, children, ...rest }) {
            const concept = fencedSource(node as HastNode | undefined, "concept");
            if (concept !== null) return <ConceptBlock source={concept} streaming={streaming} />;
            const structure = fencedSource(node as HastNode | undefined, "structure");
            if (structure !== null) {
              return (
                <Suspense fallback={<div className="kc-card kc-card-pending">structure …</div>}>
                  <StructureBlock source={structure} streaming={streaming} />
                </Suspense>
              );
            }
            return <pre {...rest}>{children}</pre>;
          },
          img({ src, alt }) {
            return <MdImage src={String(src ?? "")} alt={alt ?? ""} />;
          },
          a({ node: _n, href, children, ...rest }) {
            const target = href ?? "";
            const paper = PAPER_LINK.exec(target);
            if (paper) {
              const title = hastText((_n ?? { type: "root" }) as HastNode);
              return (
                <a href={target} className="kc-cite" title="Open this paper beside the chat"
                  onClick={(e) => { if (!links || e.metaKey || e.ctrlKey) return; e.preventDefault(); links.openPaper(paper[1], title); }}>
                  {children}
                </a>
              );
            }
            return <a href={target} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
          },
        }}
      >
        {normaliseMath(text)}
      </ReactMarkdown>
    </div>
  );
});
