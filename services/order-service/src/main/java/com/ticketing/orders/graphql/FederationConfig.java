package com.ticketing.orders.graphql;

import com.apollographql.federation.graphqljava.Federation;
import com.apollographql.federation.graphqljava._Entity;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import graphql.schema.TypeResolver;
import org.springframework.boot.graphql.autoconfigure.GraphQlSourceBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

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
                    return representations.stream()
                        .map(ref -> {
                            String typename = (String) ref.get("__typename");
                            String id = (String) ref.get("id");
                            if ("Order".equals(typename)) {
                                return orderService.findById(UUID.fromString(id));
                            }
                            if ("User".equals(typename)) {
                                return Map.of("id", id);
                            }
                            return null;
                        })
                        .toList();
                })
                .resolveEntityType(entityTypeResolver)
                .build()
        );
    }
}
