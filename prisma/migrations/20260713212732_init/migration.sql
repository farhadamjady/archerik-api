-- CreateTable
CREATE TABLE "graphs" (
    "id" UUID NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commit_sha" VARCHAR(40) NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "graph_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" UUID NOT NULL,
    "graph_id" UUID NOT NULL,
    "commit_sha" VARCHAR(40) NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_handle" TEXT,
    "author_email" TEXT,
    "message" TEXT NOT NULL,
    "pr" TEXT,
    "branch" TEXT,
    "when" TIMESTAMP(3) NOT NULL,
    "changes" JSONB NOT NULL,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" UUID NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "results" JSONB,
    "error" TEXT,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "graphs_repo_branch_scanned_at_idx" ON "graphs"("repo", "branch", "scanned_at");

-- CreateIndex
CREATE UNIQUE INDEX "graphs_repo_branch_commit_sha_key" ON "graphs"("repo", "branch", "commit_sha");

-- CreateIndex
CREATE INDEX "contracts_graph_id_kind_idx" ON "contracts"("graph_id", "kind");

-- CreateIndex
CREATE INDEX "commits_graph_id_when_idx" ON "commits"("graph_id", "when");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
