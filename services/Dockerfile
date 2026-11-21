FROM oven/bun:1
ARG REPO
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --depth=1 "https://github.com/${REPO}.git" . && bun install --frozen-lockfile || bun install
CMD ["bun","start"]
