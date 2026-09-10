# ParkingMartin-G — Política de retención y Factory Reset

Fecha de diseño: 2026-09-10

## Objetivo

Definir mecanismos seguros y separados para:

1. limpiar operaciones abortadas;
2. conservar evidencias de vehículos entregados durante un plazo configurable;
3. reducir posteriormente cada expediente a un histórico ligero;
4. eliminar ese histórico al vencer un segundo plazo configurable;
5. suspender cualquier purga cuando exista una disputa abierta;
6. disponer de un Factory Reset excepcional, exclusivamente Owner, que elimine datos de negocio sin tocar configuración ni infraestructura.

Esta política separa mantenimiento ordinario y Factory Reset. Ninguna tarea periódica debe tener capacidad equivalente al Factory Reset.

## Estado comprobado antes de implementar

- `main`: `9e1934c703d3d5be0e28ae58d451a268ba3bb9c1`.
- El runner global ya existe y ejecuta tareas declaradas en `maintenance_tasks`.
- Actualmente solo está activa la tarea `cleanup_aborted_flows` -> `aborted-vehicle-cleanup`.
- Cron `global-maintenance-runner`: `20 3 * * *`.
- El bucket operativo de evidencias es `vehicle-evidence`.
- Los objetos de Storage deben eliminarse mediante Storage API, nunca borrando filas de `storage.objects` por SQL.
- `vehicles.normalized_plate` es UNIQUE. Este punto impide modelar correctamente dos estancias simultáneas/históricas de una misma matrícula sin una separación explícita de estancia. Por tanto, no debe activarse la purga automática de expedientes hasta resolver este modelo.

## Configuración de retención

Singleton `data_retention_config`:

- `evidence_retention_days`: 15 por defecto.
- `history_retention_days`: 365 por defecto.
- Regla de base de datos: `history_retention_days > evidence_retention_days >= 1`.
- Máximo inicial del histórico: 3650 días.
- Modificación prevista: Owner-only a través de backend; nunca acceso directo desde cliente.

Los plazos se calcularán desde la entrega efectiva del vehículo (`retrieved_at` en el modelo actual), no desde la creación.

## Disputas / retención suspendida

Tabla `vehicle_disputes`:

- solo una disputa abierta por vehículo;
- motivo obligatorio;
- apertura y cierre auditables;
- actores almacenados de forma nullable para no impedir futuras limpiezas de usuarios;
- una disputa abierta bloquea tanto la purga de evidencias como la eliminación del histórico.

Permisos previstos de aplicación:

- Owner: abrir/cerrar disputa;
- Admin: abrir/cerrar disputa;
- Operario: sin permiso;
- Factory Reset: solo Owner.

La interfaz natural es Expediente 360, con un estado visible equivalente a `Expediente en disputa — retención suspendida`.

## Ciclo de vida objetivo

1. Vehículo entregado.
2. Durante `evidence_retention_days`: expediente completo y evidencias disponibles.
3. Si no existe disputa: se eliminan fotos/evidencias físicas y metadatos dependientes que ya no sean necesarios.
4. Expediente 360 pasa a histórico ligero y muestra que las evidencias fueron eliminadas por política de retención.
5. Al vencer `history_retention_days`, y sin disputa, se elimina definitivamente el histórico operativo.

Una disputa no reinicia los plazos. Al cerrarla se vuelve a evaluar la fecha original de entrega.

## Reentrada de la misma matrícula

Cada nueva estancia debe ser independiente. No se deben mezclar eventos, fotos, reserva, fechas ni operarios de dos visitas diferentes.

Bloqueo detectado: el esquema actual impone `UNIQUE (normalized_plate)` en `vehicles`. Antes de activar la retención automática se debe escoger e implementar una estrategia compatible, preferiblemente una separación entre identidad de matrícula y estancia operativa, o un archivo de estancias inmutable que permita liberar/reutilizar el registro operativo sin mezclar históricos.

No se debe retirar la restricción UNIQUE sin adaptar previamente todas las consultas que hoy esperan como máximo un vehículo por matrícula.

## Matriz de datos — clasificación inicial

### Configuración / referencia — conservar en Factory Reset

- `parking_config`
- `parking_sectors`
- `evidence_requirements`
- `ai_dispatch_config`
- `ai_dispatch_nodes`
- `ai_dispatch_route_matrix`
- `database_health_config`
- `resource_observability_config`
- `data_retention_config`
- `maintenance_tasks`
- `config_audit`

También se conservan migraciones, funciones, cron, secretos, buckets y demás infraestructura.

### Telemetría de plataforma — conservar salvo política específica

- `database_health_reports`
- `resource_usage_snapshots`
- `maintenance_cleanup_runs`
- `maintenance_runner_runs`

Estos datos describen salud/mantenimiento de la plataforma, no una estancia concreta.

### Operación de vehículos / evidencia — eliminable

- `vehicles`
- `parking_events`
- `vehicle_evidence`
- `vehicle_photos`
- `plate_verifications`
- `vehicle_share_links`
- `operation_flow_sessions`

### Reservas / tareas / importación — eliminable

- `parking_bookings`
- `reservation_tasks`
- `reservation_task_assignment_history`
- `parking_booking_import_analyses`
- `parking_booking_import_batches`
- `parking_booking_notifications`
- `parking_booking_permission_requests`
- `parking_booking_admin_events`
- `parking_booking_command_dedup`
- `parking_booking_write_state`

### IA / optimización operacional — eliminable

- `ai_dispatch_plans`
- `ai_dispatch_sessions`
- `optimization_jobs`
- `optimization_job_events`

### Presencia y localización — eliminable

- `worker_daily_presence`
- `worker_live_locations`

### Usuarios — Factory Reset con conservación de Owner

- `telegram_users`
- `workers`
- `app_users`
- `telegram_access_requests`
- `telegram_conversation_sessions`
- `miniapp_access_sessions`
- `user_admin_events`

El Factory Reset no debe eliminar el/los registros necesarios para mantener el Owner que ejecuta el reset. Las referencias históricas deben resolverse antes de borrar Admin/Operarios.

### Otros datos derivados que requieren decisión antes del reset final

- `audit_events`
- `performance_report_dispatches`

Pueden contener actividad derivada del negocio. Antes de habilitar el Factory Reset definitivo debe verificarse su contenido y decidir si se purgan o se conservan como auditoría de plataforma.

## Mecanismos a implementar

### A. Limpieza de abortados

Se conserva el mecanismo existente. No se mezcla con las tareas nuevas.

### B. Purga de evidencias vencidas

Nueva tarea independiente del runner global. Debe:

- seleccionar solo entregas vencidas;
- excluir disputas abiertas;
- usar claim/token para evitar carreras, siguiendo el patrón de `aborted-vehicle-cleanup`;
- borrar Storage mediante API;
- solo después confirmar en base de datos;
- registrar run, contadores y errores;
- ser idempotente.

No activar hasta resolver el modelo de estancia.

### C. Purga definitiva del histórico

Nueva tarea independiente. Debe respetar el segundo plazo y disputas. No activar hasta que exista histórico ligero por estancia.

### D. Factory Reset Owner-only

Debe tener dos fases obligatorias:

1. `preview/dry-run`: conteos de filas y objetos de Storage, preservados y eliminables;
2. `execute`: requiere autenticación Owner y confirmación fuerte de un solo uso.

Protecciones mínimas:

- solo backend con service role;
- la autorización Owner se resuelve a partir de una sesión válida, no de un parámetro de rol enviado por cliente;
- no accesible a Admin;
- lock global durante ejecución;
- borrar dependencias en orden controlado;
- conservar configuración e infraestructura;
- conservar Owner;
- Storage por API;
- registrar un evento final de Factory Reset fuera del conjunto que se elimina;
- reintentos seguros si falla Storage;
- nunca usar `CASCADE` global o `TRUNCATE ... CASCADE` indiscriminado.

## Orden de implementación seguro

1. Fundación no destructiva: configuración + disputas. **Hecho en la rama de trabajo; no ejecuta purgas.**
2. Resolver modelo de estancia/reentrada sin romper consultas actuales.
3. Adaptar Expediente 360 a estancia/histórico y a estado de disputa.
4. Implementar purge de evidencias con `dry_run`; validar sin borrar.
5. Activar tarea solo tras prueba controlada.
6. Implementar histórico ligero y su purga.
7. Implementar Factory Reset con preview; probar con rollback/datos de prueba antes de habilitar execute.

## Principios de seguridad

- GitHub `main` es fuente de verdad.
- Migraciones primero en repositorio y solo después en Supabase desde el commit exacto aprobado.
- Stable Release Guard obligatorio antes de fusionar.
- Ninguna eliminación real durante auditorías o dry-runs.
- Configuración nunca forma parte del borrado operativo.
- Una disputa abierta siempre gana frente a la fecha de retención.
