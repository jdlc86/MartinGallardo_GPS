-- Restrict SECURITY DEFINER RPCs to backend/service-role callers.
revoke execute on function public.parking_booking_operational_snapshot(bigint)
  from public, anon, authenticated;

revoke execute on function public.vehicle_lifecycle_search(bigint, text)
  from public, anon, authenticated;

revoke execute on function public.vehicle_lifecycle_snapshot(bigint)
  from public, anon, authenticated;

grant execute on function public.parking_booking_operational_snapshot(bigint)
  to service_role;

grant execute on function public.vehicle_lifecycle_search(bigint, text)
  to service_role;

grant execute on function public.vehicle_lifecycle_snapshot(bigint)
  to service_role;
