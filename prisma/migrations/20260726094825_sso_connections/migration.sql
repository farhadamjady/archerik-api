-- CreateTable
CREATE TABLE "sso_connections" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" BYTEA NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_domains" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_auth_requests" (
    "state" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_auth_requests_pkey" PRIMARY KEY ("state")
);

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_account_id_key" ON "sso_connections"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sso_domains_domain_key" ON "sso_domains"("domain");

-- CreateIndex
CREATE INDEX "sso_domains_connection_id_idx" ON "sso_domains"("connection_id");

-- CreateIndex
CREATE INDEX "sso_auth_requests_expires_at_idx" ON "sso_auth_requests"("expires_at");

-- AddForeignKey
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "sso_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_auth_requests" ADD CONSTRAINT "sso_auth_requests_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "sso_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
