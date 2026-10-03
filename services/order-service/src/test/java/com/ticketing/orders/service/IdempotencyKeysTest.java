package com.ticketing.orders.service;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.exception.ValidationFailedException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Derivation rules of the idempotency key. */
class IdempotencyKeysTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void uuidV5_matches_the_rfc4122_reference_vector() {
        // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"). If this drifts, every derived
        // reservationId changes and in-flight retries would double-book.
        UUID dns = UUID.fromString("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
        assertThat(IdempotencyKeys.uuidV5(dns, "python.org").toString())
                .isEqualTo("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    }

    @Test
    void reservationId_is_stable_per_user_and_key_and_differs_across_users() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        assertThat(IdempotencyKeys.reservationId(a, "same-key-001"))
                .isEqualTo(IdempotencyKeys.reservationId(a, "same-key-001"));
        // One user must never be able to collide with (and read) another user's order.
        assertThat(IdempotencyKeys.reservationId(a, "same-key-001"))
                .isNotEqualTo(IdempotencyKeys.reservationId(b, "same-key-001"));
    }

    @Test
    void canonical_json_ignores_key_order_and_whitespace_but_keeps_array_order() throws Exception {
        String a = IdempotencyKeys.canonicalJson(mapper,
                mapper.readTree("{ \"b\": [2, 1], \"a\": {\"y\": 1, \"x\": null} }"));
        String b = IdempotencyKeys.canonicalJson(mapper,
                mapper.readTree("{\"a\":{\"x\":null,\"y\":1},\"b\":[2,1]}"));
        assertThat(a).isEqualTo(b).isEqualTo("{\"a\":{\"x\":null,\"y\":1},\"b\":[2,1]}");
        assertThat(IdempotencyKeys.canonicalJson(mapper, mapper.readTree("[1,2]")))
                .isNotEqualTo(IdempotencyKeys.canonicalJson(mapper, mapper.readTree("[2,1]")));
    }

    @Test
    void fingerprint_changes_when_the_body_changes() {
        CreateOrderRequest one = new CreateOrderRequest();
        one.setTicketId(UUID.randomUUID().toString());
        CreateOrderRequest two = new CreateOrderRequest();
        two.setTicketId(one.getTicketId().toString());
        two.setQuantity(2);
        two.setSeatIds(List.of());

        assertThat(IdempotencyKeys.fingerprint(mapper, one)).hasSize(64)
                .isEqualTo(IdempotencyKeys.fingerprint(mapper, one))
                .isNotEqualTo(IdempotencyKeys.fingerprint(mapper, two));
    }

    @Test
    void requireValid_rejects_out_of_contract_keys() {
        IdempotencyKeys.requireValid("abcdefgh");
        IdempotencyKeys.requireValid("A_b-9".repeat(25));
        for (String bad : List.of("", "abcdefg", "has space", "x".repeat(129), "ünicode-key")) {
            assertThatThrownBy(() -> IdempotencyKeys.requireValid(bad))
                    .as(bad).isInstanceOf(ValidationFailedException.class);
        }
    }
}
