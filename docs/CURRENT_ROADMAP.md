## Prioridad Optimizer V2 — estado actual

### Fase 1 estable

Completada y conectada a la Mini App en modo propuesta:

- Back-Forward rolling horizon 24/7;
- Fast/Optimal consolidados;
- worker Docker externo a Edge Functions;
- cola durable `optimization_jobs`;
- Realtime + reconciliación puntual, sin polling;
- informes operativos expandibles;
- tareas no asignadas visibles como trabajo manual pendiente;
- propuestas rechazadas no se recargan;
- controles de optimización bloqueados mientras hay job activo;
- 0 errores físicos como condición de aceptación.

Referencia: Fast 221/300; Optimal 223/300.

### Pendiente antes de considerar Fase 2 estable

1. terminar benchmark reproducible de reoptimización local sobre los `not_proven`;
2. medir cobertura antes/después, mejoras reales y swaps seguros;
3. mantener `coverage_new >= coverage_old` y 0 errores físicos;
4. benchmark específico de una semana completa antes de fijar el límite de tiempo definitivo del worker;
5. automatizar actualización/rollback del contenedor de producción después de estabilizar la operación real.

### Fase 2

Continúa **experimental**. No debe incorporarse silenciosamente a `solve()` ni alterar el benchmark/score de Fase 1.

# Roadmap técnico vigente

Este documento contiene solo trabajo pendiente del sistema de producción actual.

## Prioridad 0 — Seguridad de base de datos

### Resuelto: `plate_verifications`

El 2026-09-04 se habilitó RLS y se revocó el acceso directo de `anon/authenticated`. El acceso de producción queda backend-only mediante service-role. Debe mantenerse el smoke test de Recogida, Aparcar, Entrega, Expediente e informe de vehículo.

### Resuelto: vista `telegram_access_requests_visible_rejected`

El 2026-09-04 se cambió a `SECURITY INVOKER`, se revocó el acceso directo de `anon/authenticated` y quedó backend-only mediante `service_role`. El Security Advisor ya no reporta `security_definer_view` para esta vista.

### 2. Funciones históricas con `search_path` mutable

Endurecer tras revisar dependencias:

- `protect_owner_telegram_user`;
- `sync_access_request_when_user_exists`;
- `set_access_request_expiry`;
- `set_access_request_rejected_at`;
- `reopen_rejected_access_request_on_new_contact`;
- `sync_access_request_with_active_user`;
- `enforce_access_request_user_state`.

### Resuelto: `expire_pending_access_requests()`

El 2026-09-04 se revocó `EXECUTE` a `PUBLIC`, `anon` y `authenticated`; el cron interno `expire_telegram_access_requests` sigue activo cada 15 minutos y sus últimas ejecuciones continúan en estado `succeeded`.

## Prioridad 1 — Versionar backend

Las Edge Functions activas siguen desplegadas principalmente desde Supabase y no están reproducidas completas en GitHub.

Objetivo:

```text
supabase/
  functions/
    telegram-gateway/
    telegram-modern-action/
    modern-pickup-api/
    modern-parking-api/
    modern-search-api/
    modern-delivery-api/
    modern-live-team-api/
    vehicle-consult-api/
    vehicle-share-api/
    vehicle-report-api/
    performance-report-sender/
  migrations/
```

Añadir despliegue reproducible, `.env.example`, variables requeridas, migraciones y smoke test.

## Prioridad 2 — Retirar backend operativo clásico

La UI por botones ya está retirada, pero siguen desplegadas funciones antiguas.

- inventariar dependencias de `telegram-entry`, `telegram-router3`, `telegram-bot` y auxiliares;
- conservar solo lógica necesaria para altas/acceso;
- neutralizar endpoints legacy capaces de cambiar el webhook;
- borrar funciones antiguas solo después de pruebas de usuario nuevo/rechazado/bloqueado.

## Prioridad 3 — Idempotencia

Implementar deduplicación persistente por `update_id`/clave de dominio en:

- solicitudes de acceso;
- cambios administrativos;
- evidencias;
- OCR/override;
- `pickup`;
- `park`;
- `retrieve`;
- ubicación Telegram.

Los informes ya usan `performance_report_dispatches`.

## Prioridad 4 — UX de errores y sesión

La política ya está definida: códigos técnicos para backend/logs, mensajes claros para usuario.

Pendiente completar la adopción de `docs/preview-modern/ux-errors.js` en **todas** las pantallas modernas, no solo Equipo & Accesos.

Validar que ninguna pantalla muestre:

- `ERROR:` / `JS ERROR:`;
- códigos HTTP como mensaje principal;
- errores SQL/PostgREST;
- `expired_init_data`, `not_admin`, `state_changed` u otros códigos internos.

La ventana administrativa de `initData` es actualmente **24 h**. Pendiente valorar a medio plazo una estrategia de renovación/reapertura explícita si una jornada real puede exceder ese límite, sin ampliar indefinidamente la vigencia de credenciales de Telegram.

## Prioridad 5 — Notificaciones de acceso y roles

Ya están implementadas para aprobación, reactivación, promoción y degradación.

Pendiente validar en uso real:

- usuario que bloqueó el bot o no permite mensajes;
- fallo de Telegram al enviar notificación no debe revertir el cambio administrativo;
- nombres/roles visibles correctos;
- no enviar mensajes duplicados en reintentos administrativos;
- conservar auditoría del cambio aunque falle la notificación.

## Prioridad 6 — Revisar OCR y nomenclatura interna

- centralizar extracción/normalización de matrícula;
- centralizar subida de `plate_photo`;
- eliminar nombres históricos como `modern_parking_beta`;
- definir criterio cuando Vision devuelve varios candidatos.

## Prioridad 7 — Identidad

Coexisten `telegram_users` y `workers`. Reducir duplicidad sin romper referencias de eventos/evidencias.

## Prioridad 8 — Equipo en vivo

- confirmar en Android/iOS el evento de fin de compartición;
- valorar `live_until` como expiración anticipada;
- usar Realtime solo si polling ~10 s deja de ser suficiente;
- no introducir trayectorias salvo decisión explícita.

## Prioridad 9 — Informes de desempeño

Validar varios días reales:

- Europe/Madrid y cambio horario;
- 04:00 día anterior;
- 13:00 y 20:00 día actual;
- sin duplicados;
- individual + global;
- presencia diaria correcta.

## Prioridad 10 — Rendimiento

Medir antes de crear índices. Candidatos actuales:

- `plate_verifications.worker_id`;
- `plate_verifications.evidence_id`;
- `vehicle_evidence.uploaded_by`;
- `vehicles.last_updated_by`;
- `worker_live_locations.worker_id`.

## Prioridad 11 — Pruebas automáticas

Crear fixtures/integración para:

- Mini App por rol;
- aprobación/reactivación/cambio de rol + notificación;
- vigencia `initData` 24 h;
- errores UX amigables;
- Recogida/Aparcar/Buscar/Entrega;
- OCR/override;
- GPS;
- Equipo en vivo/stop sharing;
- group guard;
- informes 04/13/20;
- RLS/seguridad;
- idempotencia.

Ver `TEST_PLAN.md`.

## Fuera de alcance salvo decisión explícita

- sectores de parking;
- configuración de terreno por sectores;
- trayectoria histórica de operarios;
- app móvil nativa;
- multi-parking;
- reintroducir operaciones por botones en el chat;
- navegación para vehículos no aparcados.

### Validación funcional 2026-09-04

Smoke test de producción completado tras endurecer `plate_verifications`:

- Recogida: OK
- Aparcar: OK
- Buscar: OK
- Entrega: OK
- Expediente 360º: OK

El Security Advisor ya no reporta `rls_disabled_in_public` para `plate_verifications`. El aviso restante `rls_enabled_no_policy` es informativo y coherente con el diseño backend-only: no existen políticas cliente y `anon/authenticated` no tienen privilegios directos sobre la tabla.
