# Guiding Principles

> **Core tenets** that drive all engineering decisions on the modern microservices platform.

1. **Services are independent units of deployment.** A change in one service must never require a coordinated deploy of another.
2. **Fail loudly at startup, silently never.** Every service validates its config at boot and refuses to start if anything is missing.
3. **Own your data.** Each service owns exactly one datastore. No service queries another service's database directly, ever.
4. **Design for failure.** Every network call can fail. Apply timeouts, retries with exponential back-off, and circuit breakers everywhere.
5. **Minimal blast radius.** Scope each change to the smallest possible surface. Do not refactor, rename, or reformat code outside the task boundary.
6. **Security is not optional.** Treat every piece of user input as hostile. Validate and sanitise at every service boundary.
7. **Observable by default.** Every service emits structured logs, metrics, and traces from day one — not as an afterthought.
