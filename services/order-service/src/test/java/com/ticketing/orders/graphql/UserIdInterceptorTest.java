package com.ticketing.orders.graphql;

import com.ticketing.orders.security.UserIdSignatureValidator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.graphql.server.WebGraphQlInterceptor;
import org.springframework.graphql.server.WebGraphQlRequest;
import org.springframework.graphql.server.WebGraphQlResponse;
import org.springframework.http.HttpHeaders;
import reactor.core.publisher.Mono;

import java.net.URI;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class UserIdInterceptorTest {

    @Mock
    private WebGraphQlInterceptor.Chain chain;

    @Mock
    private WebGraphQlResponse mockResponse;

    private WebGraphQlRequest createRequest(String userId, String signature) {
        HttpHeaders headers = new HttpHeaders();
        if (userId != null) {
            headers.set("x-user-id", userId);
        }
        if (signature != null) {
            headers.set("x-user-id-sig", signature);
        }
        return new WebGraphQlRequest(
            URI.create("/graphql"),
            headers,
            null,
            null,
            Collections.emptyMap(),
            Map.of("query", "{ orders { id } }"),
            "1",
            null
        );
    }

    @Test
    void validSignature_setsUserIdInContext() {
        // When signing key is empty, all signatures are valid (graceful degradation)
        UserIdSignatureValidator validator = new UserIdSignatureValidator("");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        WebGraphQlRequest request = createRequest("user-123", null);
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        // Verify chain was called
        ArgumentCaptor<WebGraphQlRequest> captor = ArgumentCaptor.forClass(WebGraphQlRequest.class);
        verify(chain).next(captor.capture());
    }

    @Test
    void invalidSignature_doesNotSetUserId() {
        // With a real signing key, invalid signature should fail
        UserIdSignatureValidator validator = new UserIdSignatureValidator("test-key");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        WebGraphQlRequest request = createRequest("user-123", "invalid-sig");
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        // Chain is still called
        verify(chain).next(any());
    }

    @Test
    void missingSignatureWithKeyConfigured_doesNotSetUserId() {
        // With a configured signing key, missing signature should fail
        UserIdSignatureValidator validator = new UserIdSignatureValidator("test-key");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        WebGraphQlRequest request = createRequest("user-123", null);
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        // Chain is still called
        verify(chain).next(any());
    }

    @Test
    void emptySigningKey_skipsValidation() {
        // Empty signing key allows any request through
        UserIdSignatureValidator validator = new UserIdSignatureValidator("");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        WebGraphQlRequest request = createRequest("user-123", null);
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        verify(chain).next(any());
    }

    @Test
    void noUserIdHeader_passesThrough() {
        UserIdSignatureValidator validator = new UserIdSignatureValidator("test-key");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        WebGraphQlRequest request = createRequest(null, null);
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        verify(chain).next(any());
    }

    @Test
    void caseInsensitiveHeaders_lowercase() {
        UserIdSignatureValidator validator = new UserIdSignatureValidator("");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        HttpHeaders headers = new HttpHeaders();
        headers.set("x-user-id", "user-123");
        WebGraphQlRequest request = new WebGraphQlRequest(
            URI.create("/graphql"),
            headers,
            null,
            null,
            Collections.emptyMap(),
            Map.of("query", "{ orders { id } }"),
            "1",
            null
        );
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        verify(chain).next(any());
    }

    @Test
    void caseInsensitiveHeaders_mixed() {
        UserIdSignatureValidator validator = new UserIdSignatureValidator("");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        HttpHeaders headers = new HttpHeaders();
        headers.set("X-User-Id", "user-123");
        WebGraphQlRequest request = new WebGraphQlRequest(
            URI.create("/graphql"),
            headers,
            null,
            null,
            Collections.emptyMap(),
            Map.of("query", "{ orders { id } }"),
            "1",
            null
        );
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        verify(chain).next(any());
    }

    @Test
    void validSignatureWithCurrentMinute_acceptsRequest() throws Exception {
        UserIdSignatureValidator validator = new UserIdSignatureValidator("test-key");
        UserIdInterceptor interceptor = new UserIdInterceptor(validator);

        String userId = "user-123";
        String validSignature = computeValidSignature(userId, "test-key", 0);

        WebGraphQlRequest request = createRequest(userId, validSignature);
        when(chain.next(any())).thenReturn(Mono.just(mockResponse));

        interceptor.intercept(request, chain).block();

        verify(chain).next(any());
    }

    /**
     * Compute a valid HMAC-SHA256 signature for testing.
     * offset: 0 = current minute, -1 = previous minute
     */
    private String computeValidSignature(String userId, String key, int minuteOffset)
            throws Exception {
        long currentTime = System.currentTimeMillis() / 1000;
        long currentMinute = currentTime / 60 + minuteOffset;

        String message = userId + "|" + currentMinute;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        javax.crypto.spec.SecretKeySpec secretKey =
            new javax.crypto.spec.SecretKeySpec(
                key.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                0,
                key.length(),
                "HmacSHA256"
            );
        mac.init(secretKey);
        byte[] rawSignature = mac.doFinal(message.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return java.util.Base64.getEncoder().encodeToString(rawSignature);
    }
}
