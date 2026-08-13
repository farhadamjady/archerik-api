-- Re-key service baselines by (account, repository, service_id, default_branch). `service_id` is
-- only the repo's directory name and collides across repos, so `repository` joins the uniqueness
-- key to stop cross-repo baselines from clobbering one another. Existing rows backfill repository=''.

-- DropIndex
DROP INDEX "service_baselines_account_id_service_id_default_branch_key";

-- AlterTable
ALTER TABLE "service_baselines" ADD COLUMN     "repository" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "service_baselines_account_id_repository_idx" ON "service_baselines"("account_id", "repository");

-- CreateIndex
CREATE UNIQUE INDEX "service_baselines_account_id_repository_service_id_default__key" ON "service_baselines"("account_id", "repository", "service_id", "default_branch");
