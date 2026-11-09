FROM node:26.13.0-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1.99.0-slim AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
# Dependency-only layer: cached until Cargo.toml/Cargo.lock change.
RUN mkdir -p server/src && echo "" > server/src/lib.rs && echo "fn main() {}" > server/src/main.rs \
 && cargo build --release -p fukulow-server && rm -rf server/src
COPY server/ server/
RUN find server/src -name "*.rs" -exec touch {} +
COPY --from=web /app/web/dist web/dist
RUN cargo build --release -p fukulow-server

FROM debian:bookworm-slim
COPY --from=server /app/target/release/fukulow-server /usr/local/bin/fukulow-server
EXPOSE 8080
CMD ["fukulow-server"]
