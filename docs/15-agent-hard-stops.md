# Agent Hard Stops

The agent must **not** perform the following without explicit user confirmation in the active session:

1. `kubectl delete` / `helm uninstall` / `terraform destroy` against any non-local environment.
2. `git push --force`, `git reset --hard`, `git rebase` on a shared branch.
3. Run any database migration against a staging or production DB.
4. Drop, truncate, or wipe a database or collection outside of test helpers.
5. Publish to a package registry or container registry.
6. Rotate, delete, or disable any secret, certificate, or IAM role.
7. Modify Kafka topic configuration (retention, partition count, replication factor) on a live cluster.
8. Include a secret, token, or password in any file, log, or terminal output.
9. Install a new dependency without noting it and stating why it is needed.
10. Open a port, configure a public endpoint, or change a security group / NetworkPolicy without user review.
