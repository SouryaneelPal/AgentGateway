-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "razorpay_key_id" TEXT NOT NULL,
    "razorpay_key_secret_encrypted" TEXT NOT NULL,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "enabled_protocols" TEXT[] DEFAULT ARRAY['fallback']::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "external_agent_id" TEXT NOT NULL,
    "public_key" TEXT,
    "trust_level" TEXT NOT NULL DEFAULT 'untrusted',
    "spending_limit_paise" BIGINT NOT NULL DEFAULT 0,
    "spent_paise" BIGINT NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "agent_identity_id" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "normalized_amount_paise" BIGINT NOT NULL,
    "normalized_currency" TEXT NOT NULL DEFAULT 'INR',
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_request_id" UUID NOT NULL,
    "mandate_type" TEXT NOT NULL,
    "canonical_payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "limit_paise" BIGINT,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "razorpay_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_request_id" UUID NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "razorpay_payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "razorpay_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_request_id" UUID NOT NULL,
    "protocol_shape" JSONB NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "razorpay_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "payment_request_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_identities_merchant_id_protocol_external_agent_id_key" ON "agent_identities"("merchant_id", "protocol", "external_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_idempotency_key_key" ON "payment_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_payment_requests_status" ON "payment_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mandates_nonce_key" ON "mandates"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "razorpay_orders_razorpay_order_id_key" ON "razorpay_orders"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_razorpay_event_id_key" ON "webhook_events"("razorpay_event_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_payment_request" ON "audit_log"("payment_request_id");

-- AddForeignKey
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_agent_identity_id_fkey" FOREIGN KEY ("agent_identity_id") REFERENCES "agent_identities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_orders" ADD CONSTRAINT "razorpay_orders_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN ADDITIONS — do not drop when regenerating this migration.
--
-- Prisma's schema language cannot express CHECK constraints, and it does not emit
-- NOT NULL for scalar list columns. Everything below restores WHITEPAPER.md §2.3
-- exactly as written, so the database enforces the whitepaper's contract rather than
-- the subset Prisma happens to be able to model.
-- ---------------------------------------------------------------------------

-- §2.3 merchants.enabled_protocols is TEXT[] NOT NULL DEFAULT ARRAY['fallback'].
-- Prisma omits NOT NULL on list columns; restore it.
ALTER TABLE "merchants" ALTER COLUMN "enabled_protocols" SET NOT NULL;

-- CHECK (protocol IN ('x402','ap2','fallback'))
ALTER TABLE "agent_identities"
    ADD CONSTRAINT "agent_identities_protocol_check"
    CHECK (protocol IN ('x402','ap2','fallback'));

-- CHECK (trust_level IN ('untrusted','provisional','trusted'))
ALTER TABLE "agent_identities"
    ADD CONSTRAINT "agent_identities_trust_level_check"
    CHECK (trust_level IN ('untrusted','provisional','trusted'));

-- CHECK (normalized_amount_paise > 0)
ALTER TABLE "payment_requests"
    ADD CONSTRAINT "payment_requests_normalized_amount_paise_check"
    CHECK (normalized_amount_paise > 0);

-- CHECK (status IN ('pending','awaiting_settlement','settled','failed','rejected'))
ALTER TABLE "payment_requests"
    ADD CONSTRAINT "payment_requests_status_check"
    CHECK (status IN ('pending','awaiting_settlement','settled','failed','rejected'));

-- CHECK (status IN ('created','attempted','paid','failed'))
ALTER TABLE "razorpay_orders"
    ADD CONSTRAINT "razorpay_orders_status_check"
    CHECK (status IN ('created','attempted','paid','failed'));

-- CHECK (actor_type IN ('agent','merchant','system'))
ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_type_check"
    CHECK (actor_type IN ('agent','merchant','system'));
