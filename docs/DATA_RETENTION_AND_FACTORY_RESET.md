# ParkingMartin-G — Política de retención y Factory Reset

Fecha de diseño: 2026-09-10  
Última auditoría: 2026-09-13

## Objetivo

Definir mecanismos seguros y separados para:

1. limpiar operaciones abortadas;
2. conservar evidencias de vehículos entregados durante un plazo configurable;
3. reducir posteriormente cada expediente a un histórico ligero;
4. eliminar ese histórico al vencer un segundo plazo configurable;
5. suspender cualquier purga cuando exista una disputa abierta;
6. disponer de un Factory Reset excepcional, exclusivamente Owner, que elimine datos de negocio sin destruir la infraestructura técnica necesaria para reutilizar la instalación.

Esta política separa mantenimiento ordinario y Factory Reset. Ninguna tarea periódica debe tener capacidad equivalente al Factory Reset.

## Estado auditado 2026-09-13

- Factory Reset Owner-only está implementado y probado en producción.
- El reset dispone de preview/dry-run, confirmación fuerte, lock de ejecución, borrado de Storage por API y finalización transaccional de base de datos.
- PR #106 corrigió la compatibilidad de la finalización con el guard de borrado seguro (`DELETE ... WHERE true`).
- PR #107 garantiza que, tras el reset, `parking_booking_write_state` se reconstruya con el Owner preservado como titular inicial de escritura.
- La prueba real dejó a cero las principales tablas operativas y eliminó las evidencias físicas.
- `parking_config` se reinicia a `configured=false` y `parking_sectors` se vacía intencionadamente porque son configuración física específica del parking anterior.
- La configuración técnica del producto, retención, salud, recursos, mantenimiento e infraestructura se conserva.

## Configuración de retención

Singleton `data_retention_config`:

- `evidence_retention_days`: 15 por defecto y valor auditado en producción;
- `history_retention_days`: 365 por defecto y valor auditado en producción;
- `evidence_retention_minutes`: 5 en la configuración actual para la ventana provisional existente;
- la retención de evidencias/histórico se calcula según el modelo operativo correspondiente y debe respetar disputas abiertas.

La configuración de retención es técnica y se conserva durante Factory Reset.

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

Una disputa no reinicia los plazos. Al cerrarla se vuelve a evaluar la fecha original aplicable.

## Reentrada de la misma matrícula

Cada nueva estancia debe ser independiente. No se deben mezclar eventos, fotos, reserva, fechas ni operarios de dos visitas diferentes.

El esquema y las consultas que dependan de unicidad de matrícula deben revisarse de forma conjunta antes de modificar restricciones. No se debe retirar una restricción de unicidad aisladamente si existen consultas que esperan como máximo un registro operativo por matrícula.

## Matriz de datos actualizada

### Configuración técnica / referencia — conservar en Factory Reset

- `evidence_requirements`;
- `ai_dispatch_config`;
- `ai_dispatch_nodes`;
- `ai_dispatch_route_matrix`;
- `database_health_config`;
- `resource_observability_config`;
- `data_retention_config`;
- `maintenance_tasks`;
- `config_audit`;
- infraestructura, migraciones, funciones, cron, secretos y buckets;
- contenido técnico de `miniapps`.

### Configuración física de la instalación — reiniciar

- `parking_config`: conservar el singleton pero reiniciarlo a estado genérico/no configurado;
- `parking_sectors`: eliminar sectores del recinto anterior.

Esto evita reutilizar accidentalmente geometría o sectorización de otro parking.

### Telemetría de plataforma — conservar salvo política específica

- `database_health_reports`;
- `resource_usage_snapshots`;
- `maintenance_cleanup_runs`;
- `maintenance_runner_runs`.

Estos datos describen salud/mantenimiento de la plataforma, no una estancia concreta.

### Operación de vehículos / evidencia — eliminar

- `vehicles`;
- `vehicle_stays`;
- `parking_events`;
- `vehicle_evidence`;
- `vehicle_photos`;
- `plate_verifications`;
- `vehicle_share_links`;
- `vehicle_disputes`;
- `operation_flow_sessions`.

### Reservas / tareas / importación — eliminar datos operativos

- `parking_bookings`;
- `reservation_tasks`;
- `reservation_task_assignment_history`;
- `parking_booking_import_analyses`;
- `parking_booking_import_batches`;
- `parking_booking_notifications`;
- `parking_booking_permission_requests`;
- `parking_booking_admin_events`;
- `parking_booking_command_dedup`.

`parking_booking_write_state` requiere tratamiento especial: el estado anterior se elimina, pero al completar el Factory Reset se reconstruye el singleton `id=1` con el Owner preservado como titular inicial. No puede quedar ausente porque Gestión de reservas necesita un objeto de permiso válido.

### IA / optimización operacional — eliminar

- `ai_dispatch_plans`;
- `ai_dispatch_sessions`;
- `optimization_jobs`;
- `optimization_job_events`.

### Presencia y localización — eliminar

- `worker_daily_presence`;
- `worker_live_locations`.

### Usuarios — conservar Owner

- se eliminan usuarios no Owner y datos operativos asociados;
- se preserva el Owner ejecutor y las referencias estructurales necesarias para que la instalación siga administrable;
- `parking_booking_write_state` se vuelve a enlazar al Owner tras el reset.

## Factory Reset Owner-only — estado implementado

Flujo vigente:

1. `preview/dry-run`: obtiene conteos y objetos eliminables sin borrar datos;
2. `execute`: exige autenticación Owner y confirmación fuerte;
3. adquiere lock global;
4. elimina Storage operativo mediante Storage API;
5. finaliza la limpieza lógica en transacción;
6. reinicia configuración física del parking;
7. conserva Owner;
8. reconstruye el estado de permisos de reservas para el Owner;
9. registra el resultado en `factory_reset_runs`.

Protecciones:

- backend/service role para operaciones destructivas;
- rol resuelto desde autenticación válida, no desde parámetros del cliente;
- no accesible a Admin;
- sin `TRUNCATE ... CASCADE` indiscriminado;
- sin borrado SQL directo de `storage.objects`;
- reintento idempotente cuando Storage ya fue eliminado pero la finalización de BD falló.

## Evidencia de validación real

Auditoría posterior al reset corregido:

- vehículos, estancias, evidencias, fotos, eventos, reservas, tareas, sesiones operativas, jobs del optimizador y sectores: 0;
- Owner: exactamente 1;
- `parking_config.configured=false`;
- `parking_booking_write_state.id=1` presente y referenciando al Owner;
- referencias inválidas del estado de escritura: 0;
- Storage: 1 objeto / 2473 bytes, identificado como `miniapps/location/index.html`; no es evidencia de vehículos;
- tamaño físico PostgreSQL observado: aproximadamente 24.8 MiB.

El tamaño físico de PostgreSQL no equivale a datos operativos vivos. `DELETE` deja páginas disponibles para reutilización y autovacuum/VACUUM gestiona versiones muertas. Por ello, un Factory Reset correcto no tiene como criterio que el tamaño de la base caiga a cero.

El informe diario posterior fue coherente con esta auditoría: flujos activos 0, reservas/tareas 0/0 y 576 tuplas muertas. Las tuplas muertas después de un borrado grande son esperables y no representan vehículos/reservas activos.

## Mantenimiento ordinario y retención

El mantenimiento ordinario sigue separado del Factory Reset. Las tareas de abortados, purga de evidencias e histórico deben ser idempotentes, auditables y respetar disputas. Ninguna de ellas debe eliminar configuración técnica ni adquirir alcance de Factory Reset.

## Principios de seguridad

- GitHub `main` es fuente de verdad.
- Migraciones primero en repositorio y solo después en Supabase desde el commit exacto aprobado.
- Stable Release Guard obligatorio antes de fusionar.
- Ninguna eliminación real durante auditorías o dry-runs.
- Configuración técnica del producto no forma parte del borrado operativo.
- La configuración física del recinto sí se reinicia para reutilización segura.
- Una disputa abierta gana frente a la fecha de retención ordinaria.
- El Owner debe permanecer administrable después de Factory Reset, incluida Gestión de reservas.
