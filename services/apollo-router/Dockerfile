# Apollo Router v2.1.1 — pin to digest for reproducible builds
# To get the digest: docker pull ghcr.io/apollographql/router:v2.1.1 && docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/apollographql/router:v2.1.1
FROM ghcr.io/apollographql/router:v2.1.1@sha256:d0f8e557152ae26a666392c3835aff17d59ae3b4a6be61faa60e762a93ab1b36

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql
COPY scripts /dist/scripts

EXPOSE 4001

# Apollo Router runs as non-root user 'router' (uid 1000) by default
CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
