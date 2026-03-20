package com.ticketing.orders.statemachine;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.statemachine.config.EnableStateMachineFactory;
import org.springframework.statemachine.config.StateMachineConfigurerAdapter;
import org.springframework.statemachine.config.StateMachineFactory;
import org.springframework.statemachine.config.builders.StateMachineStateConfigurer;
import org.springframework.statemachine.config.builders.StateMachineTransitionConfigurer;

import java.util.EnumSet;

/**
 * Order lifecycle state machine:
 *
 *  CREATED ──[CANCEL]──────────────────────────────────► CANCELLED
 *     │
 *     └──[auto on creation]──► AWAITING_PAYMENT ──[CANCEL]──────► CANCELLED
 *                                     │
 *                                     └──[PAYMENT_CAPTURED]──► COMPLETE
 */
@Configuration
@EnableStateMachineFactory
public class OrderStateMachineConfig extends StateMachineConfigurerAdapter<OrderState, OrderEvent> {

    @Override
    public void configure(StateMachineStateConfigurer<OrderState, OrderEvent> states) throws Exception {
        states.withStates()
                .initial(OrderState.CREATED)
                .states(EnumSet.allOf(OrderState.class))
                .end(OrderState.COMPLETE)
                .end(OrderState.CANCELLED);
    }

    @Override
    public void configure(StateMachineTransitionConfigurer<OrderState, OrderEvent> transitions) throws Exception {
        transitions
                // CREATED → AWAITING_PAYMENT happens automatically on creation (done in service layer)
                .withExternal()
                    .source(OrderState.CREATED).target(OrderState.AWAITING_PAYMENT)
                    .event(OrderEvent.CANCEL)   // guard prevents this; here just to allow machine init
                    .and()
                .withExternal()
                    .source(OrderState.CREATED).target(OrderState.CANCELLED)
                    .event(OrderEvent.CANCEL)
                    .and()
                .withExternal()
                    .source(OrderState.AWAITING_PAYMENT).target(OrderState.CANCELLED)
                    .event(OrderEvent.CANCEL)
                    .and()
                .withExternal()
                    .source(OrderState.AWAITING_PAYMENT).target(OrderState.COMPLETE)
                    .event(OrderEvent.PAYMENT_CAPTURED);
    }
}
