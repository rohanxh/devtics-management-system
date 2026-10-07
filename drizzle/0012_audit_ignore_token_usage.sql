-- Token usage timestamps are operational noise, not business changes: exclude them from row audit.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  req text := NULLIF(current_setting('app.request_id', true), '');
  redact text[] := ARRAY['password_hash', 'token_hash'];
  ignored text[] := ARRAY['updated_at', 'last_login_at', 'last_seen_at', 'last_used_at'];
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
