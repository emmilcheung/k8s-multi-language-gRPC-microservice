package com.ticketing.orders.service;

import com.ticketing.orders.exception.ValidationFailedException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Derivations for the {@code Idempotency-Key} header.
 *
 * <p>The namespace is fixed forever: changing it would re-derive every reservationId and
 * silently break replays of in-flight keys. It is not a secret.
 */
public final class IdempotencyKeys {

    public static final UUID ORDER_IDEMPOTENCY_NAMESPACE =
            UUID.fromString("391b5dbc-6e13-461d-9531-c23d7602cb17");

    private static final Pattern KEY_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{8,128}$");

    private IdempotencyKeys() {}

    /** @throws ValidationFailedException (400 VALIDATION_FAILED) when the key is malformed. */
    public static void requireValid(String key) {
        if (!KEY_PATTERN.matcher(key).matches()) {
            throw new ValidationFailedException(
                    "Idempotency-Key must match ^[A-Za-z0-9_-]{8,128}$");
        }
    }

    /** reservationId = UUIDv5(namespace, userId + ":" + key). */
    public static UUID reservationId(UUID userId, String key) {
        return uuidV5(ORDER_IDEMPOTENCY_NAMESPACE, userId + ":" + key);
    }

    /** sha256 (hex) of the canonical JSON of {@code body}. */
    public static String fingerprint(ObjectMapper mapper, Object body) {
        try {
            String canonical = canonicalJson(mapper, mapper.valueToTree(body));
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** Object keys sorted (by UTF-16 code unit), no whitespace; array order is preserved. */
    static String canonicalJson(ObjectMapper mapper, JsonNode node) {
        StringBuilder sb = new StringBuilder();
        appendCanonical(mapper, node, sb);
        return sb.toString();
    }

    private static void appendCanonical(ObjectMapper mapper, JsonNode node, StringBuilder sb) {
        try {
            if (node.isObject()) {
                List<Map.Entry<String, JsonNode>> fields = new ArrayList<>(node.properties());
                fields.sort(Map.Entry.comparingByKey());
                sb.append('{');
                for (int i = 0; i < fields.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    sb.append(mapper.writeValueAsString(fields.get(i).getKey())).append(':');
                    appendCanonical(mapper, fields.get(i).getValue(), sb);
                }
                sb.append('}');
            } else if (node.isArray()) {
                sb.append('[');
                for (int i = 0; i < node.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    appendCanonical(mapper, node.get(i), sb);
                }
                sb.append(']');
            } else {
                sb.append(mapper.writeValueAsString(node));
            }
        } catch (JacksonException e) {
            throw new IllegalStateException("Failed to canonicalise request body", e);
        }
    }

    /** RFC 4122 name-based UUID, version 5 (SHA-1). */
    static UUID uuidV5(UUID namespace, String name) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update(ByteBuffer.allocate(16)
                    .putLong(namespace.getMostSignificantBits())
                    .putLong(namespace.getLeastSignificantBits())
                    .array());
            byte[] h = sha1.digest(name.getBytes(StandardCharsets.UTF_8));
            h[6] = (byte) ((h[6] & 0x0f) | 0x50);
            h[8] = (byte) ((h[8] & 0x3f) | 0x80);
            ByteBuffer bb = ByteBuffer.wrap(h);
            return new UUID(bb.getLong(), bb.getLong());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-1 unavailable", e);
        }
    }
}
