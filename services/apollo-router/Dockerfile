# Apollo Router v2.1.1 — pin to digest for reproducible builds
# To get the digest: docker pull ghcr.io/apollographql/router:v2.1.1 && docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/apollographql/router:v2.1.1
FROM ghcr.io/apollographql/router:v2.17.0@sha256:b4e70cbcff5a5c3a8825aa2b201257b57a2052bbe2d7751e74d129ebaa09ffe6

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql
COPY scripts /dist/scripts

EXPOSE 4001

# Apollo Router runs as non-root user 'router' (uid 1000) by default
CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
