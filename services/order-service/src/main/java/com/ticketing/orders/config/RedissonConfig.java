package com.ticketing.orders.config;

import org.redisson.Redisson;
import org.redisson.api.RedissonClient;
import org.redisson.config.Config;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RedissonConfig {

    @Value("${redis.url:redis://localhost:6379}")
    private String redisUrl;

    @Bean(destroyMethod = "shutdown")
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
                .setAddress(redisUrl)
                .setConnectTimeout(1000)
                .setTimeout(1000)
                .setRetryAttempts(2)
                .setRetryInterval(500)
                // RedissonClient is used only for distributed locking (currently replaced by
                // gRPC reserve-quota). Disable keepalive PINGs so Redisson 4.0's built-in
                // OTel instrumentation does not generate spurious Jaeger spans every 30 s.
                .setPingConnectionInterval(0);
        return Redisson.create(config);
    }
}
