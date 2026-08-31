# Roadmap técnico vigente

Este documento contiene solo trabajo pendiente del sistema de producción actual.

## Prioridad 0 — Seguridad de base de datos

### 1. `plate_verifications` sin RLS

Supabase sigue marcándola como error porque está en `public` y RLS está desactivado.

Antes de habilitar RLS:

1. inventariar todas las Edge Functions que leen/escriben la tabla;
2. confirmar que el acceso debe ser exclusivamente backend;
3. definir política o estrategia backend-only;
4. habilitar RLS;
5. probar Recogida, Aparcar, Entrega, Expediente e informes OCR.

### 2. Vista `telegram_access_requests_visible_rejected`

El advisor la marca como `SECURITY DEFINER`.

Revisar si realmente necesita ese comportamiento. Preferir `SECURITY INVOKER` si es compatible con el flujo actual.

### 3. Funciones históricas con `search_path` mutable

Endurecer, tras revisar dependencias:

- `protect_owner_telegram_user`;
- `sync_access_request_when_user_exists`;
- `set_access_request_expiry`;
- `set_access_request_rejected_at`;
- `reopen_rejected_access_request_on_new_contact`;
- `sync_access_request_with_active_user`;
- `enforce_access_request_user_state`.

### 4. `expire_pending_access_requests()`

El advisor indica que es `SECURITY DEFINER` y ejecutable por `anon/authenticated`.

Revocar permisos cliente si solo lo usa backend/cron.

Las funciones nuevas de informes ya fueron endurecidas y no forman parte de esta deuda.

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
    ...
  migrations/
```

Añadir:

- despliegue reproducible;
- `.env.example` sin secretos;
- documentación de variables requeridas;
- migraciones de live locations e informes;
- smoke test posterior al despliegue.

## Prioridad 2 — Retirar backend operativo clásico

La UI por botones ya está retirada, pero siguen desplegadas funciones antiguas.

Tareas:

- inventariar dependencias reales de `telegram-entry`, `telegram-router3`, `telegram-bot`, routers auxiliares, reset y diagnostics;
- conservar únicamente la lógica todavía necesaria para altas/acceso;
- neutralizar cualquier endpoint legacy capaz de cambiar el webhook;
- borrar funciones antiguas solo después de pruebas de acceso de usuario nuevo/rechazado/bloqueado.

No confundir "no visible" con "sin dependencias".

## Prioridad 3 — Idempotencia

Implementar deduplicación persistente por `update_id`/clave de dominio en las rutas que todavía puedan recibir reintentos.

Cubrir como mínimo:

- solicitudes de acceso;
- cambios administrativos;
- evidencia subida;
- OCR/override;
- `pickup`;
- `park`;
- `retrieve`;
- recepción de ubicación Telegram.

Los informes ya tienen deduplicación propia mediante `performance_report_dispatches`.

## Prioridad 4 — Revisar OCR y nomenclatura interna

OCR está activo en Recogida, Aparcar y Salida/Entrega.

Pendientes:

- centralizar la función de extracción/normalización de matrícula para evitar tres implementaciones casi iguales;
- centralizar subida de `plate_photo`;
- eliminar en nuevos eventos/metadatos nombres históricos como `modern_parking_beta`;
- definir mejor el criterio de selección OCR cuando Google Vision devuelve varios candidatos.

## Prioridad 5 — Identidad

Coexisten `telegram_users` y `workers`.

Objetivo: reducir duplicidad sin romper referencias de eventos/evidencias.

No eliminar ni fusionar hasta conocer todas las FKs y actualizar las APIs modernas.

## Prioridad 6 — Equipo en vivo

La primera versión usa polling de ~10 s y una sola posición por usuario.

Mejoras posibles, no urgentes:

- confirmar mediante pruebas reales que Telegram siempre emite una edición detectable al pulsar "Dejar de compartir" en Android/iOS;
- si hiciera falta, usar `live_until` como expiración anticipada además del timeout de 30 min;
- valorar Supabase Realtime solo si el polling deja de ser suficiente;
- no introducir histórico/trayectorias salvo cambio explícito de producto.

## Prioridad 7 — Informes de desempeño

Validar durante varios días reales:

- zona horaria Europe/Madrid y cambio horario;
- cierre de las 04:00 sobre el día anterior;
- informes de 13:00 y 20:00;
- ausencia de duplicados tras reintentos del cron;
- administradores reciben individual + global según lo esperado;
- presencia diaria sigue marcada aunque el usuario deje de compartir antes del informe.

## Prioridad 8 — Rendimiento

El advisor informa varias FKs sin índice. Priorizar solo tablas activas y consultas frecuentes:

- `plate_verifications.worker_id`;
- `plate_verifications.evidence_id`;
- `vehicle_evidence.uploaded_by`;
- `vehicles.last_updated_by`;
- `worker_live_locations.worker_id`.

No crear índices solo porque aparezcan en el advisor: medir primero consultas y volumen.

## Prioridad 9 — Pruebas automáticas

Crear fixtures/integración para:

- Mini App por rol;
- flujos Recogida/Aparcar/Buscar/Entrega;
- OCR en las tres etapas correctas;
- override;
- `normalized_plate` generado;
- GPS y precisión;
- Equipo en vivo;
- stop sharing;
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
