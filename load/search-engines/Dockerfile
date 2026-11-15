FROM postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42

# Measurement only. Keep the server from the base image, including its minor version.
RUN apt-mark hold postgresql-18 postgresql-client-18 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl build-essential libicu-dev postgresql-server-dev-18=18.6-1.pgdg13+2 \
 && curl -fsSL https://packages.groonga.org/debian/groonga-apt-source-latest-trixie.deb -o /tmp/groonga-source.deb \
 && echo '3406de4b8965c44a0e793090efbb0996a1802930159e7aa3f31c97dbef127c34  /tmp/groonga-source.deb' | sha256sum -c - \
 && apt-get install -y /tmp/groonga-source.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-18-pgdg-pgroonga=4.1.0-1 libgroonga0=16.1.3-1 \
 && curl -fsSL https://codeload.github.com/pgbigm/pg_bigm/tar.gz/refs/tags/v1.2-20250903 -o /tmp/pg_bigm.tar.gz \
 && echo '4d4fb48161e3f9e99207851299379c83b3e5d1d3c1a07c35f6a3153d577b3142  /tmp/pg_bigm.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/pg_bigm.tar.gz -C /tmp \
 && make -C /tmp/pg_bigm-1.2-20250903 USE_PGXS=1 PG_CONFIG=/usr/bin/pg_config \
 && make -C /tmp/pg_bigm-1.2-20250903 USE_PGXS=1 PG_CONFIG=/usr/bin/pg_config install \
 && test "$(postgres --version)" = 'postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)' \
 && rm -rf /var/lib/apt/lists/* /tmp/pg_bigm* /tmp/groonga-source.deb
