CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  email TEXT,
  customer_id TEXT,
  payment_id TEXT UNIQUE,
  product_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | revoked
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS activations (
  license_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (license_id, install_id),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_licenses_payment ON licenses(payment_id);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
