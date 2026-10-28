export interface Paper {
  id: string;
  title: string;
  year?: number;
  doi?: string;
  abstract?: string;
  summary?: string;
  drive_file_id?: string;
  citation_count?: number;
  metadata_source?: string;
  created_at: string;
  venue?: string;
  reading_status?: "unread" | "reading" | "read";
  rating?: number;
  bookmarked?: boolean;
  color?: string;
  document_type?: "paper" | "book" | "lecture_deck" | "news_article";
  published_date?: string;   // ISO date (YYYY-MM-DD); used for news articles
  added_by?: string;
  added_by_color?: string;
}

export interface StartupRole {
  name: string;
  role: string;
  active: boolean;
}

export interface Person {
  id: string;
  name: string;
  affiliation?: string;
  email?: string;
  tracked?: boolean;
  s2_author_id?: string;
  citation_count?: number;
  bio?: string;
  phone?: string;
  orcid_url?: string;
  scholar_url?: string;
  linkedin_url?: string;
  website_url?: string;
  skills?: string;        // JSON-encoded string[]
  startup_roles?: string; // JSON-encoded StartupRole[]
  last_enriched_at?: string;
}

export interface Topic {
  id: string;
  name: string;
  paper_count?: number;
}

export interface Tag {
  id: string;
  name: string;
  paper_count?: number;
  person_count?: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status?: string;
  created_at: string;
}

export interface Note {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface SearchResult extends Paper {
  score: number;
  matched_in: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Reference {
  id?: string;
  title: string;
  year?: number;
  doi?: string;
  arxiv_id?: string;
  authors?: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  [key: string]: unknown;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface Stats {
  counts: { papers: number; authors: number; topics: number; tags: number; projects: number; bookmarked: number };
  papers_by_year: { year: number; count: number }[];
  top_topics: { name: string; count: number }[];
  recent_papers: (Paper & { authors: string[] })[];
  reading_status: { status: string; count: number }[];
}

export interface ParsedMeta {
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  abstract?: string;
  venue?: string;
  citation_count?: number;
  metadata_source: string;
  published_date?: string;
}

export interface T_IngestOut extends Paper {
  drive_url?: string;
  authors: string[];
  topics_auto_added: string[];
  references_found: Reference[];
  pdf_fetched?: boolean;  // undefined = legacy upload (assume true); false = no PDF available
}

// ── Chapter (book support) ────────────────────────────────────────────────────

export interface Chapter {
  id: string;
  paper_id: string;
  number: number;
  title: string;
  level: number;         // 1 = chapter, 2 = sub-chapter
  summary?: string;
  start_page?: number;
  end_page?: number;
  created_at: string;
  updated_at: string;
}

// ── Figures ───────────────────────────────────────────────────────────────────

export interface Figure {
  id: string;
  paper_id: string;
  figure_number: number | string | null;
  caption: string | null;
  drive_file_id: string;
  drive_url: string | null;
  page_number: number;
  created_at: string;
}

export interface PaperTable {
  id: string;
  paper_id: string;
  table_number: number | string | null;
  caption: string | null;
  markdown_content: string;
  page_number: number;
  created_at: string;
}

// ── Knowledge Chat ────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  compacted: boolean;
  message_count: number;
  started_by?: string;
  /** Knowledge Chat forks: the conversation this was copied from and how many questions it inherited. */
  parent_id?: string | null;
  fork_at?: number | null;
  fork_kind?: "strand" | "edit" | null;
  branch_label?: string | null;
}

/** A concept card generated from a chat answer (backend/services/chat_concepts.py). */
export interface ChatConcept {
  label: string;
  type: ConceptType;
  /** Index of the answer's `## ` section it explains (see components/kchat/sections.ts). */
  section: number;
  anchor: string;
  context: string;
  spec: ConceptSpec | null;
  error: string | null;
}

export interface ChatConceptsState {
  status: "running" | "done" | "failed" | null;
  error: string | null;
  concepts: ChatConcept[] | null;
}

export interface MessagePaper { id: string; title?: string | null; year?: number | null }

export interface KnowledgeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tokens_used?: number;
  created_at: string;
  paper_refs: string[];
  papers?: MessagePaper[];
  concepts?: ChatConcept[] | null;
  concepts_status?: ChatConceptsState["status"];
  concepts_error?: string | null;
  /** On a question whose answer failed. */
  answer_error?: string | null;
}

export interface ContextPaper {
  id: string;
  title: string;
  tokens: number;
  color: string;
  year?: number | null;
  attached?: boolean;
}

export interface TokenTotals {
  system: number;
  papers: number;
  history: number;
  question: number;
  total: number;
  limit: number;
}

export type StepKind = "cypher" | "search" | "fulltext" | "figures" | "web" | "attach" | "notes";

export type SseEvent =
  | { type: "step"; kind?: StepKind; description: string; cypher?: string | null; count?: number | null; papers?: MessagePaper[] }
  | { type: "status"; text: string }
  | { type: "context"; papers: ContextPaper[]; token_totals: TokenTotals }
  | { type: "conversation"; conversation_id: string; user_message_id: string }
  | { type: "token"; text: string }
  | { type: "done"; conversation_id: string; message_id: string }
  | { type: "error"; message: string };

export type BulkSseEvent =
  | { done?: false; index: number; total: number; status: "success"; title: string; id: string; has_pdf: boolean }
  | { done?: false; index: number; total: number; status: "skipped"; title: string; id: string; reason: string }
  | { done?: false; index: number; total: number; status: "error"; input: string; error: string }
  | { done: true; imported: number; skipped: number; errors: number };

// ── Literature search ─────────────────────────────────────────────────────────

export interface LitPaper {
  title: string;
  abstract?: string;
  authors: string[];
  doi?: string;
  year?: number;
  date: string;
  source: "arxiv" | "pubmed" | "biorxiv";
  url: string;
  already_in_library: boolean;
}

export type LiteratureSseEvent =
  | { done?: false; searching: string }
  | { done?: false; source: string; paper: LitPaper }
  | { done?: false; source: string; error: string }
  | { done: true; counts: Record<string, number> };

// ── Discover (external search) ────────────────────────────────────────────────

export interface DiscoverSearchResult {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  doi: string | null;
  url: string;
  source: "arxiv" | "semantic_scholar" | "pubmed";
  in_library: boolean;
  library_paper_id: string | null;
}

// ── Related papers ────────────────────────────────────────────────────────────

export interface RelatedPaper {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  doi: string | null;
  url: string;
  venue: string | null;
  citation_count: number | null;
  in_library: boolean;
  library_paper_id: string | null;
}

// ── Blogs ─────────────────────────────────────────────────────────────────────

export interface Blog {
  id: string;
  name: string;
  url: string;
  feed_url: string;
  description?: string;
  parser: string;
  created_at: string;
  post_count: number;
}

export interface BlogPost {
  id: string;
  blog_id: string;
  title: string;
  url: string;
  author?: string;
  published_at?: string;
  description?: string;
  content?: string;
  content_md?: string;         // Ollama-formatted markdown
  figures?: string[];          // image URLs extracted from the page
  references_json?: string;    // JSON: [{title, url}]
  summary?: string;
  reading_status: "unread" | "reading" | "read";
  imported: boolean;
  created_at: string;
  updated_at: string;
  blog_name?: string;
}

export type AnnotationColor = "yellow" | "green" | "blue" | "red" | "purple";

export interface Annotation {
  id: string;
  page_number: number;
  highlighted_text: string;
  color: AnnotationColor;
  note: string;
  position_json: string;
  created_at: string;
  updated_at: string;
}

// ── Research Gaps (T29) ───────────────────────────────────────────────────────

export interface ResearchGapsRequest {
  topic: string;
  project_id?: string;
  paper_ids?: string[];
}

export interface ResearchGapsResponse {
  analysis: string;
  papers_considered: number;
  topic: string;
}

// ── Venues (T30) ──────────────────────────────────────────────────────────────

export interface VenueOut {
  name: string;
  count: number;
  years: number[];
}

// ── Claims ────────────────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  text: string;
  type: "claim" | "hypothesis" | "finding" | "method" | "limitation";
}

// ── Concepts (interactive visualisations on PDF pages) ───────────────────────

export type ConceptType = "formula" | "graph" | "2d-text" | "2d-anim";

export interface FormulaSpec {
  type: "formula";
  title: string;
  caption: string;
  main_latex: string;
  steps: { latex: string; explanation: string }[];
}

export interface GraphSpec {
  type: "graph";
  title: string;
  caption: string;
  chart_type: "lines" | "points" | "bars";
  x_label: string;
  y_label: string;
  /** JSON string: {series:[{name,color,points}]}, {points}, or {bars:[{label,value}]} */
  data_json: string;
}

export interface TextSpec {
  type: "2d-text";
  title: string;
  caption: string;
  body_markdown: string;
  citations: { label: string; source: string; url: string }[];
}

export interface AnimSpec {
  type: "2d-anim";
  title: string;
  caption: string;
  /** Function body returning { draw(ctx, w, h, time, dt) }; runs in a sandboxed iframe. */
  setup_code: string;
}

export type ConceptSpec = FormulaSpec | GraphSpec | TextSpec | AnimSpec;

export interface Concept {
  id: string;
  /** 0-based PDF page index */
  page: number;
  position: number;
  label: string;
  type: ConceptType;
  anchor: string;
  anchor_found: boolean;
  context: string;
  spec: ConceptSpec | null;
  spec_error: string | null;
}

export type ConceptsBackend = "claude-code" | "api";

/** Progress of the background job that generates every missing visualisation. */
export interface ConceptGeneration {
  total: number;
  done: number;
  failed: number;
  running: boolean;
}
