package com.ticketing.orders.graphql;

import com.apollographql.federation.graphqljava.Federation;
import com.apollographql.federation.graphqljava._Entity;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import graphql.schema.TypeResolver;
import org.springframework.boot.graphql.autoconfigure.GraphQlSourceBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Configuration
public class FederationConfig {

    @Bean
    public GraphQlSourceBuilderCustomizer federationTransform(OrderService orderService) {
        TypeResolver entityTypeResolver = env -> {
            Object src = env.getObject();
            if (src instanceof OrderResponse) {
                return env.getSchema().getObjectType("Order");
            }
            if (src instanceof Map) {
                return env.getSchema().getObjectType("User");
            }
            return null;
        };

        return builder -> builder.schemaFactory((registry, wiring) ->
            Federation.transform(registry, wiring)
                .fetchEntities(env -> {
                    List<Map<String, Object>> representations = env.getArgument(_Entity.argumentName);

                    // Collect all Order IDs in one pass so we can batch-load them in
                    // a single DB query instead of one findById() call per entity.
                    List<UUID> orderIds = new ArrayList<>();
                    for (Map<String, Object> ref : representations) {
                        if ("Order".equals(ref.get("__typename"))) {
                            orderIds.add(UUID.fromString((String) ref.get("id")));
                        }
                    }

                    // Single round-trip for all Orders in this _entities call.
                    Map<UUID, OrderResponse> orderMap = orderIds.isEmpty()
                            ? Map.of()
                            : orderService.findByIds(orderIds);

                    String requesterId = env.getGraphQlContext().get(UserIdInterceptor.USER_ID_KEY);

                    return representations.stream()
                        .map(ref -> resolveEntity(ref, orderMap, requesterId))
                        .toList();
                })
                .resolveEntityType(entityTypeResolver)
                .build()
        );
    }

    Object resolveEntity(
            Map<String, Object> reference,
            Map<UUID, OrderResponse> orderMap,
            String requesterId) {
        String typename = (String) reference.get("__typename");
        String id = (String) reference.get("id");

        if ("Order".equals(typename)) {
            if (requesterId == null || requesterId.isBlank()) {
                return null;
            }

            OrderResponse order = orderMap.get(UUID.fromString(id));
            if (order == null) {
                return null;
            }

            if (!order.getUserId().toString().equals(requesterId)) {
                return null;
            }

            return order;
        }

        if ("User".equals(typename)) {
            return Map.of("id", id);
        }

        return null;
    }
}
