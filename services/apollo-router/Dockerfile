FROM ghcr.io/apollographql/router:v2.1.1

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql

EXPOSE 4001

CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
