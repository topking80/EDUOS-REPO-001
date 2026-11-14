# EduOS District Edition — local evaluation shortcuts (32.1.0).
# Production deployment: README.md ("Deploy") and docs/UPGRADING-32.1.0.md.
# Edge OS images live in edge-platform/eduos/ (separate Makefile).
DEV_ENV ?= .env.dev
DC = EDUOS_ENV_FILE=$(DEV_ENV) docker compose --env-file $(DEV_ENV) -f docker-compose.yml -f docker-compose.dev.yml --profile edge


.PHONY: eden-sim eden-sim-down
.PHONY: up down down-volumes logs ps seed smoke smoke-browser smoke-mobile smoke-safety smoke-learning edal-verify retention notify metrics trust-ca test test-integration check
up:            ## build, start, migrate, seed; prints URL and demo logins
	./scripts/dev-up.sh
down:          ## stop the stack, keep data
	./scripts/dev-down.sh
down-volumes:  ## stop and delete database, Caddy CA and .env.dev
	./scripts/dev-down.sh --volumes
logs:
	$(DC) logs -f --tail 100
ps:
	$(DC) ps
seed:
	$(DC) --profile seed run --rm seed
retention:     ## run the retention job once (owner role), as an operator would from cron
	$(DC) --profile ops run --rm retention
notify:        ## 32.4.0: process the notification outbox once (adapters are off/dry-run; nothing is sent)
	$(DC) --profile ops run --rm notify
smoke:         ## end-to-end HTTP smoke test against the running stack
	./scripts/smoke.sh
smoke-browser: ## headless-browser smoke test + screenshots (needs Chrome/Chromium + playwright-core)
	./scripts/smoke.sh --browser
smoke-mobile:  ## 32.4.0: HTTP smoke + phone-size role-app browser pass with axe and screenshots
	./scripts/smoke.sh --mobile
smoke-safety:  ## 32.5.0: HTTP smoke + SafetyOS lockdown drill and car pick-up phone pass (axe, screenshots)
	./scripts/smoke.sh --safety
smoke-learning: ## 32.6.0: HTTP smoke + courses, quizzes, gradebook, family progress and EDAL phone pass (axe, screenshots)
	./scripts/smoke.sh --learning
edal-verify:   ## 32.6.0: verify the EDAL records ledger hash chain (owner role, read-only). ARGS="--checkpoint file.json"
	$(DC) --profile ops run --rm retention node src/edal-verify.js $(ARGS)
eden-sim:      ## 32.7.0: two simulated school nodes: partition, offline queue, failover + handback (screenshots)
	./scripts/eden-sim.sh
eden-sim-down: ## 32.7.0: stop the simulated school nodes (keep data); ARGS=--down-volumes to delete it
	./scripts/eden-sim.sh $(or $(ARGS),--down)
metrics:       ## print the app's Prometheus metrics (internal port, METRICS_TOKEN from the env file)
	$(DC) exec -T app sh -c 'wget -qO- --header "Authorization: Bearer $$METRICS_TOKEN" http://127.0.0.1:8080/metrics'
trust-ca:      ## copy Caddy's local root CA to ./caddy-local-root.crt (import it into your OS/browser)
	$(DC) cp edge:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt && echo "wrote caddy-local-root.crt"
test:
	npm test
test-integration:
	npm run test:integration
check:
	$(MAKE) -C edge-platform/eduos check
