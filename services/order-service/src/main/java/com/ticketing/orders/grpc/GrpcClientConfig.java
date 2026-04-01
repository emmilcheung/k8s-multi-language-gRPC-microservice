package com.ticketing.orders.grpc;

import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.TimeUnit;

@Configuration
public class GrpcClientConfig {

    @Value("${grpc.ticket-service.host}")
    private String ticketServiceHost;

    @Value("${grpc.ticket-service.port}")
    private int ticketServicePort;

    @Value("${grpc.venue-service.host}")
    private String venueServiceHost;

    @Value("${grpc.venue-service.port}")
    private int venueServicePort;

    // ── ticket-service ─────────────────────────────────────────────────────────

    @Bean(destroyMethod = "shutdown")
    public ManagedChannel ticketServiceChannel() {
        return ManagedChannelBuilder
                .forAddress(ticketServiceHost, ticketServicePort)
                .usePlaintext()
                .keepAliveTime(30, TimeUnit.SECONDS)
                .keepAliveTimeout(5, TimeUnit.SECONDS)
                .build();
    }

    @Bean
    public TicketServiceGrpc.TicketServiceBlockingStub ticketServiceStub(ManagedChannel ticketServiceChannel) {
        return TicketServiceGrpc.newBlockingStub(ticketServiceChannel);
    }

    // ── venue-service ──────────────────────────────────────────────────────────

    @Bean(name = "venueServiceChannel", destroyMethod = "shutdown")
    public ManagedChannel venueServiceChannel() {
        return ManagedChannelBuilder
                .forAddress(venueServiceHost, venueServicePort)
                .usePlaintext()
                .keepAliveTime(30, TimeUnit.SECONDS)
                .keepAliveTimeout(5, TimeUnit.SECONDS)
                .build();
    }

    @Bean
    public VenueServiceGrpc.VenueServiceBlockingStub venueServiceStub(
            @org.springframework.beans.factory.annotation.Qualifier("venueServiceChannel")
            ManagedChannel venueServiceChannel) {
        return VenueServiceGrpc.newBlockingStub(venueServiceChannel);
    }
}
