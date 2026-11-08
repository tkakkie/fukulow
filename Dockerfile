FROM node:26-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1.98-slim AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY server/ server/
COPY --from=web /app/web/dist web/dist
RUN cargo build --release -p fukulow-server

FROM debian:bookworm-slim
COPY --from=server /app/target/release/fukulow-server /usr/local/bin/fukulow-server
EXPOSE 8080
CMD ["fukulow-server"]
