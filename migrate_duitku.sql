-- Run after migrate_payment_verification.sql and migrate_gopay_merchant.sql.
-- This table stores invoice identifiers, never credentials.
CREATE TABLE IF NOT EXISTS duitku_invoices (
  merchant_order_id VARCHAR(50) NOT NULL PRIMARY KEY,
  session_code VARCHAR(100) NOT NULL,
  merchant_code VARCHAR(50) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference VARCHAR(150) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uq_duitku_session (session_code),
  UNIQUE KEY uq_duitku_reference (reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
