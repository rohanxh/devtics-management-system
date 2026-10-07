-- Row-level audit trail enforced by the database.
-- The application identifies the actor per transaction with:
--   select set_config('app.user_id', '<uuid>', true), set_config('app.request_id', '<id>', true)
-- Writes that bypass the service layer are still recorded (actor = NULL → "system").

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  req text := NULLIF(current_setting('app.request_id', true), '');
  redact text[] := ARRAY['password_hash', 'token_hash'];
  ignored text[] := ARRAY['updated_at', 'last_login_at', 'last_seen_at'];
  old_j jsonb;
  new_j jsonb;
  changed text[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_j := to_jsonb(OLD) - redact; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_j := to_jsonb(NEW) - redact; END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO changed
      FROM jsonb_each(new_j) n
     WHERE n.value IS DISTINCT FROM old_j -> n.key
       AND NOT (n.key = ANY (ignored));
    IF changed IS NULL THEN
      RETURN NEW; -- nothing meaningful changed
    END IF;
  END IF;

  INSERT INTO audit_logs (actor_user_id, action, table_name, record_id, old_data, new_data, changed_fields, request_id)
  VALUES (actor, TG_OP, TG_TABLE_NAME, COALESCE(new_j ->> 'id', old_j ->> 'id'), old_j, new_j, changed, req);

  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_mutation BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint

-- Attaches the audit trigger to every business table that does not have it yet.
-- Called after every migration run, so tables added in later migrations are covered automatically.
CREATE OR REPLACE FUNCTION attach_audit_triggers() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT IN ('audit_logs', 'domain_events', 'notifications', 'sessions', 'activities', 'saved_views')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'zz_audit')
  LOOP
    EXECUTE format('CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t.relname);
  END LOOP;
END $$;
