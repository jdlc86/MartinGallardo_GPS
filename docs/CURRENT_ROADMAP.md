# Roadmap técnico vigente

Este documento contiene únicamente trabajo pendiente del sistema actual.

## Prioridad 0 — Seguridad

### RLS de `plate_verifications`

Supabase reporta RLS desactivado.

Antes de habilitarlo:

1. confirmar cómo accede `telegram-entry`/`vehicle-consult-api` a la tabla;
2. decidir si será backend-only;
3. definir políticas mínimas necesarias;
4. habilitar RLS;
5. verificar OCR, consulta de expediente y overrides.

No aplicar `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` sin esa revisión.

## Prioridad 1 — Consolidar webhook e interfaz

Objetivo: que ninguna función legacy pueda volver a cambiar el webhook ni generar UI global antigua.

Tareas:

- webhook de producción -> `telegram-gateway`;
- retirar/neutralizar `?setup=1` de `telegram-bot`, `telegram-router`, `telegram-router3`, `telegram-entry` y utilidades antiguas;
- mantener menús globales solo en gateway;
- comprobar que `menu:close` antiguo siempre vuelve al menú vigente;
- eliminar funciones de prueba/diagnóstico cuando ya no tengan dependencias.

## Prioridad 2 — Versionar backend en GitHub

Hoy las Edge Functions y muchas migraciones están desplegadas directamente en Supabase.

Objetivo:

```text
supabase/
  functions/
    telegram-gateway/
    telegram-entry/
    telegram-location-submit/
    vehicle-consult-api/
    ...
  migrations/
```

Añadir instrucciones de despliegue reproducibles y `.env.example` sin valores secretos.

## Prioridad 3 — Idempotencia Telegram

Implementar deduplicación persistente por `update_id` o identificador equivalente.

Debe cubrir como mínimo:

- solicitudes;
- cambios admin;
- fotos;
- aparcado;
- entrega;
- overrides OCR.

## Prioridad 4 — Identidad

Coexisten `telegram_users` y `workers`.

Objetivo: reducir duplicidad sin perder FKs ni historial.

No eliminar ninguna tabla hasta conocer todas sus referencias.

`app_users` está vacío y puede evaluarse para retirada cuando las migraciones estén versionadas.

## Prioridad 5 — Limpieza de legado de datos

Evaluar y retirar, solo si no tienen dependencias:

- `parking_sectors`;
- `vehicle_photos`;
- `config_audit`;
- `audit_events`;
- columnas de sector que hayan quedado sin uso.

La limpieza debe ser mediante migraciones y nunca mezclada con cambios funcionales grandes.

## Prioridad 6 — Pruebas automáticas

Implementar fixtures de updates Telegram y pruebas de integración para:

- roles/owner;
- estados de solicitudes;
- TTL pending/rejected;
- OCR solo al aparcar;
- GPS;
- navegación solo parked;
- expediente;
- idempotencia;
- seguridad/RLS.

Ver `TEST_PLAN.md`.

## Fuera de alcance actual

No introducir sin decisión explícita:

- sectores de parking;
- panel web administrativo completo;
- app móvil nativa;
- multi-parking;
- OCR en recogida/entrega;
- navegación para vehículos no aparcados.
