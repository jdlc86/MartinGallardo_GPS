# AGENTS.md — Reglas de mantenimiento

Este archivo describe cómo modificar **ParkingMartin-G** sin reintroducir comportamiento antiguo.

## Prioridades

1. seguridad y permisos;
2. integridad de datos;
3. UX consistente para todos los usuarios;
4. trazabilidad;
5. pruebas e idempotencia;
6. simplicidad operativa.

## Fuente de verdad de interfaz

`telegram-gateway` es la única capa que debe controlar:

- `/start`;
- menú inicial;
- `OTRAS OPCIONES`;
- diferencias de menú por rol;
- neutralización de callbacks antiguos como `menu:close`.

No añadir nuevos menús globales en `telegram-entry`, `telegram-router3` o `telegram-bot`.

Las funciones heredadas pueden seguir procesando pasos internos de una operación mientras se completa la consolidación, pero no deben convertirse de nuevo en entrada visible del bot.

## Webhook

El webhook de producción debe apuntar a `telegram-gateway`.

No ejecutar endpoints `?setup=1` de funciones antiguas. Esos endpoints pueden cambiar el webhook y provocar interfaces distintas entre usuarios.

Prioridad técnica: retirar esa capacidad de las funciones legacy cuando se versione el backend.

## Roles

Roles de `telegram_users.role`:

- `owner`
- `admin`
- `operario`

Reglas:

- solo puede existir un `owner`;
- owner siempre activo y protegido en PostgreSQL;
- admin puede gestionar otros usuarios excepto owner;
- admin no modifica sus propios permisos desde el panel;
- operario no accede a administración.

## Solicitudes de acceso

Estados:

- `pending`
- `approved`
- `rejected`
- `expired`

Invariantes:

- `pending/rejected/expired` solo para personas sin cuenta autorizada;
- si existe fila en `telegram_users`, su solicitud debe ser `approved`;
- `active=true` = acceso activo;
- `active=false` = bloqueado/dado de baja;
- bloqueado no vuelve a `pending` escribiendo;
- rechazado sin usuario puede volver a `pending` al contactar otra vez;
- pending caduca a las 72 h;
- rejected puede ocultarse del panel tras 24 h, sin borrar auditoría.

No borrar historial de solicitudes para “limpiar” la UI.

## Flujos vigentes

### Recogida aeropuerto

Guardar evidencias. La foto de matrícula es evidencia, **sin OCR**.

### Aparcar

Matrícula -> foto matrícula -> OCR -> decisión -> GPS preciso -> confirmar.

OCR solo en esta etapa.

Si OCR no coincide/no lee:

- repetir foto;
- ignorar y continuar;
- cancelar.

El override debe quedar auditado.

### Buscar vehículo

Mostrar vehículo aparcado y navegación solo si `vehicles.status='parked'`.

### Entrega aeropuerto

Registrar entrega/salida. Sin OCR.

### Consultar vehículo

Mini App informativa, sin cambiar estado. Debe mostrar evidencias, GPS, precisión, OCR, auditoría e historial.

## GPS

La ubicación operativa es GPS + precisión + referencia textual opcional.

**No implementar sectores ni modo Configurar.** `parking_sectors` existe por legado, no por diseño vigente.

## Evidencias

Tabla vigente: `vehicle_evidence`.

No desarrollar nuevas funciones sobre `vehicle_photos` salvo migración deliberada.

Storage debe permanecer privado. Usar URLs firmadas temporales.

Las evidencias se presentan por día y etapa, con hora y operario.

## Estado conversacional

Usar `telegram_conversation_sessions`.

No depender de memoria de proceso de Edge Functions.

Toda operación debe permitir cancelar y recuperarse razonablemente de sesión expirada.

## Identidad

Hoy coexisten `telegram_users` y `workers`.

No crear una tercera identidad. Cualquier consolidación debe conservar FKs e historial de `parking_events`/evidencias.

`app_users` está vacío y no es fuente de verdad.

## Idempotencia

Telegram puede reintentar updates y callbacks.

Antes de considerar estable el sistema, implementar deduplicación por `update_id` o equivalente para evitar duplicar:

- eventos;
- evidencias;
- aprobaciones;
- entregas;
- aparcados.

## Seguridad

Nunca:

- commitear secretos;
- exponer service-role al navegador;
- confiar en username como identidad;
- abrir Storage públicamente;
- permitir acciones admin sin consultar rol/estado en DB.

### RLS pendiente

`plate_verifications` tiene RLS desactivado. No activar RLS a ciegas: definir primero políticas compatibles con el backend y después habilitarlo.

## Trabajo con esquema

Antes de DDL:

1. inspeccionar tablas/constraints/triggers reales;
2. usar migraciones reproducibles;
3. verificar estado final con consultas;
4. revisar advisors de seguridad/performance;
5. actualizar documentación.

## Pruebas mínimas por cambio

- permisos;
- happy path;
- cancelación/error;
- retry/idempotencia si escribe en DB;
- coherencia de estados;
- smoke real cuando afecte Telegram/Mini App.

Ver `docs/TEST_PLAN.md`.

## No reintroducir

- sectores de parking;
- palabra `Configurar`;
- OCR en recogida o salida;
- botón `CERRAR`;
- menús diferentes según la función legacy que procese el update;
- URLs públicas permanentes de evidencias.
