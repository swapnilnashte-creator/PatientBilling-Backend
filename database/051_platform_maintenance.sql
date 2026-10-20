-- Planned maintenance, set by the platform admin (Super Admin > Maintenance). One row only.
-- Before starts_at everyone sees a notice on the sign-in page and inside the app; between starts_at and ends_at the app shows the
-- maintenance page (when block_access is on) and only the platform admin can sign in.
CREATE TABLE IF NOT EXISTS platform_maintenance (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    message VARCHAR(400) NOT NULL DEFAULT '',
    block_access BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_maintenance (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- New table: on a server where migrations run as an admin and the app connects as another user, also run (use your app user name):
-- GRANT SELECT, INSERT, UPDATE ON platform_maintenance TO <app_user>;
