FROM python:3.14.10-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b AS python314
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node22
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node26
FROM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS rust
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS browser-base
USER root
RUN usermod --login ci --home /home/ci --move-home pwuser \
    && mkdir -p /opt/playwright && cd /opt/playwright && npm init -y && npm install --ignore-scripts --save-exact playwright@1.64.1 \
    && rm -f /etc/sudoers.d/*
ENV HOME=/home/ci PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /home/ci

FROM browser-base AS browser
COPY ci/capabilities/ /opt/ci/
COPY ci/postgres/qualify.py /opt/ci/qualify.py
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
COPY --from=node22 /usr/local/lib/node_modules /usr/local/lib/node_modules
USER 1001:1001

FROM browser-base AS app
ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'Acquire::Retries "0";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-ci-bounds \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git zsh rsync build-essential libreoffice-calc poppler-utils procps jq python3 python3-venv python-is-python3 \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --max-time 30 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-17 postgresql-18 postgresql-17-pgvector postgresql-18-pgvector libpq-dev \
    && rm -rf /var/lib/apt/lists/*
COPY ci/capabilities/ /opt/ci/
COPY ci/postgres/qualify.py /opt/ci/qualify.py
COPY ci/capabilities/chromium.py /usr/bin/chromium
RUN chmod +x /usr/bin/chromium
COPY --from=python314 /usr/local/ /usr/local/
RUN ldconfig
COPY --from=node26 /usr/local/bin/node /usr/local/bin/node
COPY --from=node26 /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/home/ci/.cargo PATH=/usr/local/cargo/bin:$PATH
USER 1001:1001

FROM python:3.14-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b AS backup
ENV DEBIAN_FRONTEND=noninteractive HOME=/home/ci
RUN printf 'Acquire::Retries "0";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-ci-bounds \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git zsh age jq \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --max-time 30 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
    && groupadd --gid 1001 ci && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash ci \
    && rm -rf /var/lib/apt/lists/*
COPY ci/capabilities/ /opt/ci/
ENV PATH=/usr/lib/postgresql/18/bin:$PATH
WORKDIR /home/ci
USER 1001:1001
