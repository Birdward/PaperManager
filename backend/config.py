from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# .env lives at the project root (one level above backend/)
_ENV_FILE = Path(__file__).parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Every endpoint except login, logout, health and the API docs needs a valid session.
    # Only the test suite turns this off (tests/conftest.py).
    require_login: bool = True

    # Neo4j
    neo4j_uri: str = ""
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""
    # Connection pool must be >= server_threadpool_size so threads never block
    # waiting for a DB connection under heavy upload/query load.
    neo4j_max_pool_size: int = 200

    # Size of the AnyIO threadpool that serves sync endpoints (incl. /auth/login
    # and the long-running /papers/upload pipeline). Must stay large enough that
    # a few slow uploads can never starve login of a worker thread.
    server_threadpool_size: int = 200

    # Where PDFs and figures go: "drive" (Google Drive) or "local" (LOCAL_STORAGE_DIR)
    storage_mode: str = "drive"
    local_storage_dir: str = "/data/files"

    # Google Drive
    google_client_id: str = ""
    google_client_secret: str = ""
    google_drive_folder_id: str = ""
    google_credentials_file: str = ""
    google_token_file: str = ""
    # Contents of token.json, for hosts without a persistent disk (Heroku).
    google_token_json: str = ""

    # Anthropic (personal)
    anthropic_api_key: str = ""

    # Anthropic (work / Foundry enterprise gateway)
    anthropic_work_api_key: str = ""
    anthropic_work_base_url: str = ""

    # Claude Code on a Claude subscription (services/claude_code_chat.py).
    # Comma-separated usernames allowed to pick the "claude-code" model; empty
    # disables it. A subscription is personal — list only its owner.
    claude_code_users: str = ""
    # Long-lived token from `claude setup-token`; unset falls back to ~/.claude login.
    claude_code_oauth_token: str = ""

    # App
    backend_port: int = 8000
    frontend_url: str = "http://localhost:5173"
    jwt_secret_key: str = ""
    trusted_hosts: str = "localhost,127.0.0.1"
    trust_proxy_headers: bool = False

    # API hardening
    rate_limit_enabled: bool = True
    rate_limit_default_requests: int = 120
    rate_limit_default_window_seconds: int = 60
    rate_limit_auth_requests: int = 10
    rate_limit_auth_window_seconds: int = 60
    rate_limit_exempt_paths: str = "/docs,/redoc,/openapi.json"
    rate_limit_auth_paths: str = "/auth/login,/auth/register,/auth/admin/create-user"

    # LiteLLM proxy (replaces local Ollama)
    litellm_endpoint: str = ""
    litellm_api_key: str = ""
    litellm_model: str = "google/gemma-4-26b-a4b-it"
    # Empty = embeddings disabled. The proxy currently exposes no embedding
    # model (nomic-embed-text 404s), so calling it just wastes ~1s per upload
    # and logs an error. Set to a valid model id to re-enable.
    litellm_embed_model: str = ""
    # Embeddings from their own OpenAI-compatible endpoint (e.g. Ollama at http://ollama:11434),
    # so they work without LITELLM_ENDPOINT, which would move chat_completion off Claude Code.
    # Empty = embeddings go through the LiteLLM proxy.
    embed_endpoint: str = ""
    embed_api_key: str = ""
    # Map new project papers into the project concept map with Gemma in the background.
    concept_map_auto: bool = True

    # Optional Semantic Scholar API key: raises the shared anonymous rate limit
    # that otherwise 429s reference lookups during bulk imports.
    semantic_scholar_api_key: str = ""

    # Docling: "local" (in-process, needs docling package), "on_demand" (GPU via Inference Manager)
    # or "off" (pypdf figure extraction only, no chapter detection)
    docling_mode: str = "on_demand"
    inference_manager_url: str = ""
    docling_remote_host: str = ""
    docling_host_port: int = 8004
    docling_ready_timeout: int = 600
    docling_serve_url: str = ""  # optional always-on docling-serve (skips spin-up)
    # Docling rendering scale used to generate page and picture images.
    # Roughly, images_scale=2.0 corresponds to ~144 DPI in our pipeline.
    docling_images_scale: float = 2.0

    # SSL — set SSL_VERIFY=false or point SSL_CA_BUNDLE to corporate CA cert
    ssl_verify: bool = True
    ssl_ca_bundle: str = ""  # path to .pem file, e.g. /etc/ssl/certs/corporate.pem

    # Default user setup
    default_user_name: str = "niklas"
    default_user_password: str = ""


settings = Settings()
