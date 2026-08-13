-- CreateTable
CREATE TABLE "identity_map_entries" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "repository" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "hosts" TEXT[],
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "sha" VARCHAR(40),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_map_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_map_entries_account_id_idx" ON "identity_map_entries"("account_id");

-- CreateIndex
CREATE INDEX "identity_map_entries_account_id_repository_idx" ON "identity_map_entries"("account_id", "repository");

-- AddForeignKey
ALTER TABLE "identity_map_entries" ADD CONSTRAINT "identity_map_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
