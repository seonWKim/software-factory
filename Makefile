# Developer convenience wrapper around the factory CLI (src/main.ts).
# Optional: everything here is also available as `npm run factory -- <cmd>`.
#
#   make status ID=wi_abc          one item's state_changes trail
#   make setup ARGS=--rotate-github  pass flags through to the command

.DEFAULT_GOAL := help
.PHONY: help setup dev controller worker ui status doctor canary

FACTORY := npm run factory --
ID ?=
ARGS ?=

# `npm run setup` takes extra flags only after `--`.
SETUP_ARGS = $(if $(strip $(ARGS)),-- $(ARGS))

# The command line for a factory command, without trailing spaces.
factory = $(strip $(FACTORY) $(1) $(ARGS))

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## One-time setup (ARGS=--rotate-github or --rotate-claude to replace a token)
	$(strip npm run setup $(SETUP_ARGS))

dev: ## Controller + worker in one process
	$(call factory,dev)

controller: ## Intake, run outcomes, reaper
	$(call factory,controller)

worker: ## Claims and executes agent runs
	$(call factory,worker)

ui: ## Read-only dashboard at http://127.0.0.1:4310/ (run beside dev)
	$(call factory,ui)

status: ## Work items, or one item's trail with ID=<work item id>
	$(call factory,status $(ID))

doctor: ## Check setup without printing any secret
	$(call factory,doctor)

canary: ## G6: a real agent tries to find a planted canary secret
	$(call factory,canary)
