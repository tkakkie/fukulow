# #939: Pebble reuses a valid authorization unless rand.Intn(100) > PEBBLE_AUTHZREUSE, so 0 still reuses 1% of
# the time (wfe/wfe.go makeAuthorizations, unchanged through v2.10.3). A reused authorization skips HTTP-01, so the
# renewal check would see no fresh validation. Build the pinned release with `>=`, which makes 0 never reuse.
# Only the certificate lifecycle check uses this image; the vendored module tree builds offline.
ARG PEBBLE_IMAGE
FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build
ARG PEBBLE_COMMIT=d52948ce25e7c1576bcd18ff0e20a1c24ec7c44b
WORKDIR /src
RUN git init --quiet && git fetch --quiet --depth 1 https://github.com/letsencrypt/pebble "$PEBBLE_COMMIT" \
 && git checkout --quiet FETCH_HEAD && test "$(git rev-parse HEAD)" = "$PEBBLE_COMMIT"
RUN test "$(grep -Fc 'rand.Intn(100) > wfe.authzReusePercent' wfe/wfe.go)" = 1 \
 && sed -i 's/rand.Intn(100) > wfe.authzReusePercent/rand.Intn(100) >= wfe.authzReusePercent/' wfe/wfe.go \
 && test "$(grep -Fc 'rand.Intn(100) >= wfe.authzReusePercent' wfe/wfe.go)" = 1 \
 && test "$(git diff --numstat | awk '{ print $1 + $2 }')" = 2
RUN CGO_ENABLED=0 GOPROXY=off GOTOOLCHAIN=local GOFLAGS=-mod=vendor go build -trimpath -o /pebble ./cmd/pebble

FROM ${PEBBLE_IMAGE}
COPY --from=build /pebble /app
