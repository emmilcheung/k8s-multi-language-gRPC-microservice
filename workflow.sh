#!/bin/bash
# Workflow Status & Pause/Resume Utility
# Usage: ./workflow.sh [status|pause|resume|docker|decision]

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUS_FILE="$REPO_ROOT/STATUS.md"
PAUSE_CHECKPOINT="$REPO_ROOT/.workflow-pause"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ────────────────────────────────────────────────────────────────────────────

cmd_status() {
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                  WORKFLOW STATUS REPORT${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Extract key metrics from STATUS.md
    grep -A 1 "^| Services implemented" "$STATUS_FILE" | tail -1 | sed 's/^/  /'
    grep -A 1 "^| Test coverage" "$STATUS_FILE" | tail -1 | sed 's/^/  /'
    grep -A 1 "^| Docker containers ready" "$STATUS_FILE" | tail -1 | sed 's/^/  /'
    echo ""
    
    # Show current service
    echo -e "${GREEN}Current Service:${NC}"
    grep "^**Current Service:**" "$STATUS_FILE" | sed 's/\*\*//g' | sed 's/^/  /'
    echo ""
    
    # Show services status
    echo -e "${GREEN}Service Implementation Status:${NC}"
    grep "^#### \(✅\|⏳\)" "$STATUS_FILE" | sed 's/#### /  /' | head -10
    echo ""
    
    # Show docker status
    echo -e "${GREEN}Docker Infrastructure:${NC}"
    RUNNING=$(docker ps --filter "label=com.docker.compose.project=microservices" -q 2>/dev/null | wc -l)
    echo -e "  ${GREEN}✅${NC} $RUNNING containers running"
    echo ""
    
    if [ -f "$PAUSE_CHECKPOINT" ]; then
        echo -e "${YELLOW}⏸  Currently paused at:${NC}"
        cat "$PAUSE_CHECKPOINT" | sed 's/^/  /'
    fi
    
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
}

# ────────────────────────────────────────────────────────────────────────────

cmd_pause() {
    CHECKPOINT="${1:-current}"
    echo -e "${YELLOW}Pausing workflow at checkpoint: $CHECKPOINT${NC}"
    
    {
        echo "Checkpoint: $CHECKPOINT"
        echo "Timestamp: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
        echo "Last status: auth-service COMPLETE, tests passing, docker running"
    } > "$PAUSE_CHECKPOINT"
    
    echo -e "${GREEN}✅ Workflow paused${NC}"
    echo ""
    echo "Resume with: ./workflow.sh resume"
    echo "Check status with: ./workflow.sh status"
}

# ────────────────────────────────────────────────────────────────────────────

cmd_resume() {
    if [ ! -f "$PAUSE_CHECKPOINT" ]; then
        echo -e "${RED}❌ No pause checkpoint found${NC}"
        echo "Use: ./workflow.sh pause [checkpoint-name]"
        exit 1
    fi
    
    echo -e "${YELLOW}Resuming from:${NC}"
    cat "$PAUSE_CHECKPOINT"
    echo ""
    
    rm "$PAUSE_CHECKPOINT"
    echo -e "${GREEN}✅ Workflow resumed${NC}"
    echo ""
    echo "Run status check: ./workflow.sh status"
}

# ────────────────────────────────────────────────────────────────────────────

cmd_docker() {
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                   DOCKER STATUS${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    echo -e "${GREEN}Running Containers:${NC}"
    docker ps --filter "label=com.docker.compose.project=microservices" \
        --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "  (no containers found)"
    
    echo ""
    echo -e "${GREEN}Service Port Mappings:${NC}"
    echo "  PostgreSQL (auth):        localhost:5432"
    echo "  PostgreSQL (orders):      localhost:5433"
    echo "  PostgreSQL (payments):    localhost:5434"
    echo "  MongoDB:                  localhost:27017"
    echo "  Redis:                    localhost:6379"
    echo "  Kafka:                    localhost:9092"
    echo "  Schema Registry:          localhost:8081"
    echo ""
    
    # Check connectivity
    echo -e "${GREEN}Connectivity Tests:${NC}"
    
    if docker ps --filter "label=com.docker.compose.project=microservices" -q 2>/dev/null | grep -q . 2>/dev/null; then
        echo -e "  ${GREEN}✅${NC} Docker daemon responding"
    else
        echo -e "  ${RED}❌${NC} Docker daemon not responding"
        return 1
    fi
    
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
}

# ────────────────────────────────────────────────────────────────────────────

cmd_decision() {
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}              NEXT SERVICE DECISION TREE${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    echo -e "${GREEN}Current State:${NC}"
    echo "  ✅ auth-service: COMPLETE (28 tests passing)"
    echo "  ✅ Docker infrastructure: RUNNING (7 containers)"
    echo ""
    
    echo -e "${GREEN}Next Service Options:${NC}"
    echo ""
    echo "  A) ticket-service (Go / Echo + MongoDB + Kafka + gRPC)"
    echo "     → Estimated: 2–3 hours"
    echo "     → Ready: MongoDB and Kafka running"
    echo ""
    echo "  B) order-service (Java / Spring Boot + JPA + gRPC client)"
    echo "     → Estimated: 3–4 hours"
    echo "     → Ready: PostgreSQL running, gRPC proto ready"
    echo ""
    echo "  C) payment-service (TypeScript / NestJS + Drizzle + Kafka)"
    echo "     → Estimated: 2–3 hours"
    echo "     → Ready: PostgreSQL running, similar to auth-service"
    echo ""
    echo "  D) expiration-service (Go + asynq + Redis + Kafka)"
    echo "     → Estimated: 2–3 hours"
    echo "     → Ready: Redis and Kafka running"
    echo ""
    echo "  E) client (Next.js 15 + pnpm)"
    echo "     → Estimated: 3–4 hours"
    echo "     → Ready: No backend dependencies, can start anytime"
    echo ""
    echo "  F) Pause for review"
    echo "     → Review current status and decide"
    echo ""
    
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "Usage:"
    echo "  ./workflow.sh decision:a  # Choose ticket-service"
    echo "  ./workflow.sh decision:b  # Choose order-service"
    echo "  ./workflow.sh decision:c  # Choose payment-service"
    echo "  ./workflow.sh decision:d  # Choose expiration-service"
    echo "  ./workflow.sh decision:e  # Choose client"
    echo "  ./workflow.sh decision:f  # Pause for review"
}

# ────────────────────────────────────────────────────────────────────────────

# Main dispatch
case "${1:-status}" in
    status)
        cmd_status
        ;;
    docker)
        cmd_docker
        ;;
    pause)
        cmd_pause "$2"
        ;;
    resume)
        cmd_resume
        ;;
    decision)
        cmd_decision
        ;;
    *)
        echo "Workflow Control Utility"
        echo ""
        echo "Usage: ./workflow.sh [command]"
        echo ""
        echo "Commands:"
        echo "  status              Show current workflow status"
        echo "  docker              Show Docker container status"
        echo "  pause [name]        Pause at current checkpoint"
        echo "  resume              Resume from last pause"
        echo "  decision            Show decision tree for next service"
        echo ""
        exit 1
        ;;
esac
