# Apollo Router v2.1.1 — pin to digest for reproducible builds
# To get the digest: docker pull ghcr.io/apollographql/router:v2.1.1 && docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/apollographql/router:v2.1.1
FROM ghcr.io/apollographql/router:v2.16.0@sha256:5e19cbaa94c7a78c565cd857f2e401c72db9f06e5a5301d4a131053ccd2bab5d

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql
COPY scripts /dist/scripts

EXPOSE 4001

# Apollo Router runs as non-root user 'router' (uid 1000) by default
CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
