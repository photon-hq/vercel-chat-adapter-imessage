#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# -----------------------------------------------------------------------
# Two modes:
#   1) ./setup.sh collector   — lightweight: just the OTel Collector (logs to console)
#   2) ./setup.sh signoz      — full SigNoz stack with UI at http://localhost:8080
# -----------------------------------------------------------------------

MODE="${1:-collector}"

case "$MODE" in
  collector)
    echo "Starting standalone OTel Collector (debug exporter)..."
    echo "  OTLP gRPC: localhost:4317"
    echo "  OTLP HTTP: localhost:4318"
    echo ""
    docker compose up -d otel-collector
    echo ""
    echo "Collector running. View output with: docker compose logs -f otel-collector"
    ;;

  signoz)
    SIGNOZ_DIR="./signoz-deploy"
    if [ ! -d "$SIGNOZ_DIR" ]; then
      echo "Cloning SigNoz deploy files..."
      git clone --depth 1 https://github.com/SigNoz/signoz.git "$SIGNOZ_DIR"
    fi
    echo "Starting SigNoz stack..."
    cd "$SIGNOZ_DIR/deploy/docker"
    docker compose up -d
    echo ""
    echo "SigNoz is starting up. This may take 1-2 minutes."
    echo "  UI:        http://localhost:8080"
    echo "  OTLP gRPC: localhost:4317"
    echo "  OTLP HTTP: localhost:4318"
    ;;

  stop)
    echo "Stopping all demo services..."
    docker compose down 2>/dev/null || true
    if [ -d "./signoz-deploy/deploy/docker" ]; then
      cd "./signoz-deploy/deploy/docker"
      docker compose down 2>/dev/null || true
    fi
    echo "Done."
    ;;

  *)
    echo "Usage: ./setup.sh [collector|signoz|stop]"
    exit 1
    ;;
esac
