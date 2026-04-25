CREATE TABLE "wallet_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"nonce" text NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wallet_challenges_expiresAt_index" ON "wallet_challenges" USING btree ("expiresAt");