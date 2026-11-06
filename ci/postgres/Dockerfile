FROM python:3.14-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'Acquire::Retries "2";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n' > /etc/apt/apt.conf.d/80-ci-bounds \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git zsh build-essential libreoffice-calc poppler-utils fonts-liberation \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --max-time 30 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && groupadd --gid 1001 ci && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash ci \
    && rm -rf /var/lib/apt/lists/*
COPY ci/postgres/qualify.py /opt/ci/qualify.py
ENV HOME=/home/ci
WORKDIR /home/ci

FROM base AS pg17
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17 postgresql-17-pgvector libpq-dev && rm -rf /var/lib/apt/lists/*
USER 1001:1001
RUN --network=none python /opt/ci/qualify.py --majors 17

FROM base AS pg18
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-18 postgresql-18-pgvector libpq-dev && rm -rf /var/lib/apt/lists/*
USER 1001:1001
RUN --network=none python /opt/ci/qualify.py --majors 18

FROM base AS both
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17 postgresql-18 postgresql-17-pgvector postgresql-18-pgvector libpq-dev && rm -rf /var/lib/apt/lists/*
USER 1001:1001
RUN --network=none python /opt/ci/qualify.py
