FROM rust:1.99.1-slim@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7 AS rust-base
FROM rust-base AS wasm
WORKDIR /app
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.130 --locked
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
COPY server/test-macros/Cargo.toml server/test-macros/Cargo.toml
COPY api-types/ api-types/
COPY client-core/ client-core/
RUN mkdir -p server/src server/test-macros/src web/wasm \
 && touch server/src/lib.rs server/src/main.rs server/test-macros/src/lib.rs \
 && cargo build --locked --profile wasm-release -p fukulow-client-core --features wasm --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --remove-name-section --remove-producers-section --out-dir web/wasm target/wasm32-unknown-unknown/wasm-release/fukulow_client_core.wasm

FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY --from=wasm /app/web/wasm wasm/
# The pinned Rust stage already generated the artifact.
RUN npm run build --ignore-scripts

FROM rust-base AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
COPY api-types/Cargo.toml api-types/Cargo.toml
COPY client-core/Cargo.toml client-core/Cargo.toml
# Every workspace crate's manifest must be present to resolve the lockfile, even
# dev-only ones (test-macros) that the release binary never builds; stub their sources.
COPY server/test-macros/Cargo.toml server/test-macros/Cargo.toml
# Dependency-only layer: cached until Cargo.toml/Cargo.lock change.
RUN mkdir -p server/src server/test-macros/src api-types/src client-core/src && echo "" > server/src/lib.rs && echo "fn main() {}" > server/src/main.rs \
 && echo "" > server/test-macros/src/lib.rs \
 && echo "" > api-types/src/lib.rs \
 && echo "" > client-core/src/lib.rs \
 && cargo build --locked --release -p fukulow-server && rm -rf server/src server/test-macros/src api-types/src client-core/src
COPY server/ server/
COPY api-types/ api-types/
COPY client-core/ client-core/
COPY deploy/db-*.sql deploy/
RUN find server/src api-types/src client-core/src -name "*.rs" -exec touch {} +
COPY --from=web /app/web/dist web/dist
RUN cargo build --locked --release -p fukulow-server

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN groupadd --gid 10001 fukulow \
 && useradd --uid 10001 --gid fukulow --no-create-home --shell /usr/sbin/nologin fukulow
COPY --from=server /app/target/release/fukulow-server /usr/local/bin/fukulow-server
# glibc malloc only (#340): Argon2's 19 MiB buffers go to mmap and return to the
# OS on free. Re-evaluate whenever the base image or libc changes.
ENV MALLOC_MMAP_THRESHOLD_=131072
USER 10001:10001
EXPOSE 8080
CMD ["fukulow-server"]
