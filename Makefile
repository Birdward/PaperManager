# PaperManager: everyday commands. Run `make` (or `make help`) to list them.
# Everything runs in Docker via docker-compose.selfhost.yml; data lives in Docker volumes and
# survives stop, restart and rebuild. See CLAUDE.md for how this fork is set up.

SHELL   := /bin/bash
COMPOSE := docker compose -f docker-compose.selfhost.yml
URL     := http://localhost:8080

# Open Docker Desktop if it isn't running, then wait for it.
DOCKER_UP = docker info >/dev/null 2>&1 || { echo "Starting Docker Desktop..."; open -a Docker; \
	until docker info >/dev/null 2>&1; do sleep 2; done; }

# Wait until the app reports Neo4j connected. If Neo4j is stuck (e.g. restart-looping on a stale
# PID file after the laptop was switched off), recreate its container once; data is in the volume.
WAIT_READY = echo "Waiting for PaperManager..."; \
	for i in $$(seq 1 45); do curl -sf $(URL)/health 2>/dev/null | grep -q '"neo4j":"connected"' && break; sleep 2; done; \
	if ! curl -sf $(URL)/health 2>/dev/null | grep -q '"neo4j":"connected"'; then \
		echo "Neo4j is not up yet; recreating its container (your data is safe in the volume)..."; \
		$(COMPOSE) up -d --force-recreate --no-deps neo4j >/dev/null 2>&1; \
		for i in $$(seq 1 60); do curl -sf $(URL)/health 2>/dev/null | grep -q '"neo4j":"connected"' && break; sleep 2; done; \
	fi; \
	if curl -sf $(URL)/health 2>/dev/null | grep -q '"neo4j":"connected"'; then echo "PaperManager is running: $(URL)"; \
	else echo "PaperManager did not come up. Check: make status, make logs"; exit 1; fi

# The app and Ollama first, then Neo4j with 2 minutes for a clean shutdown (compose's 10 s default
# can end in a kill, which leaves a stale PID file behind).
STOP = $(COMPOSE) stop app ollama && $(COMPOSE) stop -t 120 neo4j

.DEFAULT_GOAL := help
.PHONY: help start stop restart open status logs rebuild reload-env backup restore backups \
	pull-models password test test-frontend upstream

help: ## List the commands
	@echo "PaperManager commands (run from this folder as: make <command>)"
	@echo
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /|/' | awk -F'|' '{printf "  make %-14s %s\n", $$1, $$2}'

# ── Everyday ──────────────────────────────────────────────────────────────────

start: ## Start PaperManager (opens Docker Desktop if needed) and open it in the browser
	@$(DOCKER_UP)
	@$(COMPOSE) up -d
	@$(WAIT_READY)
	@open $(URL)

stop: ## Stop PaperManager and free its memory (all data is kept)
	@$(STOP)
	@echo "PaperManager stopped. Start it again with: make start"

restart: ## Stop and start PaperManager again
	@$(STOP)
	@$(COMPOSE) up -d --force-recreate --no-deps neo4j >/dev/null 2>&1
	@$(COMPOSE) up -d
	@$(WAIT_READY)

open: ## Open PaperManager in the browser
	@open $(URL)

status: ## Show which containers are running and whether the database is connected
	@$(COMPOSE) ps --format 'table {{.Name}}\t{{.Status}}'
	@echo
	@curl -s $(URL)/health 2>/dev/null || echo "The app is not responding."
	@echo

logs: ## Follow the app's logs (Ctrl+C to stop following)
	@$(COMPOSE) logs -f --tail 100 app

# ── After changing things ─────────────────────────────────────────────────────

rebuild: ## Rebuild and restart after code changes or a git pull/merge
	@$(DOCKER_UP)
	@$(COMPOSE) up -d --build
	@$(WAIT_READY)

reload-env: ## Apply .env changes (e.g. a new Claude token) without rebuilding
	@$(COMPOSE) up -d --force-recreate app
	@$(WAIT_READY)

# ── Backups ───────────────────────────────────────────────────────────────────

backup: ## Back up the database to ~/Documents/PaperManager-backups (keeps 5)
	@./backup.sh

backups: ## List the backups
	@ls -lht ~/Documents/PaperManager-backups/*.dump 2>/dev/null || echo "No backups yet. Run: make backup"

restore: ## Replace the database with a backup: make restore FILE=path/to/file.dump
	@test -n "$(FILE)" || { echo "Usage: make restore FILE=~/Documents/PaperManager-backups/<file>.dump"; exit 1; }
	@./backup.sh restore "$(FILE)"

# ── Occasionally ──────────────────────────────────────────────────────────────

pull-models: ## Download the embedding model (only if the Ollama volume was deleted)
	@$(COMPOSE) exec ollama ollama pull nomic-embed-text

password: ## Change the login password of the owner account (at least 8 characters)
	@$(COMPOSE) exec app python scripts/create_default_user.py

upstream: ## Show new commits in Niklas's repo that this fork doesn't have yet
	@git fetch -q upstream
	@git log --oneline --no-merges HEAD..upstream/main | sed 's/^/  /'
	@echo "($$(git rev-list --count HEAD..upstream/main) new upstream commits; see CLAUDE.md, 'Re-syncing with upstream')"

# ── Development ───────────────────────────────────────────────────────────────

test: ## Run the backend tests in a throwaway container (about 40 fail without a test database; upstream too)
	@docker run --rm -v "$(CURDIR)/backend":/app -v "$(CURDIR)/prompts":/prompts -w /app \
		-e NEO4J_URI=bolt://localhost:1 papermanager-app python -m pytest -q -p no:cacheprovider

test-frontend: ## Run the frontend tests in a throwaway Node container
	@docker run --rm -v "$(CURDIR)/frontend":/app -w /app node:20-alpine sh -c "npm ci --no-audit --no-fund >/dev/null && npx vitest run"
