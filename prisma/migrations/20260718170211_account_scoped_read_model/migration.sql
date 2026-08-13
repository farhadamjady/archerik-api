-- DropIndex
DROP INDEX "graphs_repo_branch_commit_sha_key";

-- DropIndex
DROP INDEX "graphs_repo_branch_scanned_at_idx";

-- AlterTable
ALTER TABLE "graphs" DROP COLUMN "repo",
ADD COLUMN     "account_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "account_id" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "graphs_account_id_branch_scanned_at_idx" ON "graphs"("account_id", "branch", "scanned_at");

-- CreateIndex
CREATE UNIQUE INDEX "graphs_account_id_branch_commit_sha_key" ON "graphs"("account_id", "branch", "commit_sha");

-- CreateIndex
CREATE INDEX "users_account_id_idx" ON "users"("account_id");

-- AddForeignKey
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
