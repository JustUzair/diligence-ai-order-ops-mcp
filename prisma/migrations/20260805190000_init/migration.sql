-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "order_sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "payment_status" TEXT NOT NULL,
    "fulfillment_status" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "assigned_team" TEXT NOT NULL,
    "is_active_exception" BOOLEAN NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "seed_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolution_proposals" (
    "id" TEXT NOT NULL,
    "order_internal_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "expected_changes" JSONB NOT NULL,
    "risk" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "confirmation_key" TEXT,
    "confirmation_result" JSONB,

    CONSTRAINT "resolution_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_audit_events" (
    "id" UUID NOT NULL,
    "order_internal_id" UUID NOT NULL,
    "proposal_id" TEXT,
    "event_type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "payload" JSONB NOT NULL,
    "request_id" TEXT,

    CONSTRAINT "order_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_metadata" (
    "id" UUID NOT NULL,
    "dataset_name" TEXT NOT NULL,
    "dataset_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seed_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_number_sequences" (
    "name" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_number_sequences_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");
CREATE UNIQUE INDEX "orders_order_sequence_key" ON "orders"("order_sequence");
CREATE UNIQUE INDEX "orders_seed_key_key" ON "orders"("seed_key");
CREATE INDEX "orders_is_active_exception_priority_idx" ON "orders"("is_active_exception", "priority");
CREATE INDEX "orders_updated_at_idx" ON "orders"("updated_at");
CREATE UNIQUE INDEX "resolution_proposals_confirmation_key_key" ON "resolution_proposals"("confirmation_key");
CREATE INDEX "resolution_proposals_order_internal_id_status_idx" ON "resolution_proposals"("order_internal_id", "status");
CREATE INDEX "order_audit_events_order_internal_id_occurred_at_idx" ON "order_audit_events"("order_internal_id", "occurred_at");
CREATE INDEX "order_audit_events_proposal_id_idx" ON "order_audit_events"("proposal_id");
CREATE UNIQUE INDEX "seed_metadata_dataset_name_dataset_version_key" ON "seed_metadata"("dataset_name", "dataset_version");

-- AddForeignKey
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_order_internal_id_fkey" FOREIGN KEY ("order_internal_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_audit_events" ADD CONSTRAINT "order_audit_events_order_internal_id_fkey" FOREIGN KEY ("order_internal_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
