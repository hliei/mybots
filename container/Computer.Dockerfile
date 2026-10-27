FROM python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq openssh-client unzip procps \
    poppler-utils pandoc python3-openpyxl gh \
    && rm -rf /var/lib/apt/lists/* \
    && printf '%s\n' /usr/lib/python3/dist-packages > /usr/local/lib/python3.13/site-packages/debian.pth
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) uv_arch=x86_64; uv_sha=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 ;; \
      arm64) uv_arch=aarch64; uv_sha=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436 ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSL "https://releases.astral.sh/github/uv/releases/download/0.12.19/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz; \
    echo "$uv_sha  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx"; \
    rm /tmp/uv.tar.gz
COPY packages/sandbox/src/computer.py /opt/mybots/computer.py
COPY packages/sandbox/src/preview.py /opt/mybots/preview.py
WORKDIR /workspace
CMD ["sleep", "infinity"]
