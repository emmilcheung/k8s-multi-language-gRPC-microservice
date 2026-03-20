# Workflow & Status Management

This document explains how to track progress, pause/resume work, and make decisions about which service to implement next.

---

## Quick Reference

### Check Status
```bash
./workflow.sh status
```

Shows:
- Current service implementation progress
- Docker container status
- Test results
- Pause checkpoint (if active)

### View Decision Tree
```bash
./workflow.sh decision
```

Shows all available services with estimated time and readiness.

### Pause Current Work
```bash
./workflow.sh pause "checkpoint description"
```

Example:
```bash
./workflow.sh pause "auth-service complete, ready for ticket-service"
```

### Resume From Pause
```bash
./workflow.sh resume
```

Clears the pause checkpoint and resumes work.

### Check Docker Status
```bash
./workflow.sh docker
```

Shows running containers and port mappings.

---

## Workflow Overview

```
Session Start
     │
     ├─→ ./workflow.sh status          (Check current state)
     │
     ├─→ ./workflow.sh decision        (See next options)
     │
     ├─→ Implement Service A
     │   │
     │   ├─→ Run tests
     │   ├─→ Build verification
     │   └─→ ./workflow.sh pause       (Mark completion)
     │
     ├─→ Implement Service B
     │   │ (Repeat)
     │   └─→ ./workflow.sh pause
     │
     └─→ Session End
         └─→ ./workflow.sh pause "session complete"
```

---

## Status.md Reference

**File:** `STATUS.md`

Contains:
- Executive summary
- Detailed service status (14 tables)
- Infrastructure status (Docker, Kubernetes)
- Pause/resume checkpoints (10 predefined)
- Workflow decision tree
- Metrics and key indicators
- Session history

This is the source of truth for project status. Update after completing each service.

---

## Workflow Decision Tree

At each pause point, you have these choices:

```
Decision: Which service next?
│
├─ A) ticket-service (Go)             ← Best if you want to test gRPC + Kafka
├─ B) order-service (Java)            ← Best if you want Spring Boot integration
├─ C) payment-service (TypeScript)    ← Best if you want Drizzle ORM + Kafka
├─ D) expiration-service (Go)         ← Best if you want Redis + asynq
├─ E) client (Next.js)                ← Best if you want UI development
└─ F) Pause for review                ← Best if you want to checkpoint/reflect
```

### Recommended Order

**Strict Dependency Order:**
1. ✅ auth-service (complete)
2. → ticket-service (no deps)
3. → order-service (depends on ticket gRPC)
4. → payment-service (no deps)
5. → expiration-service (depends on order events)
6. → client (depends on all backends ready)

**Alternative: Test Each Database Type First**
1. ✅ auth-service (PostgreSQL)
2. → ticket-service (MongoDB)
3. → payment-service (PostgreSQL + Kafka consumer)
4. → expiration-service (Redis + Kafka)
5. → order-service (complex: Spring Boot + gRPC client + transactional outbox)

---

## Predefined Pause Checkpoints

From `STATUS.md`, these are the major checkpoints:

| # | Checkpoint | Services Done | Notes |
|---|---|---|---|
| 1 | auth-service complete | 1 | ← **CURRENT** |
| 2 | ticket-service complete | 2 | gRPC + Kafka tested |
| 3 | order-service complete | 3 | Complex logic verified |
| 4 | payment-service complete | 4 | Stub payment working |
| 5 | expiration-service complete | 5 | Event loop closure |
| 6 | Backend event loop verified | 5 | End-to-end integration test |
| 7 | client complete | 6 | UI fully functional |
| 8 | Local Kubernetes running | 6 | kind cluster with Kong |
| 9 | AWS EKS provisioned | 6 | Terraform complete |
| 10 | Services on EKS dev | 6 | Production-like environment |

---

## Logging Convention

When pausing, include:
- Service name
- What's complete
- What's next
- Any blockers or notes

Example:
```bash
./workflow.sh pause "ticket-service complete: gRPC + Kafka working. 
Next: order-service requires Spring Boot setup. 
Note: MongoDB StatefulSet helm chart ready in infra/helm/"
```

---

## Interpreting Status Output

### Service Status Codes

| Symbol | Meaning | Example |
|---|---|---|
| ✅ | Complete | auth-service, 28 tests passing |
| ⏳ | Not started | ticket-service |
| 🔨 | In progress | (not shown in STATUS.md, shown in console) |
| ⚠️ | Blocked | Hypothetical: gRPC proto not compiled |
| ⏸ | Paused | (shown only if `.workflow-pause` exists) |

### Docker Status Codes

```
✅ Running    → Container is up and healthy
⏳ Starting   → Container initializing (wait a few seconds)
❌ Stopped    → Container is not running (run: docker-compose up -d)
```

---

## Examples

### Example 1: Complete a Service and Pause

```bash
# Work on ticket-service...
cd services/ticket-service
pnpm install
go build
npm run test
npm run test:integration

# When complete:
cd /Users/emmil/Desktop/code/microservices
./workflow.sh pause "ticket-service complete: 24 tests passing, gRPC server on 9090, Kafka producer verified"
./workflow.sh status
```

### Example 2: Pause for the Day

```bash
# End of day checkpoint
./workflow.sh pause "End of day: auth-service + ticket-service complete. 
Estimated 3 more services + client. 
Next: order-service (Spring Boot) - moderate complexity"

# Next day:
./workflow.sh resume
./workflow.sh status
./workflow.sh decision
```

### Example 3: Switch Between Services

```bash
# Working on order-service, hit blocker with gRPC
./workflow.sh pause "order-service blocked: gRPC proto import issue. 
Switching to payment-service (simpler, PostgreSQL + Drizzle only)"

# Start payment-service instead...
# When unblocked:
./workflow.sh resume
# Go back to order-service debugging
```

---

## Troubleshooting

### Docker containers not running?

```bash
./workflow.sh docker
# Check output. If no containers shown, restart:
docker-compose up -d
```

### Lost pause checkpoint?

```bash
# Check if file exists:
ls -la .workflow-pause

# View contents:
cat .workflow-pause

# Clear manually if needed:
rm .workflow-pause
./workflow.sh resume
```

### STATUS.md out of sync?

```bash
# STATUS.md is manually maintained after each service.
# To update:
# 1. Edit the relevant section in STATUS.md
# 2. Update metrics in "Key Metrics" table
# 3. Add session notes to "Session History"

# Example: after completing ticket-service:
# - Change "⏳ ticket-service (Not Started)" to "✅ ticket-service (Complete)"
# - Update "Services implemented" from "1 / 5" to "2 / 5"
# - Add test results
```

---

## Integration with CI/CD

When building CI/CD pipelines:

```bash
# Before deploying: check status
./workflow.sh status

# Verify Docker
./workflow.sh docker

# In CI workflow:
- Run tests
- If all pass: update STATUS.md
- If any fail: ./workflow.sh pause "CI failure: [details]"
```

---

## Commands Reference

```bash
# Status & Info
./workflow.sh status              # Full status report
./workflow.sh docker              # Docker container info
./workflow.sh decision             # Decision tree for next service

# Control
./workflow.sh pause [msg]          # Pause workflow
./workflow.sh resume               # Resume from pause

# Help
./workflow.sh                      # Show usage
./workflow.sh --help               # (if implemented)
```

---

## Next Steps

**Current State:**
- ✅ auth-service complete
- ✅ Docker infrastructure running
- ✅ STATUS.md created
- ✅ workflow.sh available

**What to do now:**

1. Review STATUS.md:
   ```bash
   cat STATUS.md
   ```

2. Check decision tree:
   ```bash
   ./workflow.sh decision
   ```

3. Choose next service (or pause for review):
   ```bash
   ./workflow.sh pause "checkpoint message"
   ```

---

*Last updated: 2026-03-20 17:15 UTC*
