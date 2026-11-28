# check=skip=InvalidDefaultArgInFrom
# The runner supplies the required runtime image from Makefile.
ARG K6_IMAGE
FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build
ARG K6_IMAGE
ENV GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
WORKDIR /src
RUN version=${K6_IMAGE#*:} \
    && module="go.k6.io/k6/v2@v${version%%@*}" \
    && go mod download "$module" \
    && cp -R "/go/pkg/mod/$module/." . \
    && chmod -R u+w .
COPY k6-exact-arrivals.patch /tmp/k6-exact-arrivals.patch
RUN git apply --whitespace=error /tmp/k6-exact-arrivals.patch \
    && go test ./lib/executor -run '^Test(ConstantArrivalRate|ArrivalRateCancel)' \
    && go build -trimpath -buildvcs=false -o /out/k6 .

FROM ${K6_IMAGE}
COPY --from=build /out/k6 /usr/bin/k6
