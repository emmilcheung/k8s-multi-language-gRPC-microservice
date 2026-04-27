import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { z } from "zod";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { UserSettingsModule } from "./modules/user-settings/user-settings.module";
import { UserGraphQLModule } from "./graphql/graphql.module";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3004),
    DATABASE_URL: z.string(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    X_USER_ID_SIGNING_KEY: z.string().optional().default(""),
  })
  .superRefine((config, ctx) => {
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
    UserSettingsModule,
    UserGraphQLModule,
  ],
})
export class AppModule {}
