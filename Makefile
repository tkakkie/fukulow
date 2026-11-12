.PHONY: api load load-record load-throughput load-image load-signin
api:
	cargo run --locked --quiet -p fukulow-server --bin openapi > openapi.json
	npx --yes --package=openapi-typescript@7.13.0 openapi-typescript openapi.json --root-types --root-types-no-schema-prefix -o web/src/api-schema.d.ts

K6_IMAGE := grafana/k6:1.8.2
LOAD_DOCKER_NETWORK ?= host
# Default Compose Caddy endpoint; set BASE_URL to the deployed FUKULOW_DOMAIN URL.
BASE_URL ?= https://localhost
LOAD_NOFILE ?= 65536
LOAD_SCRIPT ?= load/scenario.ts
LOAD_CONTAINER_NAME ?=

# Quote make-expanded values as single shell arguments, including embedded apostrophes.
shell_quote = '$(subst ','"'"',$(1))'

# Linux uses host networking. For nginx set BASE_URL=http://localhost.
# Caddy's localhost certificate needs K6_INSECURE_SKIP_TLS_VERIFY=true for local checks.
# On macOS use LOAD_DOCKER_NETWORK=bridge and a proxy URL reachable from Docker
# (e.g. BASE_URL=http://host.docker.internal for the nginx profile).
# Credentials/settings are passed from the environment, never put in the image or result artifacts.
load:
	docker run --rm $(if $(LOAD_CONTAINER_NAME),--name $(call shell_quote,$(LOAD_CONTAINER_NAME))) \
		--network $(call shell_quote,$(LOAD_DOCKER_NETWORK)) --ulimit $(call shell_quote,nofile=$(LOAD_NOFILE):$(LOAD_NOFILE)) \
		-v $(call shell_quote,$(CURDIR):/work:ro) -w /work \
		-e $(call shell_quote,BASE_URL=$(BASE_URL)) -e LOAD_EMAIL -e LOAD_PASSWORD -e LOAD_ORGANIZATION_ID \
		-e LOAD_BOOTSTRAP -e LOAD_SETUP_TOKEN -e CHANNELS -e SUBSCRIBERS -e PUBLISHERS \
		-e K6_INSECURE_SKIP_TLS_VERIFY \
		-e DURATION_SECONDS -e PUBLISH_INTERVAL_MS -e READY_TIMEOUT_SECONDS -e DRAIN_TIMEOUT_SECONDS \
		-e CHANNEL_VISIBILITY -e SOCKETS_PER_SESSION -e LOAD_MEASURE \
		-e LOAD_LEGACY -e LOAD_ALLOW_REJECTIONS -e LOAD_RECONNECT -e LOAD_RECONNECT_STORM -e CONNECT_BATCH \
		-e CONNECT_INTERVAL_MS -e REQUEST_TIMEOUT_SECONDS -e PUBLISH_CHANNELS \
		-e THROUGHPUT_SCENARIO -e THROUGHPUT_RATES -e THROUGHPUT_STEP_SECONDS -e THROUGHPUT_MEMBERS \
		-e THROUGHPUT_VUS -e THROUGHPUT_MAX_VUS $(call shell_quote,$(K6_IMAGE)) run $(call shell_quote,$(LOAD_SCRIPT))

# Isolated Docker baseline with resource/SQL snapshots; artifacts default to /private/tmp.
load-record:
	node load/record.ts

# Stepped open-model writes; THROUGHPUT_SCENARIO=many (default) or hot.
load-throughput:
	LOAD_SCRIPT=load/throughput.ts node load/record.ts

load-image:
	@echo $(call shell_quote,$(K6_IMAGE))

# Isolated sign-in before/after measurement; test-only seed, no external credentials.
# SERVER_REF: archive/build any local git ref; omit for this working tree (incl. edits).
# LOAD_APP_IMAGE: existing server image instead of a source build (exclusive with SERVER_REF).
# LOAD_PORT=18096; LOAD_RESULT_DIR defaults to OS temp, must be outside this checkout.
# SIGNIN_CONCURRENCY=64: maximum in-flight sign-ins; SIGNIN_RATE=100: offered starts/s.
# SIGNIN_SECONDS=60; SIGNIN_READ_RATE=2: Organization B authenticated GETs/s (cap 4 in flight).
# SIGNIN_ACCOUNTS=1000: each known/correct seed pool; SIGNIN_CORRECT_EVERY=10: every Nth is correct.
# Remaining attempts alternate wrong known / unique unknown emails; SIGNIN_IP_POOL=10000.
# IPs rotate through a trusted synthetic header in this disposable stack only; pool=1 tests IP throttle.
# SIGNIN_TIMEOUT_SECONDS=45 bounds requests/drain. At concurrency cap, starts are counted as dropped.
# Artifacts: metadata.json + results.json (status 0 = transport failure), no response bodies/credentials.
# Latency is full HTTP round trip, nearest-rank p50/p95/p99, all/success/per-status/per-kind.
# CPU/RSS + admin pg_stat_activity sample about every 2s during scheduling/drain; sampled peaks only.
# DB in-use = app-role client connections incl. idle; active is also reported, sampler excluded.
load-signin:
	node load/signin.ts
