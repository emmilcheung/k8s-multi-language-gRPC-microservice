package com.ticketing.orders.graphql;

import org.springframework.graphql.server.WebGraphQlInterceptor;
import org.springframework.graphql.server.WebGraphQlRequest;
import org.springframework.graphql.server.WebGraphQlResponse;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Propagates the x-user-id HTTP header into the GraphQL context so that
 * @QueryMapping/@MutationMapping handlers can access it via GraphQLContext.
 */
@Component
public class UserIdInterceptor implements WebGraphQlInterceptor {

    static final String USER_ID_KEY = "x-user-id";

    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        String raw = request.getHeaders().getFirst("x-user-id");
        if (raw == null) raw = request.getHeaders().getFirst("X-User-Id");
        final String userId = raw;
        if (userId != null) {
            request.configureExecutionInput((input, builder) ->
                builder.graphQLContext(ctx -> ctx.put(USER_ID_KEY, userId)).build()
            );
        }
        return chain.next(request);
    }
}
