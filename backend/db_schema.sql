-- ============================================================
--  Mi Portafolio — Schema Postgres v1
--  Para deploy en Render / Railway / cualquier Postgres ≥14
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  USUARIOS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    nombre          TEXT,
    plan            TEXT NOT NULL DEFAULT 'trial',  -- 'trial', 'premium', 'cancelled'
    trial_end_at    TIMESTAMPTZ,
    mp_subscription_id TEXT,                        -- preapproval_id de MercadoPago
    mp_status       TEXT,                           -- 'pending', 'authorized', 'paused', 'cancelled'
    first_use_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_users_email     ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_plan      ON users(plan)  WHERE deleted_at IS NULL;
CREATE INDEX idx_users_mp_sub    ON users(mp_subscription_id);


-- ============================================================
--  SESIONES (magic-link auth)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,                  -- SHA-256 del token de cookie
    expires_at      TIMESTAMPTZ NOT NULL,
    ip              INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user   ON sessions(user_id);
CREATE INDEX idx_sessions_token  ON sessions(token_hash);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);


-- ============================================================
--  MAGIC LINKS (auth tokens de un solo uso)
-- ============================================================
CREATE TABLE IF NOT EXISTS magic_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_magic_token ON magic_links(token_hash);
CREATE INDEX idx_magic_email ON magic_links(email);


-- ============================================================
--  PORTAFOLIOS (multi por usuario)
-- ============================================================
CREATE TABLE IF NOT EXISTS portafolios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre          TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT 'green',  -- avatar color id
    es_principal    BOOLEAN NOT NULL DEFAULT false,
    tickers         JSONB NOT NULL DEFAULT '[]'::JSONB,   -- array de strings
    pesos           JSONB NOT NULL DEFAULT '{}'::JSONB,   -- {ticker: peso_fraccion}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_port_user       ON portafolios(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uniq_port_principal ON portafolios(user_id) WHERE es_principal = true AND deleted_at IS NULL;


-- ============================================================
--  TRANSACCIONES (compra / venta / dividendo)
-- ============================================================
CREATE TABLE IF NOT EXISTS transacciones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portafolio_id   UUID NOT NULL REFERENCES portafolios(id) ON DELETE CASCADE,
    tipo            TEXT NOT NULL CHECK (tipo IN ('compra', 'venta', 'dividendo')),
    ticker          TEXT NOT NULL,
    fecha           DATE NOT NULL,
    shares          NUMERIC(20, 8) NOT NULL,
    precio          NUMERIC(20, 8) NOT NULL,
    moneda          TEXT NOT NULL DEFAULT 'USD',
    comision        NUMERIC(20, 4) DEFAULT 0,
    notas           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_portafolio ON transacciones(portafolio_id);
CREATE INDEX idx_tx_fecha      ON transacciones(portafolio_id, fecha);


-- ============================================================
--  CONFIG DE ALERTAS (una fila por usuario)
-- ============================================================
CREATE TABLE IF NOT EXISTS alertas_config (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    destinatario    TEXT,                           -- email destino (puede diferir del email de la cuenta)
    drift_active    BOOLEAN NOT NULL DEFAULT false,
    precio_active   BOOLEAN NOT NULL DEFAULT false,
    semanal_active  BOOLEAN NOT NULL DEFAULT false,
    drift_umbral_pp NUMERIC(5,2) DEFAULT 5.0,
    precio_umbral_pct NUMERIC(5,2) DEFAULT 5.0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
--  SNAPSHOTS DE PORTAFOLIO (para tareas programadas)
--  Reemplaza portafolio_snapshot.json
-- ============================================================
CREATE TABLE IF NOT EXISTS portafolio_snapshots (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    snapshot        JSONB NOT NULL,                 -- {pesos, posiciones, transacciones, metricas...}
    actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
--  EVENTOS DE PAGO (auditoría MercadoPago webhooks)
-- ============================================================
CREATE TABLE IF NOT EXISTS pagos_eventos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    mp_event_id     TEXT,
    mp_topic        TEXT,                           -- 'preapproval', 'payment', etc.
    mp_status       TEXT,
    raw_payload     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pagos_user ON pagos_eventos(user_id);
CREATE INDEX idx_pagos_event ON pagos_eventos(mp_event_id);


-- ============================================================
--  WRAP MENSUAL (para no mostrar dos veces al mismo usuario)
-- ============================================================
CREATE TABLE IF NOT EXISTS wraps_mostrados (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    yyyymm          TEXT NOT NULL,                  -- "2026-05"
    mostrado_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, yyyymm)
);


-- ============================================================
--  TRIGGERS — updated_at automático
-- ============================================================
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER tr_users_updated      BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION update_modified_column();
CREATE TRIGGER tr_portafolios_updated BEFORE UPDATE ON portafolios FOR EACH ROW EXECUTE FUNCTION update_modified_column();
CREATE TRIGGER tr_alertas_updated    BEFORE UPDATE ON alertas_config FOR EACH ROW EXECUTE FUNCTION update_modified_column();


-- ============================================================
--  CLEANUP automático (tareas que el cron debe correr)
-- ============================================================
-- Ejemplos de queries para correr periódicamente:
--   DELETE FROM sessions WHERE expires_at < now();
--   DELETE FROM magic_links WHERE expires_at < now() OR used_at IS NOT NULL;
--   UPDATE users SET deleted_at = now() WHERE plan = 'cancelled' AND updated_at < now() - INTERVAL '5 years';
