# Contributing to the Microservices Platform

This document establishes the standard workflow for all development on this platform.

## Git Workflow & Branch Strategy

### Trunk-Based Development

We follow **trunk-based development** with feature branches:
- **main** is the default branch — always deployable, CI must pass
- **Feature branches** are short-lived (1–2 days max)
- Branches are created from `main` and merged back via squash merge

### Branch Naming Convention

```
<type>/<short-description>

Types:
  feat/<name>      — new feature or service
  fix/<name>       — bug fix
  refactor/<name>  — refactoring (no feature or behavior change)
  docs/<name>      — documentation only
  chore/<name>     — maintenance, dependency updates
  test/<name>      — test additions
  ci/<name>        — CI/CD configuration changes
```

**Examples:**
```
feat/auth-service
feat/ticket-service
fix/kafka-producer-timeout
docs/api-reference
chore/update-go-dependencies
```

---

## Commit Messages (Conventional Commits v1.0.0)

All commit messages **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) format.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Components

#### Type
**Required.** Must be one of:
- `feat` — introduces a new feature
- `fix` — bug fix
- `perf` — performance improvement
- `refactor` — code refactoring (no feature change)
- `test` — adding or updating tests
- `docs` — documentation changes
- `chore` — maintenance tasks, dependency updates
- `ci` — CI/CD pipeline changes
- `build` — build system changes

#### Scope
**Required.** Specifies what part of the system is affected:
- Service name: `auth-service`, `ticket-service`, `payment-service`, etc.
- Infrastructure area: `infra/terraform`, `infra/k8s`, `infra/docker`
- Other: `proto`, `proto/orders`, `libs`, `client`

#### Subject (Description)
**Required.** Concise, imperative mood, no period.

- Use imperative mood ("implement" not "implemented" or "implements")
- Don't capitalize the first letter
- No trailing period
- Maximum 50 characters

#### Body
**Optional.** Explains the **why** and **what**, not the how.

- Wrap at 72 characters
- Separate from subject with a blank line
- Use bullet points for multiple changes
- Reference related issues, PRs, or tickets

#### Footer
**Optional.** References issues or breaking changes.

- Format: `Closes #123` or `Refs #456`
- Breaking changes: `BREAKING CHANGE: description`

### Examples

**Minimal commit:**
```
feat(auth-service): implement JWT authentication with RS256
```

**Full commit:**
```
feat(auth-service): implement JWT authentication with RS256 signing

- Add signup/signin endpoints
- Implement argon2id password hashing
- Set up JWKS endpoint at /.well-known/jwks.json
- Add comprehensive unit and integration tests
- Document authentication flow in API docs

This enables users to register and log in to the platform using email/password
credentials with secure hashing and asymmetric JWT signing.

Closes #12
Refs #45 #67
```

**Breaking change:**
```
refactor(ticket-service): rename ticket UUID field to id

BREAKING CHANGE: API clients must update references from ticketId to id
in all HTTP requests and event payloads.

Closes #99
```

---

## Pull Request (or Merge Request) Workflow

### Before Creating a PR/MR

1. **Create a feature branch** from `main`:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/your-feature-name
   ```

2. **Make commits** following Conventional Commits format (multiple commits are fine on the branch)

3. **Verify tests pass locally**:
   ```bash
   # For Node.js services
   npm test
   npm run test:integration
   npm run build

   # For Go services
   go test ./...
   go vet ./...

   # For Java services
   mvn clean verify
   ```

4. **Ensure your branch is up to date** with `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   ```

### Creating the PR/MR

1. **Push your branch** to remote:
   ```bash
   git push origin feat/your-feature-name
   ```

2. **Create PR/MR** with the following template:

   ```markdown
   ## Description
   Brief summary of what this PR accomplishes and why.

   ## Type of Change
   - [ ] New feature
   - [ ] Bug fix
   - [ ] Performance improvement
   - [ ] Refactoring
   - [ ] Test addition
   - [ ] Documentation

   ## Testing
   How were these changes tested?
   - Unit tests: `npm test` / `go test ./...`
   - Integration tests: `npm run test:integration` / `go test ./test/...`
   - Manual testing: describe any manual steps

   ## Checklist
   - [ ] Code follows the project style guide (AGENTS.md §16)
   - [ ] Tests added/updated and all passing
   - [ ] Documentation updated (README, comments, CONTRIBUTING)
   - [ ] Commit messages follow Conventional Commits
   - [ ] No hardcoded secrets, credentials, or API keys
   - [ ] No changes to `/legacy` directory

   ## Related Issues
   Closes #123
   Refs #456

   ## Screenshots (if applicable)
   Include screenshots for UI changes.
   ```

3. **Wait for CI to pass** and request a peer review

### Peer Review

- At least **1 peer review required** before merge
- Reviewers check for:
  - Code quality and adherence to AGENTS.md
  - Test coverage (unit + integration)
  - Documentation clarity
  - Security (no secrets leaked)
  - Performance implications

### Merging

> **Agent workflow rule (confirmed 2026-03-20):**  
> The agent must **never** auto-merge a feature branch into `main`.  
> After all work on a feature branch is committed and tests pass, the agent stops and requests explicit approval from the repository owner before any merge takes place.  
> Only merge after the owner has reviewed the branch content and given the go-ahead.

1. **Owner reviews the feature branch** — inspect commits, diffs, and test results.

2. **Owner approves** — give explicit confirmation in the session.

3. **Squash merge to main** (keeps history clean):
   ```bash
   git checkout main
   git pull origin main
   git merge --squash feat/your-feature-name
   ```

4. **Create a single squash commit** with comprehensive message:
   ```bash
   git commit -m "feat(service-name): description

   - Bullet point 1
   - Bullet point 2

   Closes #123"
   ```

5. **Push to main**:
   ```bash
   git push origin main
   ```

6. **Delete the feature branch**:
   ```bash
   git branch -d feat/your-feature-name
   git push origin --delete feat/your-feature-name
   ```

---

## Commit Message Checklist

Before pushing, ensure your commit messages:

- [ ] Follow Conventional Commits format
- [ ] Use imperative mood ("add" not "added")
- [ ] Are clear about **what** changed and **why**
- [ ] Don't exceed 50 chars in subject
- [ ] Reference related issues (`Closes #123`)
- [ ] Don't include secrets or credentials
- [ ] Each logical change in a separate commit (on feature branch)
- [ ] Final squash merge to main has comprehensive body

---

## Examples by Service Type

### Adding a New Service

```
feat(payment-service): implement payment processing service

- Scaffold NestJS 10 project with TypeScript
- Add Stripe integration for payment collection
- Implement Kafka consumer for order events
- Add 30+ unit and integration tests
- Create Docker image with multi-stage build
- Document API endpoints and setup in README

Services now have 3 of 5 implementations complete.

Closes #45
```

### Bug Fix

```
fix(ticket-service): handle MongoDB connection timeout gracefully

When MongoDB is temporarily unavailable during startup, the service now
retries with exponential backoff instead of crashing immediately. This
improves resilience during infrastructure maintenance.

- Add retry logic with max 5 attempts
- Log each retry attempt at WARN level
- Return 503 on readiness check if retries exhausted

Closes #89
```

### Refactoring

```
refactor(auth-service): extract JWT signing logic to separate module

Move JWT token creation and verification into a dedicated JwtHelper
class for better testability and reusability across services.

- Create jwt.helper.ts with RS256 signing logic
- Update AuthService to use new helper
- Add 8 unit tests for JWT helper
- No API changes, fully backward compatible

Refs #34
```

### Documentation

```
docs(contributing): add git workflow and commit standards

Document the trunk-based development model, branch naming, and Conventional
Commits format to standardize contribution practices across the team.

- Add CONTRIBUTING.md with full workflow
- Include examples for each commit type
- Reference Conventional Commits v1.0.0 spec
```

---

## Git Safety Rules

### DO NOT

1. ❌ Force push to `main` — ever
2. ❌ Commit secrets, API keys, credentials to any branch
3. ❌ Commit `.env` files (use `.env.example` as template)
4. ❌ Modify `/legacy` directory (reference only)
5. ❌ Use `git commit --amend` on shared branches
6. ❌ Rewrite history on `main` with `git rebase` or `git reset --hard`

### If You Accidentally Commit a Secret

1. Immediately rotate the credential
2. Create a new commit that **removes** the secret (don't just delete it)
3. Use `git filter-branch` or similar tool to purge from history if needed
4. Notify the team

---

## Setting Up Your Local Environment

### One-Time Setup

```bash
# Clone the repository
git clone <repo-url>
cd microservices

# Configure Git locally (do NOT use --global if you have multiple identities)
git config user.name "Your Name"
git config user.email "your.email@company.com"

# Verify config
git config user.name
git config user.email

# Install Git hooks (if using pre-commit or similar)
# TBD in future CI setup
```

### Before Each Feature

```bash
# Create a fresh branch from latest main
git checkout main
git pull origin main
git checkout -b feat/your-feature

# Work, commit, test
```

---

## FAQ

**Q: Can I have multiple commits on my feature branch?**  
A: Yes! Commit as often as you like on your branch. On merge, we squash to a single clean commit to main.

**Q: What if I committed to main by accident?**  
A: If you haven't pushed yet: `git reset --soft HEAD~1` to undo the commit (keep changes staged).  
If you've pushed: Create a new commit that reverts the changes, then push again.

**Q: How do I update my branch if main changed?**  
A: Use `git rebase origin/main` (preferred for clean history) or `git merge origin/main` (if rebase feels risky).

**Q: What's the difference between `feat`, `fix`, and `refactor`?**  
- `feat` = new functionality, new endpoints, new tests
- `fix` = bug fix for existing functionality
- `refactor` = improve code, extract methods, no feature change

**Q: Can I use emoji in commit messages?**  
A: No. Conventional Commits recommends plain text for tool compatibility.

---

## Resources

- [Conventional Commits v1.0.0](https://www.conventionalcommits.org/)
- [Trunk-Based Development](https://trunkbaseddevelopment.com/)
- [Git Workflow Comparison](https://www.atlassian.com/git/tutorials/comparing-workflows)
- Project Standards: See [AGENTS.md](./AGENTS.md) §14 (Git & Collaboration)
