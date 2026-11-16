# Local Linux build + headless test image for the Tauri shell (same packages as the ubuntu-24.04 CI runners).
#   docker build -f platforms/tauri/docker/linux.Dockerfile -t notemaker-tauri-linux platforms/tauri/docker
#   platforms/tauri/docker/run-linux.sh      (builds, runs the bridge self-test under Xvfb, takes a screenshot)
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates file pkg-config git \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libudev-dev \
      xvfb xauth x11-apps imagemagick dbus dbus-x11 at-spi2-core fonts-dejavu-core fonts-noto-color-emoji \
      nodejs npm llvm rpm patchelf squashfs-tools desktop-file-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*
ARG RUST_VERSION=1.97.1
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} -c clippy \
    && chmod -R a+rwX /opt/cargo /opt/rustup
WORKDIR /src
