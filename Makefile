.PHONY: api
api:
	cargo run --quiet -p fukulow-server --bin openapi > openapi.json
	npx --yes --package=openapi-typescript@7.13.0 openapi-typescript openapi.json --root-types --root-types-no-schema-prefix -o web/src/api-schema.d.ts
