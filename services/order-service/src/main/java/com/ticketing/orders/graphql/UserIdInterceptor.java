package com.ticketing.orders.graphql;

import com.ticketing.orders.security.UserIdSignatureValidator;
import org.springframework.graphql.server.WebGraphQlInterceptor;
import org.springframework.graphql.server.WebGraphQlRequest;
import org.springframework.graphql.server.WebGraphQlResponse;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Propagates the x-user-id HTTP header into the GraphQL context so that
 * @QueryMapping/@MutationMapping handlers can access it via GraphQLContext.
 *
 * Validates the x-user-id-sig header using HMAC-SHA256. If signature validation
 * fails or the signature is missing when signing is configured, the userId is
 * not added to the context, effectively treating the request as unauthenticated.
 */
@Component
public class UserIdInterceptor implements WebGraphQlInterceptor {

    static final String USER_ID_KEY = "x-user-id";
    private final UserIdSignatureValidator signatureValidator;

    public UserIdInterceptor(UserIdSignatureValidator signatureValidator) {
        this.signatureValidator = signatureValidator;
    }

    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        String userId = request.getHeaders().getFirst("x-user-id");
        if (userId == null) userId = request.getHeaders().getFirst("X-User-Id");

        if (userId != null) {
            String signature = request.getHeaders().getFirst("x-user-id-sig");
            if (signature == null) signature = request.getHeaders().getFirst("X-User-Id-Sig");

            if (!signatureValidator.isValidSignature(userId, signature)) {
                // Signature validation failed; do not set userId in context.
                // Downstream handlers will see userId as null (unauthenticated).
                return chain.next(request);
            }

            final String uid = userId;
            request.configureExecutionInput((input, builder) ->
                builder.graphQLContext(ctx -> ctx.put(USER_ID_KEY, uid)).build()
            );
        }
        return chain.next(request);
    }
}
