import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { z } from "zod";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { GrpcModule } from "./grpc/grpc.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { UserSettingsModule } from "./modules/user-settings/user-settings.module";
import { UserGraphQLModule } from "./graphql/graphql.module";

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3004),
    GRPC_PORT: z.coerce.number().int().min(1).max(65535).default(50053),
    DATABASE_URL: z.string(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(12),
    X_USER_ID_SIGNING_KEY: z.string().optional().default(""),
    // Origin used to build invitation links; unset gives a path-only link.
    PUBLIC_WEB_URL: z
      .string()
      .url()
      .refine(
        (u) => /^https?:\/\//i.test(u),
        "PUBLIC_WEB_URL must be http or https",
      )
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (config.GRPC_PORT === config.PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GRPC_PORT"],
        message: "GRPC_PORT must differ from PORT",
      });
    }
    if (
      config.NODE_ENV === "production" &&
      (!config.X_USER_ID_SIGNING_KEY ||
        config.X_USER_ID_SIGNING_KEY.length < 32)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["X_USER_ID_SIGNING_KEY"],
        message:
          "X_USER_ID_SIGNING_KEY must be at least 32 characters in production",
      });
    }
  });

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const result = envSchema.safeParse(config);
        if (!result.success) {
          throw new Error(
            `Config validation failed:\n${result.error.issues
              .map((e) => `  ${e.path.join(".")}: ${e.message}`)
              .join("\n")}`,
          );
        }
        return result.data;
      },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get("NODE_ENV") === "production" ? "info" : "debug",
          transport:
            config.get("NODE_ENV") !== "production"
              ? { target: "pino-pretty", options: { colorize: true } }
              : undefined,
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["x-user-id-sig"]',
          ],
          serializers: {
            req(req: { method: string; url: string }) {
              return { method: req.method, url: req.url };
            },
          },
        },
      }),
    }),
    DatabaseModule,
    HealthModule,
    MetricsModule,
    UserSettingsModule,
    AccountsModule,
    UserGraphQLModule,
    GrpcModule,
  ],
})
export class AppModule {}
