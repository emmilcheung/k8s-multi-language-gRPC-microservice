package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.OrderResponse;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class FederationConfigTest {

    private final FederationConfig config = new FederationConfig();

    @Test
    void resolveEntity_returnsNullForOrderWhenRequesterMissing() {
        UUID orderId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        OrderResponse order = mock(OrderResponse.class);
        when(order.getUserId()).thenReturn(ownerId);

        Object result = config.resolveEntity(
                Map.of("__typename", "Order", "id", orderId.toString()),
                Map.of(orderId, order),
                null
        );

        assertThat(result).isNull();
    }

    @Test
    void resolveEntity_returnsNullForOrderWhenRequesterIsNotOwner() {
        UUID orderId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        OrderResponse order = mock(OrderResponse.class);
        when(order.getUserId()).thenReturn(ownerId);

        Object result = config.resolveEntity(
                Map.of("__typename", "Order", "id", orderId.toString()),
                Map.of(orderId, order),
                UUID.randomUUID().toString()
        );

        assertThat(result).isNull();
    }

    @Test
    void resolveEntity_returnsOrderForOwner() {
        UUID orderId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        OrderResponse order = mock(OrderResponse.class);
        when(order.getUserId()).thenReturn(ownerId);

        Object result = config.resolveEntity(
                Map.of("__typename", "Order", "id", orderId.toString()),
                Map.of(orderId, order),
                ownerId.toString()
        );

        assertThat(result).isSameAs(order);
    }

    @Test
    void resolveEntity_returnsUserStubForUserReference() {
        Object result = config.resolveEntity(
                Map.of("__typename", "User", "id", UUID.randomUUID().toString()),
                Map.of(),
                null
        );

        assertThat(result).isInstanceOf(Map.class);
        Map<String, Object> userStub = (Map<String, Object>) result;
        assertThat(userStub).containsKey("id");
    }
}