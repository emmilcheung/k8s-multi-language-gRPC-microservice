package com.ticketing.orders.exception;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<Map<String, Object>> handleNotFound(NotFoundException ex) {
        return error(HttpStatus.NOT_FOUND, "NOT_FOUND", ex.getMessage(), List.of());
    }

    @ExceptionHandler(BadRequestException.class)
    public ResponseEntity<Map<String, Object>> handleBadRequest(BadRequestException ex) {
        return error(HttpStatus.BAD_REQUEST, "BAD_REQUEST", ex.getMessage(), List.of());
    }

    @ExceptionHandler(ForbiddenException.class)
    public ResponseEntity<Map<String, Object>> handleForbidden(ForbiddenException ex) {
        return error(HttpStatus.FORBIDDEN, "FORBIDDEN", ex.getMessage(), List.of());
    }

    @ExceptionHandler(ConflictException.class)
    public ResponseEntity<Map<String, Object>> handleConflict(ConflictException ex) {
        return error(HttpStatus.CONFLICT, "CONFLICT", ex.getMessage(), List.of());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex) {
        List<Map<String, String>> details = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> Map.of("field", fe.getField(), "issue", String.valueOf(fe.getDefaultMessage())))
                .toList();
        return error(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Validation failed", details);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Map<String, Object>> handleConstraint(ConstraintViolationException ex) {
        return error(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", ex.getMessage(), List.of());
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public ResponseEntity<Map<String, Object>> handleMissingHeader(MissingRequestHeaderException ex) {
        // X-User-Id is injected by Kong after JWT validation. Its absence means the
        // request bypassed the gateway or the token was not provided — treat as 401.
        if ("X-User-Id".equalsIgnoreCase(ex.getHeaderName())) {
            return error(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Authentication required", List.of());
        }
        return error(HttpStatus.BAD_REQUEST, "BAD_REQUEST", ex.getMessage(), List.of());
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handleResponseStatus(ResponseStatusException ex) {
        if (ex.getStatusCode().is5xxServerError()) {
            log.error("Service error: {}", ex.getReason(), ex);
        }
        String code = ex.getStatusCode().is5xxServerError() ? "SERVICE_UNAVAILABLE" : "REQUEST_FAILED";
        return ResponseEntity.status(ex.getStatusCode()).body(Map.of(
                "error", Map.of("code", code,
                        "message", ex.getReason() != null ? ex.getReason() : "Request failed",
                        "details", List.of())
        ));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneric(Exception ex) {
        log.error("Unhandled exception", ex);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "An unexpected error occurred", List.of());
    }

    private ResponseEntity<Map<String, Object>> error(HttpStatus status, String code, String message, Object details) {
        return ResponseEntity.status(status).body(Map.of(
                "error", Map.of("code", code, "message", message, "details", details)
        ));
    }
}
