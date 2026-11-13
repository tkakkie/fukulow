FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1.99.0-slim@sha256:2752b332db73fdbb7dc576f06c82ed1f312005784ef913d7e04a28f5f55dc581 AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
# Dependency-only layer: cached until Cargo.toml/Cargo.lock change.
RUN mkdir -p server/src && echo "" > server/src/lib.rs && echo "fn main() {}" > server/src/main.rs \
 && cargo build --locked --release -p fukulow-server && rm -rf server/src
COPY server/ server/
COPY deploy/db-*.sql deploy/
RUN find server/src -name "*.rs" -exec touch {} +
COPY --from=web /app/web/dist web/dist
RUN cargo build --locked --release -p fukulow-server

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN groupadd --gid 10001 fukulow \
 && useradd --uid 10001 --gid fukulow --no-create-home --shell /usr/sbin/nologin fukulow
COPY --from=server /app/target/release/fukulow-server /usr/local/bin/fukulow-server
# glibc malloc only (#340): Argon2's 19 MiB buffers go to mmap and return to the
# OS on free. Re-evaluate whenever the base image or libc changes.
ENV MALLOC_MMAP_THRESHOLD_=131072
USER 10001:10001
EXPOSE 8080
CMD ["fukulow-server"]
