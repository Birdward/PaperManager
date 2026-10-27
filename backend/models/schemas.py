from typing import Literal
from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    neo4j: str


# ── Papers ────────────────────────────────────────────────────────────────────

class PaperCreate(BaseModel):
    title: str
    year: int | None = None
    doi: str | None = None
    abstract: str | None = None
    venue: str | None = None
    document_type: str | None = None   # "paper" | "book" | "lecture_deck" | "news_article"
    published_date: str | None = None  # ISO date (YYYY-MM-DD); day-level precision for news articles


class PaperUpdate(BaseModel):
    title: str | None = None
    year: int | None = None
    doi: str | None = None
    abstract: str | None = None
    summary: str | None = None
    venue: str | None = None
    metadata_source: str | None = None
    reading_status: str | None = None   # "unread" | "reading" | "read"
    rating: int | None = None           # 1-5
    bookmarked: bool | None = None
    color: str | None = None            # hex color string or named color
    document_type: str | None = None   # "paper" | "book" | "lecture_deck" | "news_article"
    published_date: str | None = None  # ISO date (YYYY-MM-DD)


class PaperOut(BaseModel):
    id: str
    title: str
    year: int | None = None
    doi: str | None = None
    abstract: str | None = None
    summary: str | None = None
    drive_file_id: str | None = None
    citation_count: int | None = None
    metadata_source: str | None = None
    created_at: str
    venue: str | None = None
    reading_status: str | None = None
    rating: int | None = None
    bookmarked: bool | None = None
    color: str | None = None
    document_type: str | None = None   # "paper" | "book" | "lecture_deck" | "news_article"
    published_date: str | None = None  # ISO date (YYYY-MM-DD)
    added_by: str | None = None
    added_by_color: str | None = None


# ── People ────────────────────────────────────────────────────────────────────

class PersonCreate(BaseModel):
    name: str
    affiliation: str | None = None
    email: str | None = None
    bio: str | None = None
    phone: str | None = None
    orcid_url: str | None = None
    scholar_url: str | None = None
    linkedin_url: str | None = None
    website_url: str | None = None
    skills: str | None = None          # JSON-encoded list of strings
    startup_roles: str | None = None   # JSON-encoded list of {name, role, active}


class PersonUpdate(BaseModel):
    name: str | None = None
    affiliation: str | None = None
    email: str | None = None
    bio: str | None = None
    phone: str | None = None
    orcid_url: str | None = None
    scholar_url: str | None = None
    linkedin_url: str | None = None
    website_url: str | None = None
    skills: str | None = None
    startup_roles: str | None = None


class PersonOut(BaseModel):
    id: str
    name: str
    affiliation: str | None = None
    email: str | None = None
    tracked: bool | None = None
    s2_author_id: str | None = None
    citation_count: int | None = None
    bio: str | None = None
    phone: str | None = None
    orcid_url: str | None = None
    scholar_url: str | None = None
    linkedin_url: str | None = None
    website_url: str | None = None
    skills: str | None = None
    startup_roles: str | None = None
    last_enriched_at: str | None = None


class PersonEnrichOut(BaseModel):
    person_id: str
    enriched: bool
    orcid_url: str | None = None
    scholar_url: str | None = None
    citation_count: int | None = None
    affiliation: str | None = None
    message: str | None = None


class AuthorLink(BaseModel):
    person_id: str


class InvolvesLink(BaseModel):
    person_id: str
    role: str
    years_known: str | None = None  # e.g. "1", "2", "3", "5+"


class SpecialtyLink(BaseModel):
    topic_name: str


# ── Tags & Topics ─────────────────────────────────────────────────────────────

class TagBody(BaseModel):
    name: str


class TopicBody(BaseModel):
    name: str


# ── Projects ──────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    status: str = "active"


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    status: str | None = None


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    status: str | None = None
    created_at: str


class ProjectPaperLink(BaseModel):
    paper_id: str


class ProjectMemberAdd(BaseModel):
    username: str
    role: Literal["read", "write", "admin"] = "read"


class ProjectMemberUpdate(BaseModel):
    role: Literal["read", "write", "admin"]


class ProjectMemberOut(BaseModel):
    username: str
    user_id: str
    color: str | None = None
    role: str
    joined_at: str
    updated_at: str | None = None


# ── Notes ─────────────────────────────────────────────────────────────────────

class NoteBody(BaseModel):
    content: str


class NoteOut(BaseModel):
    id: str
    content: str
    created_at: str
    updated_at: str


# ── Ingestion ──────────────────────────────────────────────────────────────────

class IngestOut(PaperOut):
    drive_url: str | None = None
    authors: list[str] = []
    topics_auto_added: list[str] = []
    references_found: list[dict] = []
    pdf_fetched: bool = True  # False when no PDF was downloaded (metadata-only ingest)


class IngestFromUrlBody(BaseModel):
    url: str
    project_id: str | None = None
    debug: bool = False
    summary_instructions: str | None = None


# ── References ─────────────────────────────────────────────────────────────────

class ReferenceOut(BaseModel):
    id: str | None = None
    title: str
    year: int | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    authors: list[str] = []


class ReferencesBody(BaseModel):
    references: list[dict]


# ── Chat ───────────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str   # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    question: str
    history: list[ChatMessage] = []
    model: str = "litellm"  # "claude" | "claude-work" | "claude-code" | "litellm"
    conversation_id: str | None = None


class ChatResponse(BaseModel):
    answer: str
    conversation_id: str | None = None


# ── Knowledge Chat ──────────────────────────────────────────────────────────────

class KnowledgeChatRequest(BaseModel):
    question: str
    history: list[ChatMessage] = []
    model: str = "claude"
    conversation_id: str | None = None
    use_web: bool = True
    # Library papers attached in the composer: always loaded into context.
    paper_ids: list[str] = []


class ConversationOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    compacted: bool = False
    message_count: int = 0
    # Forks ("strands"): the conversation this one was copied from, how many
    # of its questions were inherited, and the first question asked since.
    parent_id: str | None = None
    fork_at: int | None = None
    fork_kind: str | None = None
    branch_label: str | None = None


class MessagePaper(BaseModel):
    id: str
    title: str | None = None
    year: int | None = None


class MessageOut(BaseModel):
    id: str
    role: str
    content: str
    tokens_used: int | None = None
    created_at: str
    paper_refs: list[str] = []
    papers: list[MessagePaper] = []
    # Concept cards generated from this answer (services/chat_concepts.py).
    concepts: list[dict] | None = None
    concepts_status: str | None = None
    concepts_error: str | None = None
    # Set on a question whose answer failed (the stream may have been lost).
    answer_error: str | None = None


# ── Figures ──────────────────────────────────────────────────────────────────

class FigureOut(BaseModel):
    id: str
    paper_id: str
    figure_number: int | str | None = None
    caption: str | None = None
    drive_file_id: str
    drive_url: str | None = None
    page_number: int
    created_at: str


class TableOut(BaseModel):
    id: str
    paper_id: str
    table_number: int | str | None = None
    caption: str | None = None
    markdown_content: str
    page_number: int
    created_at: str


# ── Chapters (book support) ──────────────────────────────────────────────────

class ChapterOut(BaseModel):
    id: str
    paper_id: str
    number: int
    title: str
    level: int                # 1 = chapter, 2 = sub-chapter
    summary: str | None = None
    start_page: int | None = None
    end_page: int | None = None
    created_at: str
    updated_at: str


class ChapterDetectRequest(BaseModel):
    use_ai: bool = False      # when True, also run AI-based chapter detection
    model: str | None = None  # Ollama model for summaries; None = server default


class ChapterSummarizeRequest(BaseModel):
    model: str | None = None  # Ollama model; None = server default


class ChapterChatRequest(BaseModel):
    question: str
    history: list[ChatMessage] = []


class FigureChatRequest(BaseModel):
    question: str
    model: str = "claude"


class FigureExtractRequest(BaseModel):
    caption_method: str = "litellm"  # "litellm" | "ollama" | "claude-vision"


# ── Blogs ─────────────────────────────────────────────────────────────────────

class BlogRegisterBody(BaseModel):
    url: str


class BlogOut(BaseModel):
    id: str
    name: str
    url: str
    feed_url: str
    description: str | None = None
    parser: str
    created_at: str
    post_count: int = 0


class BlogPostOut(BaseModel):
    id: str
    blog_id: str
    title: str
    url: str
    author: str | None = None
    published_at: str | None = None
    description: str | None = None
    content: str | None = None      # omitted in list views
    summary: str | None = None
    reading_status: str = "unread"  # "unread" | "reading" | "read"
    imported: bool = False
    created_at: str
    updated_at: str
    blog_name: str | None = None    # populated in random / detail


class BlogPostUpdate(BaseModel):
    reading_status: str | None = None
    summary: str | None = None


class BlogPostChatRequest(BaseModel):
    question: str
    history: list[ChatMessage] = []


# ── Annotations ───────────────────────────────────────────────────────────────

AnnotationColor = Literal["yellow", "green", "blue", "red", "purple"]


class AnnotationCreate(BaseModel):
    page_number: int
    highlighted_text: str
    color: AnnotationColor = "yellow"
    note: str = ""
    position_json: str  # JSON string — opaque to backend


class AnnotationUpdate(BaseModel):
    note: str | None = None
    color: AnnotationColor | None = None


class AnnotationOut(BaseModel):
    id: str
    page_number: int
    highlighted_text: str
    color: str
    note: str
    position_json: str
    created_at: str
    updated_at: str


# ── Research Gaps (T29) ───────────────────────────────────────────────────────

class ResearchGapsRequest(BaseModel):
    topic: str
    project_id: str | None = None
    paper_ids: list[str] | None = None
    model: str = "litellm"  # "claude" | "claude-work" | "litellm"


class ResearchGapsResponse(BaseModel):
    analysis: str
    papers_considered: int
    topic: str


# ── Venues (T30) ──────────────────────────────────────────────────────────────

class VenueOut(BaseModel):
    name: str
    count: int
    years: list[int]
