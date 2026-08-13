-- CreateTable
CREATE TABLE "llm_provider_keys" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "key_enc" BYTEA NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_provider_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_provider_keys_account_id_idx" ON "llm_provider_keys"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_provider_keys_account_id_provider_key" ON "llm_provider_keys"("account_id", "provider");

-- AddForeignKey
ALTER TABLE "llm_provider_keys" ADD CONSTRAINT "llm_provider_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
