-- Replay depends on retaining every Message creation position.
CREATE FUNCTION public.fukulow_forbid_message_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Message rows must never be removed with %', TG_OP;
END;
$$;

-- A row trigger also fires for rows deleted by a foreign key cascade.
CREATE TRIGGER messages_forbid_delete BEFORE DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.fukulow_forbid_message_removal();

CREATE TRIGGER messages_forbid_truncate BEFORE TRUNCATE ON public.messages
FOR EACH STATEMENT EXECUTE FUNCTION public.fukulow_forbid_message_removal();
