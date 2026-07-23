FROM python:3.12.11-slim-bookworm

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build-time inputs only.  The Dockerfile itself is intentionally not copied
# into the runtime image.
COPY config.ini config_overlay.py entrypoint.sh supervisor.py ./
RUN chmod +x config_overlay.py entrypoint.sh supervisor.py

EXPOSE 8000 8765

ENTRYPOINT ["./entrypoint.sh"]
