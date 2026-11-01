# tv-os: plain Bazzite + Cage kiosk session + the Electron launcher shell.
# Built and published by .github/workflows/build.yml to ghcr.io/skeddles/tv-os.

# ---- Stage 1: build the Electron shell and a backup copy of the UI ----
FROM quay.io/fedora/fedora:44 AS shell-build
RUN dnf -y install nodejs npm git python3 && dnf clean all

# Electron app (downloads the matching Electron binary for Linux x64)
COPY shell /src/shell
RUN cd /src/shell \
    && npm ci --no-audit --no-fund \
    && node node_modules/electron/install.js \
    && test -x node_modules/electron/dist/electron \
    && npm run check \
    && mkdir -p /out/app \
    && cp -a node_modules/electron/dist /out/electron \
    && cp -a package.json main.cjs preload.cjs webview-preload.cjs lib input /out/app/ \
    && rm -f /out/app/input/test_input.py

# Backup copy of the UI, shown if the live dev server on the TV isn't running.
# Uses the `tv` branch (commits that passed CI), or main if that doesn't exist yet.
ARG UI_REPO=https://github.com/skeddles/tv-launcher-ui.git
RUN set -eu; mkdir -p /out/ui-fallback; \
    if git clone --depth 1 --branch tv "$UI_REPO" /src/ui || git clone --depth 1 "$UI_REPO" /src/ui; then \
      cd /src/ui && npm ci --no-audit --no-fund && npm run build -- --outDir /out/ui-fallback --emptyOutDir; \
    fi; \
    if [ ! -f /out/ui-fallback/index.html ]; then \
      printf '%s\n' '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111316;color:#E8EAED;font:32px system-ui;display:grid;place-items:center;height:100vh">Starting the launcher…</body>' > /out/ui-fallback/index.html; \
    fi

# ---- Build context for build.sh (not copied into the final image) ----
FROM scratch AS ctx
COPY build_files /
COPY system_files /system_files
COPY --from=shell-build /out /shell-out

# ---- Final image ----
# Plain Bazzite (KDE desktop image). Not the deck image: Bazzite's Gaming Mode
# doesn't support this PC's Intel HD Graphics 530, so Cage replaces gamescope.
FROM ghcr.io/ublue-os/bazzite:stable

RUN --mount=type=bind,from=ctx,source=/,target=/ctx \
    --mount=type=cache,dst=/var/cache \
    --mount=type=cache,dst=/var/log \
    --mount=type=tmpfs,dst=/tmp \
    /ctx/build.sh

### LINTING
## Verify final image and contents are correct.
RUN bootc container lint
