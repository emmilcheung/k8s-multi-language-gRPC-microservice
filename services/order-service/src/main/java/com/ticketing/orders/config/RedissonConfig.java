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
                .setRetryInterval(500);
        return Redisson.create(config);
    }
}
