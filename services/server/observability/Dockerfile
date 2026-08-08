# OTel Collector image for platforms that build from a Dockerfile (Railway).
# Unlike docker-compose, Railway can't bind-mount the config, so we bake it in.
#
# Pinned tag for reproducibility — bump deliberately to a current contrib
# release rather than tracking :latest.
FROM otel/opentelemetry-collector-contrib:0.154.0

# Build context is this directory (services/server/observability).
COPY otel-collector-config.yaml /etc/otel/config.yaml

# OTLP receivers (4317/4318) and the health endpoint (13133) are declared in
# the config; Railway maps the service's public port to one of them if exposed.
CMD ["--config=/etc/otel/config.yaml"]
