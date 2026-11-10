.PHONY: api load load-record load-image
api:
	cargo run --quiet -p fukulow-server --bin openapi > openapi.json
	npx --yes --package=openapi-typescript@7.13.0 openapi-typescript openapi.json --root-types --root-types-no-schema-prefix -o web/src/api-schema.d.ts

K6_IMAGE := grafana/k6:1.8.2
LOAD_DOCKER_NETWORK ?= host
BASE_URL ?= http://127.0.0.1:8080
LOAD_NOFILE ?= 65536
LOAD_CONTAINER_NAME ?=

# Quote make-expanded values as single shell arguments, including embedded apostrophes.
shell_quote = '$(subst ','"'"',$(1))'

# Linux uses host networking; on macOS use LOAD_DOCKER_NETWORK=bridge BASE_URL=http://host.docker.internal:8080.
# Credentials/settings are passed from the environment, never put in the image or result artifacts.
load:
	docker run --rm $(if $(LOAD_CONTAINER_NAME),--name $(call shell_quote,$(LOAD_CONTAINER_NAME))) \
		--network $(call shell_quote,$(LOAD_DOCKER_NETWORK)) --ulimit $(call shell_quote,nofile=$(LOAD_NOFILE):$(LOAD_NOFILE)) \
		-v $(call shell_quote,$(CURDIR):/work:ro) -w /work \
		-e $(call shell_quote,BASE_URL=$(BASE_URL)) -e LOAD_EMAIL -e LOAD_PASSWORD -e LOAD_ORGANIZATION_ID \
		-e LOAD_BOOTSTRAP -e LOAD_SETUP_TOKEN -e CHANNELS -e SUBSCRIBERS -e PUBLISHERS \
		-e DURATION_SECONDS -e PUBLISH_INTERVAL_MS -e READY_TIMEOUT_SECONDS -e DRAIN_TIMEOUT_SECONDS \
		-e CHANNEL_VISIBILITY -e SOCKETS_PER_SESSION -e LOAD_MEASURE \
		-e LOAD_LEGACY -e LOAD_ALLOW_REJECTIONS -e LOAD_RECONNECT -e CONNECT_BATCH \
		-e CONNECT_INTERVAL_MS -e REQUEST_TIMEOUT_SECONDS -e PUBLISH_CHANNELS $(call shell_quote,$(K6_IMAGE)) run load/scenario.ts

# Isolated Docker baseline with resource/SQL snapshots; artifacts default to /private/tmp.
load-record:
	node load/record.ts

load-image:
	@echo $(call shell_quote,$(K6_IMAGE))
