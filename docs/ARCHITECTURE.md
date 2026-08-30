# Arquitectura técnica

## 1. Alcance

Sistema para gestionar vehículos de un único parking usando Telegram como interfaz operativa y Supabase como backend.

Componentes:

- Telegram Bot API.
- Supabase Edge Functions.
- PostgreSQL.
- Supabase Storage.
- Futuro: mini mapa opcional para selección visual de sectores.

## 2. Flujo de datos

```text
[Operario/Admin]
      |
      v
[Telegram App]
      |
      v
[Telegram Bot API]
      |
      | HTTPS webhook
      v
[Edge Function telegram-bot]
      |
      +--> autorización
      +--> máquina de estados conversacional
      +--> dominio parking
      +--> auditoría
      |
      +--> [PostgreSQL]
      |
      +--> [Storage vehicle-photos]
```

## 3. Estado desplegado

### Edge Function

Existe `telegram-bot` y actualmente contiene:

- webhook Telegram;
- validación de secret header;
- resolución de usuario por `telegram_user_id`;
- `/start`, `/admin`, `/mi_id`;
- `/solicitudes`;
- callbacks `approve:*` y `reject:*`;
- `/operarios`, `/alta`, `/bloquear`, `/reactivar`, `/estado`.

El código desplegado todavía no está versionado de forma completa en este repositorio. Una de las primeras tareas de Codex debe ser **traer la Edge Function al repo** bajo una estructura estándar, por ejemplo:

```text
supabase/
  functions/
    telegram-bot/
      index.ts
  migrations/
```

Después, el despliegue debe salir del código versionado y no de modificaciones manuales aisladas.

## 4. Tablas actuales relevantes

### `telegram_users`

Fuente de autorización usada actualmente por el bot.

Campos relevantes:

- `id uuid`
- `telegram_user_id bigint unique`
- `username text`
- `first_name text`
- `last_name text`
- `role text` (`admin` / `operario`)
- `active boolean`
- `created_at timestamptz`
- `deactivated_at timestamptz`

### `telegram_access_requests`

Solicitud de acceso externa.

Campos:

- `telegram_user_id bigint unique`
- perfil Telegram
- `first_seen_at`
- `last_seen_at`
- `attempts`
- `status`: `pending | approved | rejected`

### `workers`

Entidad de dominio creada para trabajadores del parking.

Campos principales:

- `id uuid`
- `telegram_user_id bigint unique`
- `phone_e164`
- `full_name`
- `role`
- `active`
- timestamps y notas.

### `vehicles`

Estado actual del vehículo.

Campos principales:

- `id uuid`
- `plate`
- `normalized_plate unique`
- `status`
- `current_sector_id`
- `current_lat/current_lng`
- `current_accuracy_m`
- `current_location_text`
- `parked_at`
- `retrieved_at`
- `last_updated_by`

### `parking_events`

Historial operacional.

Campos principales:

- `vehicle_id`
- `worker_id`
- `operation`
- `sector_id`
- coordenadas
- precisión
- `location_text`
- `gps_quality`
- `created_at`
- `metadata jsonb`

Índices existentes relevantes:

- `(vehicle_id, created_at desc)`
- `(worker_id, created_at desc)`

### `parking_sectors`

Sectores configurables del parking.

- `code unique`
- `name`
- `description`
- centro GPS
- `radius_m`
- `active`
- actor/timestamps.

### `parking_config`

Configuración singleton del parking.

- `parking_name`
- `configured`
- centro GPS
- `default_accuracy_threshold_m` (actualmente default 15 m)
- `updated_by`
- `config_notes`

### `vehicle_photos`

Metadatos de fotos almacenadas.

- `vehicle_id`
- `event_id`
- `uploaded_by`
- `storage_bucket` default `vehicle-photos`
- `storage_path unique`
- `kind`
- timestamps / metadata.

### `config_audit` y `audit_events`

Tablas de auditoría existentes. Codex debe evitar crear una tercera solución de auditoría sin evaluar primero cuál consolidar.

### `app_users`

Modelo de usuario anterior/alternativo. Debe tratarse como deuda técnica y no asumirse como fuente de verdad sin migración explícita.

## 5. Duplicidad de identidad: plan recomendado

Problema:

```text
telegram_users   <- bot
workers          <- dominio parking
app_users        <- modelo previo
```

Objetivo:

```text
workers = identidad operativa canónica
telegram_access_requests = cola/historial de solicitudes
```

Migración propuesta en fases:

### Fase A — compatibilidad

- añadir cualquier campo Telegram faltante a `workers`;
- copiar usuarios activos desde `telegram_users`;
- mapear roles;
- no borrar nada.

### Fase B — doble lectura controlada

- bot consulta primero `workers`;
- fallback temporal a `telegram_users` solo para transición;
- nuevas altas escriben en `workers`.

### Fase C — convergencia

- eliminar fallback;
- comprobar ausencia de dependencias;
- archivar/eliminar tablas redundantes en migración separada.

## 6. Estado de vehículo

Estados mínimos recomendados:

```text
parked
retrieved
```

Opcionales futuros:

```text
expected
in_transit
cancelled
```

No añadir estados sin caso de uso real.

`vehicles` es proyección del estado actual. `parking_events` es historial append-oriented.

## 7. Eventos

Operaciones mínimas:

```text
park
retrieve
location_corrected
photo_added
```

Las acciones puramente administrativas pueden ir a auditoría en lugar de `parking_events`.

## 8. Matrículas

Normalización recomendada:

```text
uppercase
remove spaces
remove hyphens
trim
```

La búsqueda debe usar `normalized_plate`.

Nunca destruir el valor original `plate` introducido por el operario.

## 9. Conversaciones

Edge Functions son stateless. Para flujos de varios pasos se recomienda una tabla `bot_sessions` o `operation_drafts`.

Modelo sugerido:

```text
id uuid
telegram_user_id bigint
flow text
state text
payload jsonb
expires_at timestamptz
updated_at timestamptz
```

Ejemplo `flow='park_vehicle'`, estados:

```text
awaiting_plate
awaiting_photos
awaiting_location
awaiting_manual_sector
awaiting_location_text
confirming
```

Cada update debe poder reanudarse leyendo esta fila.

## 10. Idempotencia Telegram

Añadir persistencia de `update_id` procesados o equivalente.

Requisito:

- no crear dos `parking_events` por retry;
- no subir dos veces la misma foto;
- no aprobar dos veces una misma solicitud causando duplicados.

## 11. Storage

Bucket actual: `vehicle-photos`, privado.

Path recomendado:

```text
vehicles/<vehicle_uuid>/<event_uuid>/<photo_uuid>.jpg
```

No usar matrícula, teléfono o nombre personal en paths si no es necesario.

## 12. Seguridad RLS

Principio:

- cliente Telegram nunca recibe service-role key;
- Edge Function actúa como backend privilegiado;
- tablas públicas con RLS;
- no crear policies amplias por comodidad;
- para futuros frontends, diseñar policies separadas.

## 13. Observabilidad

Registrar errores con contexto no sensible:

- `update_id`
- tipo de evento
- actor Telegram ID si es imprescindible para depuración (evitar imprimir token o payloads completos con PII)
- operación
- vehicle UUID

Nunca loguear `TELEGRAM_BOT_TOKEN` ni headers de autorización.

## 14. Escalabilidad

150 vehículos/día es una carga baja para Supabase.

Evitar optimización prematura. Priorizar:

- consistencia;
- índices;
- paginación;
- no hacer N+1 innecesario;
- no descargar binarios durante búsquedas.
