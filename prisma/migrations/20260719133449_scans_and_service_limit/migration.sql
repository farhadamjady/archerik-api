-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "max_services" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "scans" DROP COLUMN "completed_at",
DROP COLUMN "repo",
DROP COLUMN "started_at",
ADD COLUMN     "account_id" UUID NOT NULL,
ADD COLUMN     "baseline_updated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "first_scan" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_id" TEXT NOT NULL,
ADD COLUMN     "sha" VARCHAR(40);

-- CreateIndex
CREATE INDEX "scans_account_id_created_at_idx" ON "scans"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

