import type { T_IngestOut, ParsedMeta, GraphData, Reference, Conversation, KnowledgeMessage, SseEvent, BulkSseEvent, Figure, PaperTable, LiteratureSseEvent, Paper, Chapter, Blog, BlogPost, Note, Annotation, AnnotationColor, VenueOut, Claim , Concept, ConceptsBackend, ConceptGeneration } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// The session JWT lives in an httpOnly cookie set by the backend on login, so it
// is never exposed to JavaScript (no localStorage) and cannot be stolen via XSS.
// Every request must opt in to sending cookies with `credentials: "include"`.
const CREDENTIALS: RequestCredentials = "include";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Statuses that the backend asks us to retry (Neo4j Aura reconnects return 503,
// see Neo4jReconnectMiddleware). 502/504 cover proxy/gateway blips.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 2;

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const merged: RequestInit = {
    ...options,
    credentials: CREDENTIALS,
    headers: {
      ...(options?.headers ?? {}),
    },
  };

  let res: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(`${BASE}${path}`, merged);
    } catch (err) {
      // Network-level failure (dropped connection, DNS, etc.) — retry transparently.
      if (attempt < MAX_RETRIES) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw err;
    }

    // Transient server errors (e.g. Neo4j Aura connection reset → 503) — retry.
    if (TRANSIENT_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(300 * (attempt + 1));
      continue;
    }
    break;
  }

  // res is always assigned here (loop runs at least once or throws).
  res = res!;

  // Handle 401 Unauthorized - signal auth expiry without a hard page reload
  if (res.status === 401) {
    localStorage.removeItem("pm_username");
    localStorage.removeItem("pm_current_user");
    window.dispatchEvent(new CustomEvent("auth:expired"));
    throw new Error("Session expired. Please login again.");
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`API ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function parsePdf(file: File, signal?: AbortSignal): Promise<ParsedMeta> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/papers/parse`, { method: "POST", body: form, signal, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Parse failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export interface PreprocessStatus {
  preprocess_key: string;
  status: "pending" | "running" | "ready" | "error" | "missing";
  error?: string;
}

export async function preprocessPdf(
  file: File,
  captionMethod = "docling",
  signal?: AbortSignal,
): Promise<PreprocessStatus> {
  const form = new FormData();
  form.append("file", file);
  form.append("caption_method", captionMethod);
  const res = await fetch(`${BASE}/papers/preprocess`, { method: "POST", body: form, signal, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Preprocess failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function getPreprocessStatus(preprocessKey: string): Promise<PreprocessStatus> {
  return apiFetch<PreprocessStatus>(`/papers/preprocess/${preprocessKey}`);
}

export interface TagSuggestions {
  existing: string[];
  new: string[];
  all_tags: string[];
}

export interface AnalysisStatus {
  analysis_key: string;
  status: "pending" | "running" | "ready" | "error" | "missing";
  error?: string;
  tag_suggestions?: TagSuggestions;
  meta?: ParsedMeta;
}

export async function preanalyzePdf(file: File, signal?: AbortSignal): Promise<AnalysisStatus> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/papers/preanalyze`, { method: "POST", body: form, signal, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Preanalyze failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function getPreanalysisStatus(analysisKey: string): Promise<AnalysisStatus> {
  return apiFetch<AnalysisStatus>(`/papers/preanalyze/${analysisKey}`);
}

export async function uploadPdf(
  file: File,
  titleOverride?: string,
  projectId?: string,
  captionMethod?: string,
  summaryInstructions?: string,
  debug?: boolean,
  documentType?: string,
  claimsModel?: string,
  generateEmbedding?: boolean,
  preprocessKey?: string,
  analysisKey?: string,
  publishedDate?: string,
): Promise<T_IngestOut> {
  const form = new FormData();
  form.append("file", file);
  if (titleOverride) form.append("title_override", titleOverride);
  if (projectId) form.append("project_id", projectId);
  if (captionMethod) form.append("caption_method", captionMethod);
  if (summaryInstructions) form.append("summary_instructions", summaryInstructions);
  if (debug) form.append("debug", "true");
  if (documentType) form.append("document_type", documentType);
  if (publishedDate) form.append("published_date", publishedDate);
  if (preprocessKey) form.append("preprocess_key", preprocessKey);
  if (analysisKey) form.append("analysis_key", analysisKey);
  // Pass empty string to skip claims extraction; omit to use backend default
  if (claimsModel !== undefined) form.append("claims_model", claimsModel);
  if (generateEmbedding === false) form.append("skip_embedding", "true");
  const res = await fetch(`${BASE}/papers/upload`, { method: "POST", body: form, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Upload failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function previewUrl(url: string): Promise<ParsedMeta> {
  return apiFetch<ParsedMeta>("/papers/preview-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function previewUrlPdf(url: string): Promise<ParsedMeta> {
  return apiFetch<ParsedMeta>("/papers/preview-url/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function ingestFromUrl(url: string, projectId?: string, debug?: boolean): Promise<T_IngestOut> {
  return apiFetch<T_IngestOut>("/papers/from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId ?? null, debug: debug ?? false }),
  });
}

export async function ingestFromUrlFull(url: string, projectId?: string, debug?: boolean, summaryInstructions?: string): Promise<T_IngestOut> {
  return apiFetch<T_IngestOut>("/papers/from-url-full", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId ?? null, debug: debug ?? false, summary_instructions: summaryInstructions ?? null }),
  });
}

export async function deleteDebugPapers(): Promise<{ deleted: number; figures_deleted: number }> {
  return apiFetch("/papers/debug-cleanup", { method: "DELETE" });
}

export async function countDebugPapers(): Promise<number> {
  const res = await apiFetch<unknown[]>("/search?tag=debug&limit=500");
  return Array.isArray(res) ? res.length : 0;
}

export async function exportPaperMarkdown(paperId: string): Promise<void> {
  const res = await fetch(`${BASE}/export/papers/${paperId}/markdown`, { credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Export failed ${res.status}`);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : `${paperId}.md`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export async function exportRdf(): Promise<void> {
  const res = await fetch(`${BASE}/export/rdf`, { credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Export failed ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "papermanager.ttl"; a.click();
  URL.revokeObjectURL(url);
}

export async function exportCsv(): Promise<void> {
  const res = await fetch(`${BASE}/export/csv`, { credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Export failed ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "papermanager_export.zip"; a.click();
  URL.revokeObjectURL(url);
}

export async function exportSnapshot(): Promise<void> {
  const res = await fetch(`${BASE}/export/snapshot`, { credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Export failed ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^\"]+)"?/);
  a.href = url;
  a.download = match ? match[1] : "papermanager_snapshot.json";
  a.click();
  URL.revokeObjectURL(url);
}

export async function importRdf(file: File): Promise<{ imported: Record<string, number> }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/export/import/rdf`, { method: "POST", body: form, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Import failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function importSnapshot(file: File, replace = true): Promise<{ imported: Record<string, number>; replaced: boolean }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/export/import/snapshot?replace=${replace ? "true" : "false"}`, { method: "POST", body: form, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Import failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export interface SnapshotValidation {
  valid: boolean;
  error?: string;
  format?: string;
  version?: number;
  exported_at?: string;
  total_nodes: number;
  total_relationships: number;
  node_types: Record<string, number>;
  relationship_types: Record<string, number>;
  notes: {
    total: number;
    with_content: number;
    without_content: number;
    missing_content_details: Array<{ id: string; created_at?: string }>;
  };
  figures: {
    total: number;
    with_drive_file_id: number;
    without_drive_file_id: number;
    missing_drive_details: Array<{ id: string; paper_id?: string; figure_number?: number }>;
  };
}

export async function validateSnapshot(file: File): Promise<SnapshotValidation> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/export/import/snapshot/validate`, { method: "POST", body: form, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Validation failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function clearPapers(): Promise<Record<string, number>> {
  return apiFetch("/admin/clear-papers", { method: "DELETE" });
}

export async function seedDefaults(): Promise<{ seeded: number }> {
  return apiFetch("/admin/seed-defaults", { method: "POST" });
}

export async function regenerateSummary(paperId: string): Promise<{ summary: string }> {
  return apiFetch(`/papers/${paperId}/regenerate-summary`, { method: "POST" });
}

export async function reextractAbstract(paperId: string): Promise<{ abstract: string; doi?: string; year?: number }> {
  return apiFetch(`/papers/${paperId}/reextract-abstract`, { method: "POST" });
}

export async function aiExtractMetadata(paperId: string): Promise<{ abstract: string | null; doi?: string | null; year?: number | null }> {
  return apiFetch(`/papers/${paperId}/ai-extract-metadata`, { method: "POST" });
}

export async function reextractMetadata(paperId: string): Promise<{
  title?: string; authors?: string[]; year?: number | null;
  doi?: string | null; venue?: string | null; abstract?: string | null;
  metadata_source?: string;
}> {
  return apiFetch(`/papers/${paperId}/reextract-metadata`, { method: "POST" });
}

export async function refetchPdf(paperId: string): Promise<{ authors: string[]; drive_url?: string }> {
  return apiFetch(`/papers/${paperId}/refetch-pdf`, { method: "POST" });
}

export async function uploadPdfForPaper(paperId: string, file: File): Promise<{ drive_url?: string; authors_added: string[]; raw_text_len: number }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/papers/${paperId}/upload-pdf`, { method: "POST", body: form, credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PDF upload failed ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function deletePaper(paperId: string): Promise<void> {
  const res = await fetch(`${BASE}/papers/${paperId}`, { method: "DELETE", credentials: CREDENTIALS });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Delete failed ${res.status}: ${detail}`);
  }
}

export async function checkDuplicate(doi?: string, title?: string): Promise<{ id: string; title: string; hasPdf: boolean } | null> {
  const params = new URLSearchParams();
  if (doi) params.set("doi", doi);
  else if (title) params.set("title", title);
  else return null;
  const res = await apiFetch<{ duplicate: { id: string; title: string; drive_file_id?: string | null } | null }>(`/papers/check-duplicate?${params}`);
  if (!res.duplicate) return null;
  return {
    id: res.duplicate.id,
    title: res.duplicate.title,
    hasPdf: !!res.duplicate.drive_file_id,
  };
}

export async function updatePaper(paperId: string, data: Partial<{
  title: string; year: number | null; doi: string | null;
  abstract: string | null; summary: string | null; venue: string | null;
  metadata_source: string | null;
  reading_status: string | null; rating: number | null;
  bookmarked: boolean | null; color: string | null;
  document_type: string | null; published_date: string | null;
}>): Promise<Paper> {
  return apiFetch<Paper>(`/papers/${paperId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchGraph(mode: string): Promise<GraphData> {
  return apiFetch<GraphData>(`/graph?mode=${mode}`);
}

export async function extractReferences(paperId: string): Promise<{ references: Reference[] }> {
  return apiFetch(`/papers/${paperId}/extract-references`);
}

export async function aiExtractReferences(paperId: string): Promise<{ references: Reference[] }> {
  return apiFetch(`/papers/${paperId}/ai-extract-references`);
}

export async function saveReferences(paperId: string, references: Reference[]): Promise<void> {
  await apiFetch(`/papers/${paperId}/references`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ references }),
  });
}

// ── Entity management ─────────────────────────────────────────────────────────

export async function suggestTags(title: string, abstract?: string): Promise<{
  existing: string[]; new: string[]; all_tags: string[];
}> {
  return apiFetch("/tags/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, abstract: abstract ?? null }),
  });
}

export async function applyTags(paperId: string, tags: string[]): Promise<void> {
  await Promise.all(tags.map((name) =>
    apiFetch(`/papers/${paperId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ));
}

export async function createStandaloneTag(name: string): Promise<void> {
  await apiFetch(`/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteTag(name: string): Promise<void> {
  await apiFetch(`/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function suggestTopics(paperId: string): Promise<{ topics: string[] }> {
  return apiFetch(`/papers/${paperId}/topics/suggest`, { method: "POST" });
}

export async function createStandaloneTopic(name: string): Promise<void> {
  await apiFetch(`/topics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteTopic(name: string): Promise<void> {
  await apiFetch(`/topics/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function renameTopic(oldName: string, newName: string): Promise<void> {
  await apiFetch(`/topics/${encodeURIComponent(oldName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export async function getOrCreatePerson(name: string, affiliation?: string, email?: string): Promise<{id: string; name: string; affiliation?: string; email?: string}> {
  return apiFetch("/people/get-or-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, affiliation: affiliation ?? null, email: email ?? null }),
  });
}

export async function linkPersonInvolves(paperId: string, personId: string, role: string, yearsKnown?: string): Promise<void> {
  await apiFetch(`/papers/${paperId}/involves`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ person_id: personId, role, years_known: yearsKnown ?? null }),
  });
}

export async function listPeople(): Promise<{id: string; name: string; affiliation?: string}[]> {
  return apiFetch("/people");
}

export async function fetchPaperInvolves(paperId: string): Promise<{id: string; name: string; affiliation?: string; role: string}[]> {
  return apiFetch(`/papers/${paperId}/involves`);
}

export async function deletePerson(personId: string): Promise<void> {
  await apiFetch(`/people/${personId}`, { method: "DELETE" });
}

export async function updatePerson(personId: string, data: Partial<{
  name: string; affiliation: string | null; email: string | null;
  bio: string | null; phone: string | null;
  orcid_url: string | null; scholar_url: string | null;
  linkedin_url: string | null; website_url: string | null;
  skills: string | null; startup_roles: string | null;
}>): Promise<void> {
  await apiFetch(`/people/${personId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function removeAuthor(paperId: string, personId: string): Promise<void> {
  const res = await fetch(`${BASE}/papers/${paperId}/authors/${personId}`, { method: "DELETE", credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Remove author failed ${res.status}`);
}

export async function addAuthorByName(paperId: string, name: string): Promise<{id: string; name: string; affiliation?: string}> {
  const person = await getOrCreatePerson(name);
  await apiFetch(`/papers/${paperId}/authors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ person_id: person.id }),
  });
  return person;
}

export async function aiExtractAuthors(paperId: string): Promise<{authors: {id: string; name: string; affiliation?: string}[]}> {
  return apiFetch(`/papers/${paperId}/ai-extract-authors`, { method: "POST" });
}

export async function fetchPaperProjects(paperId: string): Promise<{id: string; name: string; description?: string; status?: string}[]> {
  return apiFetch(`/papers/${paperId}/projects`);
}

export async function listProjects(): Promise<{id: string; name: string; description?: string; status?: string}[]> {
  return apiFetch("/projects");
}

export async function getProject(projectId: string): Promise<{id: string; name: string; description?: string; status?: string; papers: object[]}> {
  return apiFetch(`/projects/${projectId}`);
}

export async function createProject(data: { name: string; description?: string; status?: string }): Promise<{id: string; name: string}> {
  return apiFetch("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiFetch(`/projects/${projectId}`, { method: "DELETE" });
}

export async function updateProject(projectId: string, data: { name?: string; description?: string; status?: string }): Promise<void> {
  await apiFetch(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function removePaperFromProject(projectId: string, paperId: string): Promise<void> {
  await apiFetch(`/projects/${projectId}/papers/${paperId}`, { method: "DELETE" });
}

export async function addPaperToProject(projectId: string, paperId: string): Promise<void> {
  await apiFetch(`/projects/${projectId}/papers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_id: paperId }),
  });
}

export async function getProjectTags(projectId: string): Promise<{ name: string; count: number; paper_ids: string[] }[]> {
  return apiFetch(`/projects/${projectId}/tags`);
}

export async function getProjectNote(projectId: string): Promise<{ content: string }> {
  return apiFetch(`/projects/${projectId}/note`);
}

export async function saveProjectNote(projectId: string, content: string): Promise<{ content: string }> {
  return apiFetch(`/projects/${projectId}/note`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function getProjectKeywords(projectId: string): Promise<{ content: string }> {
  return apiFetch(`/projects/${projectId}/keywords`);
}

export async function saveProjectKeywords(projectId: string, content: string): Promise<{ content: string }> {
  return apiFetch(`/projects/${projectId}/keywords`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// Project Membership
export interface ProjectMember {
  username: string;
  user_id: string;
  color?: string;
  role: "read" | "write" | "admin";
  joined_at: string;
  updated_at?: string;
}

export async function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  return apiFetch(`/projects/${projectId}/members`);
}

export async function addProjectMember(projectId: string, username: string, role: "read" | "write" | "admin" = "read"): Promise<ProjectMember> {
  return apiFetch(`/projects/${projectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, role }),
  });
}

export async function updateProjectMemberRole(projectId: string, username: string, role: "read" | "write" | "admin"): Promise<ProjectMember> {
  return apiFetch(`/projects/${projectId}/members/${encodeURIComponent(username)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function removeProjectMember(projectId: string, username: string): Promise<void> {
  return apiFetch(`/projects/${projectId}/members/${encodeURIComponent(username)}`, {
    method: "DELETE",
  });
}

export async function getMyProjects(): Promise<{id: string; name: string; description?: string; status?: string; role: string}[]> {
  return apiFetch("/projects/my-projects");
}

export function projectBibtexUrl(projectId: string): string {
  return `${BASE}/projects/${projectId}/export/bibtex`;
}

export function projectCsvUrl(projectId: string): string {
  return `${BASE}/projects/${projectId}/export/csv`;
}

export function projectConversationsUrl(projectId: string): string {
  return `${BASE}/projects/${projectId}/export/conversations`;
}

export async function createTag(paperId: string, name: string): Promise<void> {
  await apiFetch(`/papers/${paperId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function listReferences(
  paperId: string
): Promise<{ references: Reference[]; cited_by: Reference[] }> {
  return apiFetch(`/papers/${paperId}/references`);
}

// ── Per-paper conversations ───────────────────────────────────────────────────

export async function listPaperConversations(paperId: string): Promise<import("../types").Conversation[]> {
  return apiFetch(`/papers/${paperId}/conversations`);
}

export async function getPaperConversationMessages(paperId: string, convId: string): Promise<import("../types").KnowledgeMessage[]> {
  return apiFetch(`/papers/${paperId}/conversations/${convId}/messages`);
}

export async function renamePaperConversation(paperId: string, convId: string, title: string): Promise<void> {
  await apiFetch(`/papers/${paperId}/conversations/${convId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function compactPaperConversation(paperId: string, convId: string): Promise<void> {
  await apiFetch(`/papers/${paperId}/conversations/${convId}/compact`, { method: "POST" });
}

export async function deletePaperConversation(paperId: string, convId: string): Promise<void> {
  await apiFetch(`/papers/${paperId}/conversations/${convId}`, { method: "DELETE" });
}

/** PDF pages a paper-chat answer had access to (long documents are read in part). */
export interface PaperChatCoverage { total_pages: number; pages_read: string; complete: boolean }
/** The request as Claude saw it: largest prompt sent (tokens), the model's context window and the model. */
export interface PaperChatContext { tokens: number; window: number | null; model: string | null }

export async function chatWithPaper(
  paperId: string,
  question: string,
  history: { role: string; content: string }[],
  model: string,
  conversationId?: string,
): Promise<{ answer: string; conversation_id: string; coverage?: PaperChatCoverage | null; context?: PaperChatContext | null }> {
  return apiFetch(`/papers/${paperId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history, model, conversation_id: conversationId ?? null }),
  });
}

// ── Knowledge Chat ────────────────────────────────────────────────────────────

export async function listConversations(): Promise<Conversation[]> {
  return apiFetch("/knowledge-chat/conversations");
}

export async function getConversationMessages(id: string): Promise<KnowledgeMessage[]> {
  return apiFetch(`/knowledge-chat/conversations/${id}/messages`);
}

export async function compactConversation(id: string): Promise<void> {
  await apiFetch(`/knowledge-chat/conversations/${id}/compact`, { method: "POST" });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/knowledge-chat/conversations/${id}`, { method: "DELETE" });
}

export async function renameConversation(id: string, title: string): Promise<Conversation> {
  return apiFetch(`/knowledge-chat/conversations/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  });
}

/** Copy a conversation up to the answer of question `keep` (1-based); 0 forks before the first. */
export async function forkConversation(id: string, keep: number, kind: "strand" | "edit"): Promise<Conversation> {
  return apiFetch(`/knowledge-chat/conversations/${id}/fork`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep, kind }),
  });
}

export async function visualiseAnswer(messageId: string): Promise<import("../types").ChatConceptsState> {
  return apiFetch(`/knowledge-chat/messages/${messageId}/visualise`, { method: "POST" });
}

export async function getAnswerConcepts(messageId: string): Promise<import("../types").ChatConceptsState> {
  return apiFetch(`/knowledge-chat/messages/${messageId}/concepts`);
}

export async function repairAnswerConcept(messageId: string, index: number, error: string): Promise<import("../types").ChatConceptsState> {
  return apiFetch(`/knowledge-chat/messages/${messageId}/concepts/${index}/repair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error }),
  });
}

/** Absolute URL of a backend path (figure images and PDFs embedded in chat answers). */
export const apiUrl = (path: string) => `${BASE}${path}`;

export async function* streamKnowledgeChat(body: {
  question: string;
  history: { role: string; content: string }[];
  model: string;
  conversation_id?: string;
  use_web?: boolean;
  paper_ids?: string[];
}, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(`${BASE}/knowledge-chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: CREDENTIALS,
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`API ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          yield JSON.parse(line.slice(6)) as SseEvent;
        } catch { /* skip malformed */ }
      }
    }
  }
}

// ── Bulk import ───────────────────────────────────────────────────────────────

export async function* bulkImport(
  body: { papers: object[]; project_id?: string | null; fetch_pdf?: boolean },
  signal?: AbortSignal,
): AsyncGenerator<BulkSseEvent> {
  const res = await fetch(`${BASE}/papers/bulk-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    credentials: CREDENTIALS,
  });
  if (!res.ok || !res.body) throw new Error(`API ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          yield JSON.parse(line.slice(6)) as BulkSseEvent;
        } catch { /* skip malformed */ }
      }
    }
  }
}

// ── Literature keywords ───────────────────────────────────────────────────────

export async function getLiteratureKeywords(): Promise<{ content: string }> {
  return apiFetch("/literature/keywords");
}

export async function putLiteratureKeywords(content: string): Promise<{ content: string; keywords: string[] }> {
  return apiFetch("/literature/keywords", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── Literature search ─────────────────────────────────────────────────────────

export async function* searchLiterature(
  body: { days: number; max_per_source: number; sources: string[]; project_id?: string | null },
  signal?: AbortSignal,
): AsyncGenerator<LiteratureSseEvent> {
  const res = await fetch(`${BASE}/literature/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    credentials: CREDENTIALS,
  });
  if (!res.ok || !res.body) throw new Error(`API ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          yield JSON.parse(line.slice(6)) as LiteratureSseEvent;
        } catch { /* skip malformed */ }
      }
    }
  }
}

// ── Figures ───────────────────────────────────────────────────────────────────

export async function fetchFigures(paperId: string): Promise<Figure[]> {
  return apiFetch(`/papers/${paperId}/figures`);
}

export async function fetchTables(paperId: string): Promise<PaperTable[]> {
  return apiFetch(`/papers/${paperId}/tables`);
}

export async function extractFiguresForPaper(
  paperId: string,
  captionMethod = "docling",
): Promise<{ extracted: number; tables_extracted: number }> {
  return apiFetch(`/papers/${paperId}/figures/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caption_method: captionMethod }),
  });
}

export async function chatWithFigure(
  paperId: string,
  figureId: string,
  question: string,
  model = "claude",
): Promise<{ answer: string }> {
  return apiFetch(`/papers/${paperId}/figures/${figureId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model }),
  });
}

// ── Chapters (book support) ───────────────────────────────────────────────────

export async function listChapters(paperId: string): Promise<Chapter[]> {
  return apiFetch<Chapter[]>(`/papers/${paperId}/chapters`);
}

export async function detectChapters(paperId: string, useAi = false, model?: string): Promise<Chapter[]> {
  return apiFetch<Chapter[]>(`/papers/${paperId}/chapters/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ use_ai: useAi, model: model || null }),
  });
}

export async function regenerateChapterSummary(paperId: string, chapterId: string, model?: string): Promise<Chapter> {
  return apiFetch<Chapter>(`/papers/${paperId}/chapters/${chapterId}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model || null }),
  });
}

export async function chatWithChapter(
  paperId: string,
  chapterId: string,
  question: string,
  history: { role: string; content: string }[] = [],
): Promise<{ answer: string }> {
  return apiFetch(`/papers/${paperId}/chapters/${chapterId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
}

/**
 * Returns the URL for a chapter's PDF slice.
 * The URL can be used directly as an iframe src or anchor href.
 */
export function getChapterPdfUrl(paperId: string, chapterId: string): string {
  return `${BASE}/papers/${paperId}/chapters/${chapterId}/pdf`;
}

/**
 * Returns the URL for the full book PDF.
 */
export function getPaperPdfUrl(paperId: string): string {
  return `${BASE}/papers/${paperId}/pdf`;
}

// ── Blogs ─────────────────────────────────────────────────────────────────────

export function listBlogs(): Promise<Blog[]> {
  return apiFetch("/blogs");
}

export function registerBlog(url: string): Promise<Blog> {
  return apiFetch("/blogs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function deleteBlog(blogId: string): Promise<void> {
  return apiFetch(`/blogs/${blogId}`, { method: "DELETE" });
}

export function fetchBlogPosts(blogId: string): Promise<{ new_posts: number; total_fetched: number }> {
  return apiFetch(`/blogs/${blogId}/fetch`, { method: "POST" });
}

export function listBlogPosts(blogId: string, status?: string): Promise<BlogPost[]> {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/blogs/${blogId}/posts${qs}`);
}

export function getRandomBlogPost(status = "unread"): Promise<BlogPost> {
  return apiFetch(`/blogs/posts/random?status=${status}`);
}

export function getBlogPost(postId: string): Promise<BlogPost> {
  return apiFetch(`/blogs/posts/${postId}`);
}

export function updateBlogPost(postId: string, data: { reading_status?: string }): Promise<BlogPost> {
  return apiFetch(`/blogs/posts/${postId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteBlogPost(postId: string): Promise<void> {
  return apiFetch(`/blogs/posts/${postId}`, { method: "DELETE" });
}

export function importBlogPost(postId: string): Promise<{ imported: boolean; content_length: number }> {
  return apiFetch(`/blogs/posts/${postId}/import`, { method: "POST" });
}

export function summarizeBlogPost(postId: string): Promise<{ summary: string; post: BlogPost }> {
  return apiFetch(`/blogs/posts/${postId}/summarize`, { method: "POST" });
}

export function chatWithBlogPost(
  postId: string,
  question: string,
  history: { role: string; content: string }[] = [],
): Promise<{ answer: string }> {
  return apiFetch(`/blogs/posts/${postId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
}

export function getBlogPostNote(postId: string): Promise<Note> {
  return apiFetch(`/blogs/posts/${postId}/note`);
}

export function saveBlogPostNote(postId: string, content: string): Promise<Note> {
  return apiFetch(`/blogs/posts/${postId}/note`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── Blog post tags ─────────────────────────────────────────────────────────────

export function getBlogPostTags(postId: string): Promise<{ id: string; name: string }[]> {
  return apiFetch(`/blogs/posts/${postId}/tags`);
}

export function addBlogPostTag(postId: string, tagName: string): Promise<{ id: string; name: string }> {
  return apiFetch(`/blogs/posts/${postId}/tags/${encodeURIComponent(tagName)}`, { method: "POST" });
}

export function removeBlogPostTag(postId: string, tagName: string): Promise<void> {
  return apiFetch(`/blogs/posts/${postId}/tags/${encodeURIComponent(tagName)}`, { method: "DELETE" });
}

// ── Blog post people ───────────────────────────────────────────────────────────

export function getBlogPostPeople(postId: string): Promise<{ id: string; name: string; role: string }[]> {
  return apiFetch(`/blogs/posts/${postId}/people`);
}

export function linkPersonToBlogPost(postId: string, name: string, role = "author"): Promise<{ id: string; name: string }> {
  return apiFetch(`/blogs/posts/${postId}/people`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, role }),
  });
}

export function unlinkPersonFromBlogPost(postId: string, personId: string): Promise<void> {
  return apiFetch(`/blogs/posts/${postId}/people/${personId}`, { method: "DELETE" });
}

// ── Blog post projects ─────────────────────────────────────────────────────────

export function getBlogPostProjects(postId: string): Promise<{ id: string; name: string }[]> {
  return apiFetch(`/blogs/posts/${postId}/projects`);
}

export function addBlogPostToProject(postId: string, projectId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/blogs/posts/${postId}/projects/${projectId}`, { method: "POST" });
}

export function removeBlogPostFromProject(postId: string, projectId: string): Promise<void> {
  return apiFetch(`/blogs/posts/${postId}/projects/${projectId}`, { method: "DELETE" });
}

// ── Blog reimport ──────────────────────────────────────────────────────────────

export function reimportAllBlogPosts(blogId: string): Promise<{ updated: number; errors: number }> {
  return apiFetch(`/blogs/${blogId}/reimport-all`, { method: "POST" });
}

// ── Annotations ───────────────────────────────────────────────────────────────

export function listAnnotations(paperId: string): Promise<Annotation[]> {
  return apiFetch<Annotation[]>(`/papers/${paperId}/annotations`);
}

export function createAnnotation(
  paperId: string,
  body: {
    page_number: number;
    highlighted_text: string;
    color: AnnotationColor;
    note: string;
    position_json: string;
  },
): Promise<Annotation> {
  return apiFetch<Annotation>(`/papers/${paperId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateAnnotation(
  paperId: string,
  annotationId: string,
  body: { note?: string; color?: AnnotationColor },
): Promise<Annotation> {
  return apiFetch<Annotation>(`/papers/${paperId}/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteAnnotation(paperId: string, annotationId: string): Promise<void> {
  const res = await fetch(`${BASE}/papers/${paperId}/annotations/${annotationId}`, {
    method: "DELETE",
    credentials: CREDENTIALS,
  });
  if (!res.ok) throw new Error(`Delete annotation failed ${res.status}`);
}

// ── Research Gaps (T29) ────────────────────────────────────────────────────────

export async function findResearchGaps(
  topic: string,
  projectId?: string,
  paperIds?: string[],
  model?: string
): Promise<{ analysis: string; papers_considered: number; topic: string }> {
  return apiFetch("/research-gaps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      topic, 
      project_id: projectId || null, 
      paper_ids: paperIds || null,
      model: model || "claude"
    }),
  });
}

// ── Venues (T30) ───────────────────────────────────────────────────────────────

export async function listVenues(minCount?: number, q?: string): Promise<VenueOut[]> {
  const params = new URLSearchParams();
  if (minCount !== undefined) params.set("min_count", minCount.toString());
  if (q) params.set("q", q);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch(`/venues${qs}`);
}

export async function getVenuePapers(venueName: string): Promise<Paper[]> {
  return apiFetch(`/venues/${encodeURIComponent(venueName)}/papers`);
}

// ── Natural-language search ───────────────────────────────────────────────────

export interface SearchInterpretResult {
  keyword: string | null;
  tag: string | null;
  topic: string | null;
  venue: string | null;
  year_min: number | null;
  year_max: number | null;
}

export async function interpretSearch(query: string): Promise<SearchInterpretResult> {
  return apiFetch("/search/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

// ── Users / Teammates ─────────────────────────────────────────────────────────

export async function deleteUser(name: string): Promise<void> {
  const res = await fetch(`${BASE}/users/${encodeURIComponent(name)}`, { method: "DELETE", credentials: CREDENTIALS });
  if (!res.ok) throw new Error(`Delete user failed ${res.status}`);
}

export async function renameUser(oldName: string, newName: string): Promise<{ name: string }> {
  return apiFetch(`/users/${encodeURIComponent(oldName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

// ── Claims & Synthesis ─────────────────────────────────────────────────────────

export async function getPaperClaims(paperId: string): Promise<{ claims: Claim[] }> {
  return apiFetch(`/papers/${paperId}/claims`);
}

export async function extractPaperClaims(paperId: string, model?: string): Promise<{ claims: Claim[], count: number }> {
  const params = model ? `?model=${encodeURIComponent(model)}` : "";
  return apiFetch(`/papers/${paperId}/claims/extract${params}`, { method: "POST" });
}

export async function searchClaims(q: string): Promise<{ results: Array<{ claim: Claim, paper: { id: string, title: string } }> }> {
  return apiFetch(`/claims/search?q=${encodeURIComponent(q)}`);
}


export async function synthesizePapers(
  paperIds: string[],
  question: string,
  useWeb: boolean
): Promise<{ synthesis: string; papers_used: Array<{id: string; title: string}> }> {
  return apiFetch("/synthesis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paper_ids: paperIds, question, use_web: useWeb }),
  });
}

// ── Discover (external search) ────────────────────────────────────────────────

export async function discoverSearch(
  q: string,
  source: string = "all",
  limit: number = 20,
): Promise<import("../types").DiscoverSearchResult[]> {
  return apiFetch(`/discover/search?q=${encodeURIComponent(q)}&source=${source}&limit=${limit}`);
}

export async function discoverAdd(url: string, projectId?: string): Promise<T_IngestOut> {
  return apiFetch("/discover/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId ?? null }),
  });
}

// ── Related papers ────────────────────────────────────────────────────────────

export async function getRelatedPapers(
  paperId: string,
  limit: number = 10,
): Promise<{ related: import("../types").RelatedPaper[]; reason?: string; search_keywords?: string[] }> {
  return apiFetch(`/papers/${paperId}/related?limit=${limit}`);
}

// ── Author tracking ───────────────────────────────────────────────────────────

export async function setPersonTracked(personId: string, tracked: boolean): Promise<import("../types").Person> {
  return apiFetch(`/people/${personId}/track`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracked }),
  });
}

export async function getPersonNewPapers(personId: string): Promise<{ new_papers: import("../types").RelatedPaper[] }> {
  return apiFetch(`/people/${personId}/new-papers`);
}

export async function runAuthorTrackerCheck(): Promise<{
  checked: number;
  new_papers_imported: number;
  authors: Array<{ id: string; name: string; papers_imported: number; reason?: string }>;
}> {
  return apiFetch("/author-tracker/check-all", { method: "POST" });
}

// ── People notes ──────────────────────────────────────────────────────────────

export async function getPersonNote(personId: string): Promise<import("../types").Note> {
  return apiFetch(`/people/${personId}/note`);
}

export async function savePersonNote(personId: string, content: string): Promise<import("../types").Note> {
  return apiFetch(`/people/${personId}/note`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── People tags ───────────────────────────────────────────────────────────────

export async function getPersonTags(personId: string): Promise<import("../types").Tag[]> {
  return apiFetch(`/people/${personId}/tags`);
}

export async function addPersonTag(personId: string, name: string): Promise<import("../types").Tag> {
  return apiFetch(`/people/${personId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function removePersonTag(personId: string, tagName: string): Promise<void> {
  await apiFetch(`/people/${personId}/tags/${encodeURIComponent(tagName)}`, { method: "DELETE" });
}

// ── People enrichment ─────────────────────────────────────────────────────────

export async function enrichPerson(personId: string): Promise<{
  person_id: string;
  enriched: boolean;
  orcid_url?: string;
  citation_count?: number;
  affiliation?: string;
  message?: string;
}> {
  return apiFetch(`/people/${personId}/enrich`, { method: "POST" });
}

export async function enrichAllPeople(): Promise<{ status: string; total_people: number }> {
  return apiFetch("/people/enrich-all", { method: "POST" });
}

// ── Merge Manager ──────────────────────────────────────────────────────────

export interface MergePaperSlim {
  id: string;
  title: string;
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  metadata_source?: string | null;
  drive_file_id?: string | null;
}

export interface DuplicatePair {
  paper_a: MergePaperSlim;
  paper_b: MergePaperSlim;
  similarity: number;
  reason: string;
}

export interface ScanResult {
  pairs: DuplicatePair[];
  total_papers: number;
}

export async function scanDuplicates(): Promise<ScanResult> {
  return apiFetch(`/merge/scan`, { method: "POST" });
}

export async function executeMerge(keepId: string, removeId: string): Promise<{ kept_id: string; removed_id: string; relationships_moved: number }> {
  return apiFetch("/merge/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keep_id: keepId, remove_id: removeId }),
  });
}

// ── Concepts ─────────────────────────────────────────────────────────────────

export interface ConceptsList {
  concepts: Concept[];
  backend: ConceptsBackend;
  generation: ConceptGeneration | null;
}

export async function listConcepts(paperId: string): Promise<ConceptsList> {
  return apiFetch(`/papers/${paperId}/concepts`);
}

/** Scan the PDF; with `generate`, every visualisation is then generated in the background. */
export async function detectConcepts(paperId: string, generate = false): Promise<ConceptsList & {
  pages_total: number;
  pages_scanned: number;
}> {
  return apiFetch(`/papers/${paperId}/concepts/detect${generate ? "?generate=true" : ""}`, { method: "POST" });
}

/** Start generating every visualisation that does not exist yet. */
export async function generateAllConcepts(paperId: string): Promise<ConceptsList> {
  return apiFetch(`/papers/${paperId}/concepts/generate`, { method: "POST" });
}

export async function generateConceptViz(paperId: string, conceptId: string, force = false): Promise<Concept> {
  return apiFetch(`/papers/${paperId}/concepts/${conceptId}/viz${force ? "?force=true" : ""}`, { method: "POST" });
}

export async function repairConceptViz(paperId: string, conceptId: string, error: string): Promise<Concept> {
  return apiFetch(`/papers/${paperId}/concepts/${conceptId}/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  });
}
