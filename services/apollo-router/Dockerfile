# Apollo Router v2.1.1 — pin to digest for reproducible builds
# To get the digest: docker pull ghcr.io/apollographql/router:v2.1.1 && docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/apollographql/router:v2.1.1
FROM ghcr.io/apollographql/router:v2.16.1@sha256:4281a20e6a52b421afd97e1746f947191d94b94889f86ca029ce7a2bc19b8851

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql
COPY scripts /dist/scripts

EXPOSE 4001

# Apollo Router runs as non-root user 'router' (uid 1000) by default
CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
