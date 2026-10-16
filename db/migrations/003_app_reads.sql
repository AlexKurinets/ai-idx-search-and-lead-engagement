-- The public listing page shows when each feed last synced (an IDX display requirement),
-- so the app role may read replication state. It holds no tenant data.
GRANT SELECT ON replication_state TO idx_app;
