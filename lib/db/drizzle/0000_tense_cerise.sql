CREATE TABLE "email_verifications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" varchar NOT NULL,
	"provider_account_id" varchar NOT NULL,
	"provider_email" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"password_hash" varchar,
	"email_verified_at" timestamp with time zone,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"plan" varchar DEFAULT 'free' NOT NULL,
	"stripe_customer_id" varchar,
	"stripe_subscription_id" varchar,
	"render_count" integer DEFAULT 0 NOT NULL,
	"render_reset_at" timestamp with time zone,
	"ai_count" integer DEFAULT 0 NOT NULL,
	"ai_reset_at" timestamp with time zone,
	"distributed_render_count" integer DEFAULT 0 NOT NULL,
	"distributed_render_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "processed_stripe_events" (
	"id" varchar PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_subscriptions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"customer_id" varchar NOT NULL,
	"status" varchar NOT NULL,
	"price_id" varchar,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"event_ts" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"module" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"duration" integer DEFAULT 30 NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"module" text NOT NULL,
	"template_id" integer,
	"brand_kit_id" integer,
	"thumbnail_url" text,
	"video_url" text,
	"duration" integer,
	"render_error" text,
	"composition_vars" jsonb,
	"composition_html" text,
	"render_settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_kit" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"name" text DEFAULT 'Brand kit' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source_url" text,
	"logo_url" text,
	"primary_color" text DEFAULT '#6366f1' NOT NULL,
	"secondary_color" text DEFAULT '#8b5cf6' NOT NULL,
	"accent_color" text,
	"font_family" text DEFAULT 'Inter' NOT NULL,
	"company_name" text,
	"brand_voice" text,
	"voice_description" text,
	"tagline" text,
	"description" text,
	"value_proposition" text,
	"target_audience" text,
	"industry" text,
	"keywords" jsonb,
	"personality" jsonb,
	"image_style" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"features" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "modules_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"backend" varchar DEFAULT 'inline' NOT NULL,
	"external_id" varchar,
	"status" varchar DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer,
	"format" varchar,
	"config" jsonb,
	"output_path" text,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avatar_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" varchar,
	"sandbox" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kit" ADD CONSTRAINT "brand_kit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar_sessions" ADD CONSTRAINT "avatar_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_email_verifications_user" ON "email_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_email_verifications_token" ON "email_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_oauth_accounts_provider_account" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "IDX_oauth_accounts_user" ON "oauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_password_resets_user" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_password_resets_token" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "IDX_session_user" ON "sessions" USING btree ((("sess"->>'userId')));--> statement-breakpoint
CREATE INDEX "IDX_stripe_subscriptions_customer" ON "stripe_subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "IDX_projects_user" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_brand_kit_user" ON "brand_kit" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_brand_kit_default" ON "brand_kit" USING btree ("user_id") WHERE "brand_kit"."is_default";--> statement-breakpoint
CREATE INDEX "IDX_render_jobs_project" ON "render_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "IDX_render_jobs_backend_status" ON "render_jobs" USING btree ("backend","status");--> statement-breakpoint
CREATE INDEX "IDX_avatar_sessions_user" ON "avatar_sessions" USING btree ("user_id","created_at");