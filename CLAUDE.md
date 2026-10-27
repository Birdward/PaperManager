# CLAUDE.md

Edward's personal fork of Niklas Abraham's PaperManager. It runs locally for Edward's own research
use, and he will keep adapting it to his needs. The codebase, `README.md`, `docs/` and `.specs/`
describe the app as Niklas built it. This file only covers how this fork differs from that and
what was learned while setting it up.

## Repo and branches

- `origin` is Edward's fork (`Birdward/PaperManager`). `upstream` is Niklas's repo
  (`NiklasAbraham/PaperManager`). Never push to `upstream`.
- `main` is the unmodified upstream state at fork time (`1cc489f`). All of Edward's changes live
  on `feature/customise`.
- Commit only when Edward asks. Nothing has been pushed to `origin` yet.

## How this instance is set up (and why)

It runs in Docker on Edward's Mac via `docker-compose.selfhost.yml`
(http://localhost:8080). Everything AI goes through a Claude subscription. There is no API key and
no LiteLLM. Docling runs locally in the app container, and embeddings come from an Ollama
container.

| Area | Setting | Why |
|---|---|---|
| AI | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `CLAUDE_CODE_USERS=edward` | Subscription only, no `ANTHROPIC_API_KEY` |
| Account | The token is from Edward's **work** Claude account, part of Anthropic's life-science programme | Reduced bio safeguards and access to Mythos. Opus 5.5's stronger safeguards on his personal account stopped protein–ligand structure answers partway through |
| LiteLLM | `LITELLM_ENDPOINT` empty | Not wanted. Everything that would use it runs on Claude Code instead |
| Storage | `STORAGE_MODE=local`, `LOCAL_STORAGE_DIR=/data/files` | No Google Drive. Edward chose local disk over setting up Google OAuth |
| Docling | `DOCLING_MODE=local` | Figures, tables and chapters. pypdf (the `off` fallback) found 2 figures per paper against Docling's 12–14. Docling takes about 30–50 s and peaks around 3.4 GB per paper. Processing time doesn't matter to Edward (uploads can run overnight) |
| Embeddings | `EMBED_ENDPOINT=http://ollama:11434`, `LITELLM_EMBED_MODEL=nomic-embed-text` | Semantic search (Knowledge Chat's pre-fetch and `semantic_search` tool). It uses the 768-dimensional size the `paper_embeddings` index expects. Never set `LITELLM_ENDPOINT` to get embeddings: that would move every `chat_completion` off Claude Code |
| Login | User `edward` (owner and admin) | Edward chose a short, weak password. Ask him for it. It was set directly in the database, bypassing the 8-character check in `create_default_user.py` |
| Network | Port bound to `127.0.0.1:8080` | Because the password is weak. Don't expose it beyond localhost |

`.env` (git-ignored) holds the real values. Its Neo4j password and JWT secret were generated
locally. Never print the token: compare fingerprints (`shasum`) instead.

## Changes this fork makes to upstream

These are the four commits on `feature/customise`. Keep them in mind when re-syncing.

1. **`3d56d10` Subscription only, local storage, Docling off**
   - `services/litellm_client.py`: `chat_completion` routes to Claude Code (Sonnet) when no
     LiteLLM endpoint is set. About 30 call sites (summaries, topics, tags, metadata, references,
     concept map, the "Gemma (LiteLLM)" UI options) depend on this.
   - `services/ai.py`: `_subscription_instead_of_key()` sends requests for the personal `claude`
     model to Claude Code when there is no API key. It covers Knowledge Chat, paper chat, chapter
     summaries, claims, research gaps, synthesis and `_condense_paper_for_budget`.
   - `services/claude_code_chat.py`: `complete_claude_code()` (a tool-less text turn) and
     `subscription_fallback_available()`. Background jobs with no request user count as the
     owner's.
   - `services/drive.py`: the local storage backend. File ids are `local-<hex>.pdf|png`, so reads
     and deletes go to the right backend whatever the current mode.
   - `DOCLING_MODE=off` handling in `figure_extractor.py` and `book_chapter_parser.py`.
   - `docker-compose.selfhost.yml`: an `app_files` volume, Drive mounts commented out, port bound
     to localhost.
   - `PaperDetail.tsx`: the Drive link is hidden for local files.
2. **`bd3ce9c`** Knowledge Chat (frontend): once an answer has finished, a concept or structure
   card whose text is invalid shows "card cut off" with its raw text, instead of a permanent
   placeholder.
3. **`16995d6`** `claude_code_chat._run`: if a new text block starts while a ``` fence is open,
   the fence is closed first. A safety refusal mid-card, followed by Claude Code's automatic
   fallback model, otherwise swallowed the rest of the answer.
4. **`027e446`** `App.tsx`: the hidden navbar on `/knowledge` ignores the pointer. Its translated
   layout box covered the chat's top bar and blocked "+ New".

5. **Embeddings, Docling and figures backfill** (the commit after `CLAUDE.md`)
   - `config.py` and `services/litellm_client.py`: `EMBED_ENDPOINT` / `EMBED_API_KEY` and
     `_embed_client()`. `embed_text` uses its own endpoint when one is set.
   - `routers/backfill.py`: the figures backfill was broken upstream. It looped over
     `extract_figures`' dict result as if it were a list of figures. It now calls
     `save_figures_and_tables`, like uploads do.
   - `docker-compose.selfhost.yml`: an `ollama` service (pinned to `0.40.11`) and the
     `hf_cache` volume for Docling's models.

Fixes 2–4 do nothing unless something has gone wrong. Keep them even though the life-science
account should avoid the refusals.

## Re-syncing with upstream

Niklas said he would push bug fixes. To bring them in:

1. `git fetch upstream`
2. Review `git log feature/customise..upstream/main`.
3. Merge (or rebase) into `feature/customise`.

The files most likely to conflict are the ones listed above: `services/ai.py`,
`services/litellm_client.py`, `services/claude_code_chat.py`, `services/drive.py`, `config.py`,
`docker-compose.selfhost.yml`, `App.tsx`, `KnowledgeChat.tsx` and `kchat/Markdown.tsx` /
`ConceptBlock.tsx`.

After merging, check these, because new upstream code can silently bypass this fork's setup:

- New direct uses of `_personal_client()`, `anthropic.Anthropic(...)` or `get_litellm_client()`.
  These won't fall back to the subscription. Route them through `chat_completion` or
  `_subscription_instead_of_key()`.
- New Google Drive calls outside `services/drive.py`'s public functions.
- New Docling entry points that don't respect `DOCLING_MODE=off`.
- Changes to `.env.example` or `config.py` that need matching entries in `.env`.
- New embedding call sites that use `get_litellm_client()` instead of `embed_text`.

## Running, testing and debugging

- **Edward runs everything through the `Makefile`** (`make` lists the commands: start, stop,
  restart, status, logs, rebuild, reload-env, backup, restore, pull-models, password, upstream,
  test). Keep it in sync when adding operational commands. `make stop` stops the app and Ollama
  first, then Neo4j with `-t 120`. `make start` and `make restart` recreate the Neo4j container
  if it doesn't come up (the stale-PID loop).
- `deploy/selfhost/start.sh` traps SIGTERM and passes it on to uvicorn and nginx. As PID 1 it
  used to ignore it, so every `docker stop` of the app waited the full timeout (2 min with `-t 120`).

- **Nothing runs on the Mac directly.** It has no Node or conda, and its system Python is 3.9 (the
  app needs 3.11). Everything runs in Docker.
- **Code is baked into the image**, not mounted. After a code change, run
  `docker compose -f docker-compose.selfhost.yml up -d --build`. After a `.env`-only change, run
  `up -d --force-recreate app`.
- **Backend tests: never run pytest in the running `app` container.** Its environment has
  `STORAGE_MODE=local`, and tests wrote dummy files into the real `app_files` volume. The tests
  also refuse to use the live Neo4j. Run them in a throwaway container instead:
  `docker run --rm -v "$PWD/backend":/app -v "$PWD/prompts":/prompts -w /app -e NEO4J_URI=bolt://localhost:1 papermanager-app python -m pytest -q -p no:cacheprovider`.
  About 40 tests fail without a test database. Upstream fails the same 40, so compare failure
  lists against `main` rather than expecting zero.
- **Frontend tests:**
  `docker run --rm -v "$PWD/frontend":/app -w /app node:20-alpine sh -c "npm ci && npx vitest run"`.
  `npx tsc -b` reports 25 errors, identical on `main` (upstream's).
  The Docker build doesn't run tsc.
- **End-to-end checks:** log in with curl, then upload `backend/tests/fixtures/attention.pdf` (a
  one-page stub). Delete any test papers and conversations afterwards, since this is Edward's real
  library.
- **Claude Code session logs** are in the container at `/root/.claude/projects/-tmp/*.jsonl`, with
  `stop_reason`, model and usage per turn. They are the way to tell a safety refusal
  (`stop_reason: refusal`, then a `model_refusal_fallback` system event) from other failures.
  They are wiped whenever the container is recreated.
- **Which account a token belongs to can't be checked from the container.** Tokens from
  `claude setup-token` are inference-only (the profile endpoint returns 403 for missing scope).
  Edward checks by watching his claude.ai usage.

## Things to know before changing behaviour

- **Models** are CLI aliases: `opus` for Knowledge Chat and paper chat (`CLAUDE_CODE_MODEL`),
  `sonnet` for background work, concepts, the tour and `complete_claude_code`, and `haiku` for
  condensing papers. Mythos is available on the account but not wired in. Check the model name
  Claude Code accepts before switching; don't guess.
- **Ollama setup:** after creating the `ollama_models` volume for the first time, pull the model
  once with `docker compose -f docker-compose.selfhost.yml exec ollama ollama pull nomic-embed-text`.
  Existing papers get figures and embeddings from the Settings page's backfill buttons
  (`POST /backfill/figures`, `POST /backfill/embeddings`). Embeddings are only made for papers
  with an abstract or summary, so reference stubs are skipped.
- **Figure questions, research gaps and synthesis** run on Claude Code (Opus) without an API key.
  `complete_claude_code(..., image_png=...)` sends the figure image. `use_web=True` allows the
  WebSearch tool: research gaps always uses it, and synthesis when its `use_web` is set. When
  LiteLLM isn't configured, research gaps' default "Gemma" option is routed to this Claude path.
  These calls take 55–75 s, so `frontend/nginx.conf` gives `/synthesis` and `/research-gaps`
  `proxy_read_timeout 600s` (nginx's 60 s default returned 504s). Give any other slow, non-streaming
  route the same treatment. UI labels still say "Gemma (LiteLLM)" for options that run on Claude.
- **`_condense_paper_for_budget`** asks for `target_tokens * 3` words (45,000). This was
  investigated: the output came back complete and within the 15k-token budget, so it was
  deliberately left alone. Don't add the API path's 4,096-token cap to the subscription path; it
  would truncate the text.
- **Data** is in the Docker volumes `papermanager_neo4j_data` (database) and
  `papermanager_app_files` (PDFs and figures). It survives rebuilds and is deleted only by
  `down -v`. `papermanager_hf_cache` (Docling models, ~0.5 GB) and
  `papermanager_ollama_models` can be re-downloaded. The ingest preprocess cache in `/tmp` is
  disposable.
- **Long PDFs and memory:** local Docling converts PDFs in chunks of
  `figure_extractor.DOCLING_CHUNK_PAGES` (20) pages via `docling_documents()`, for figures and
  chapter detection alike, which share one converter. A 177-page thesis converted in one go grew
  past 6.5 GB and was OOM-killed. Chunked, it peaks around 4.6 GB (figures) to 5.5 GB (figures,
  then chapters in the same process), and page numbers stay the original PDF pages (verified on
  the thesis). Job status files in the preprocess and analysis caches carry a per-process `boot`
  id: a `pending`/`running` job from an earlier process counts as `missing`, so the queue restarts
  it instead of spinning forever. Neo4j has `oom_score_adj: -500` so an OOM kills the app, which
  restarts, rather than the database. There is no memory cap, by Edward's choice.
- **Figure/table numbers** keep thesis/book styles ("3.1", "B.14"); upstream kept only the first
  integer.
- **Backups:** `./backup.sh` stops Neo4j, writes a `neo4j-admin database dump` (about 0.4 MB;
  the volume's ~0.5 GB is mostly preallocated transaction logs) to
  `~/Documents/PaperManager-backups` (synced by Edward's Documents backup), keeps the newest 5,
  and brings Neo4j back as a fresh container. A plain `compose stop`/`start` once left Neo4j
  looping on "Neo4j is already running" (a stale PID file in the container), so the script
  restarts with `up -d --force-recreate --no-deps neo4j`. `./backup.sh restore FILE` loads a
  dump. Restore was verified on a throwaway volume. PDFs (`app_files`) are deliberately not
  included.
- **Restarts:** Docker Desktop is not set to start at login. The containers are
  `restart: unless-stopped`, so opening Docker Desktop brings the app back.
- **Unused upstream pieces:** `.mcp.json` points at `papermanager-backend-1`, the container name in
  Niklas's production stack (here it's `papermanager-app-1`), and `.claude/settings.local.json`
  disables it. `docker-compose.example.yml` is Niklas's production stack and isn't used here.

## Working with Edward

- Verify claims with evidence (logs, measurements, a baseline comparison) before recommending a
  fix. Say plainly when an earlier diagnosis was wrong or a change of ours caused something.
  Edward asks "is this certain?" and expects a checked answer.
- Don't work around Claude's safety systems in code. Account choice is Edward's decision.
