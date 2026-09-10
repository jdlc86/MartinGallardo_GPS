do $$
declare
  v_evidence_count integer;
  v_history_count integer;
begin
  select count(*) into v_evidence_count
  from public.maintenance_tasks
  where task_key = 'purge_delivered_stay_evidence'
    and function_slug = 'delivered-stay-retention-cleanup';

  select count(*) into v_history_count
  from public.maintenance_tasks
  where task_key = 'purge_delivered_stay_history'
    and function_slug = 'delivered-stay-history-cleanup';

  if v_evidence_count <> 1 then
    raise exception 'expected delivered-stay evidence retention task not found or drifted';
  end if;

  if v_history_count <> 1 then
    raise exception 'expected delivered-stay history retention task not found or drifted';
  end if;

  update public.maintenance_tasks
  set enabled = true,
      config = jsonb_set(coalesce(config, '{}'::jsonb), '{execute}', 'true'::jsonb, true)
  where task_key = 'purge_delivered_stay_evidence'
    and function_slug = 'delivered-stay-retention-cleanup';

  update public.maintenance_tasks
  set enabled = true,
      config = jsonb_set(coalesce(config, '{}'::jsonb), '{execute}', 'true'::jsonb, true)
  where task_key = 'purge_delivered_stay_history'
    and function_slug = 'delivered-stay-history-cleanup';
end
$$;
