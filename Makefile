.PHONY: api load load-record load-image
api:
	cargo run --quiet -p fukulow-server --bin openapi > openapi.json
	npx --yes --package=openapi-typescript@7.13.0 openapi-typescript openapi.json --root-types --root-types-no-schema-prefix -o web/src/api-schema.d.ts

K6_IMAGE := grafana/k6:1.8.2
LOAD_DOCKER_NETWORK ?= host
# Default Compose Caddy endpoint; set BASE_URL to the deployed FUKULOW_DOMAIN URL.
BASE_URL ?= https://localhost
LOAD_NOFILE ?= 65536
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
		-e CONNECT_INTERVAL_MS -e REQUEST_TIMEOUT_SECONDS -e PUBLISH_CHANNELS $(call shell_quote,$(K6_IMAGE)) run load/scenario.ts

# Isolated Docker baseline with resource/SQL snapshots; artifacts default to /private/tmp.
load-record:
	node load/record.ts

load-image:
	@echo $(call shell_quote,$(K6_IMAGE))
