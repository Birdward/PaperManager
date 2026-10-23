import { useMemo } from 'react';
import { BrokenBlock } from '../ConceptBlock';
import { StructureView } from './StructureView';
import { parseSource } from './viewer';

/**
 * A ```structure fenced block in an answer: a PDB id, `AF-<UniProt>`, or a spec as
 * JSON (see types.ts). While the block is still streaming it shows a placeholder.
 */
export default function StructureBlock({ source, streaming = false }: { source: string; streaming?: boolean }) {
  // Re-parsed only when the block's own text changes, not on every streamed token around it.
  const parsed = useMemo(() => parseSource(source), [source]);
  if (!parsed && !streaming) return <BrokenBlock kind="structure" source={source} />;
  if (!parsed) return <div className="kc-card kc-card-pending">structure …</div>;
  return <StructureView spec={parsed.spec} />;
}
