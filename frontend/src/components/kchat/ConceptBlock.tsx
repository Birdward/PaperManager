import { useMemo } from "react";
import type { ConceptSpec } from "../../types";
import ConceptCard from "./ConceptCard";

const TYPES = new Set(["formula", "graph", "2d-text", "2d-anim"]);

/**
 * The spec in a ```concept fenced block the model wrote itself: either a bare spec
 * (`{"type": "formula", ...}`) or a concept wrapping one (`{"label", "spec": {...}}`).
 * Null while the block is still streaming or when it is not a usable spec.
 */
export function parseConcept(raw: string): { label?: string; spec: ConceptSpec } | null {
  let data: unknown;
  try { data = JSON.parse(raw.trim()); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const spec = (d.spec && typeof d.spec === "object" ? d.spec : d) as Record<string, unknown>;
  if (!TYPES.has(String(spec.type))) return null;
  const ok =
    spec.type === "formula" ? typeof spec.main_latex === "string" :
    spec.type === "graph" ? typeof spec.data_json === "string" || typeof spec.data_json === "object" :
    spec.type === "2d-text" ? typeof spec.body_markdown === "string" :
    typeof spec.setup_code === "string";
  if (!ok) return null;
  const clean = { title: "", caption: "", ...spec } as Record<string, unknown>;
  if (clean.type === "formula" && !Array.isArray(clean.steps)) clean.steps = [];
  if (clean.type === "2d-text" && !Array.isArray(clean.citations)) clean.citations = [];
  // Models sometimes write data_json as an object instead of a JSON string.
  if (clean.type === "graph" && typeof clean.data_json !== "string") clean.data_json = JSON.stringify(clean.data_json);
  return { label: typeof d.label === "string" ? d.label : undefined, spec: clean as unknown as ConceptSpec };
}

/** A ```concept or ```structure block whose answer has finished but whose text is not a valid card. */
export function BrokenBlock({ kind, source }: { kind: string; source: string }) {
  return (
    <div className="kc-card kc-card-broken">
      <div className="kc-card-broken-label">{kind} card cut off: the answer ended before the card was complete</div>
      <pre>{source}</pre>
    </div>
  );
}

/** A ```concept block in an answer, rendered as an interactive card. */
export default function ConceptBlock({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const parsed = useMemo(() => parseConcept(source), [source]);
  if (!parsed && !streaming) return <BrokenBlock kind="concept" source={source} />;
  if (!parsed) return <div className="kc-card kc-card-pending">concept …</div>;
  return <ConceptCard spec={parsed.spec} label={parsed.label} />;
}
