# ParkingMartin-G — Release estable

## Baseline actual

- **Producto:** ParkingMartin-G
- **Versión:** 1.4.0
- **Build estable:** 2026.09.04.04
- **Fecha de consolidación:** 2026-09-04
- **Rama de producción:** `main`

Esta release se considera la **línea base estable de producción** de la Mini App hasta que se publique explícitamente un build posterior.

## Alcance protegido de esta release

### Pantalla principal

La home está organizada en tres grupos:

**Operación**
- Centro de Operaciones
- Asignación de tareas
- Vehículos
- Equipo en vivo
- Actividad reciente

**Gestión**
- Gestión de reservas
- Equipo & Accesos
- Expediente 360º

**Sistema**
- Configuración de optimización
- Información del sistema
- GPS Pro · Diagnóstico

Etiquetas funcionales vigentes:

- Centro de Operaciones → `OPERACIÓN`
- Asignación de tareas → `PLANIFICACIÓN · ADMIN`
- Vehículos → `FLOTA`
- Equipo en vivo → `SEGUIMIENTO`
- Actividad reciente → `TRAZABILIDAD`
- Gestión de reservas → `RESERVAS · ADMIN`
- Equipo & Accesos → `ACCESOS · ADMIN`
- Expediente 360º → `EXPEDIENTES`
- Configuración de optimización → `OPTIMIZACIÓN · ADMIN`
- Información del sistema → `SOPORTE · ADMIN`
- GPS Pro · Diagnóstico → `DIAGNÓSTICO`

Las tarjetas marcadas `ADMIN` son visibles únicamente para Root/Admin y sus backends deben volver a comprobar autorización; ocultar la tarjeta nunca sustituye la autorización servidor.

### Asignación manual

- Root/Owner no puede aparecer como trabajador asignable.
- Admin y Operarios activos sí pueden ser responsables.
- La última asignación manual confirmada es la válida.
- Las tareas manuales son constraints duras del optimizador.

### Asistente IA / Optimizer V2

- selección explícita de participantes;
- Root/Owner excluido del reparto;
- un participante seleccionado puede recibir nuevas tareas;
- un trabajador excluido conserva sus tareas manuales pero no recibe nuevas tareas;
- Fast/Optimal pertenecen a Fase 1 estable;
- línea temporal continua 24/7;
- validación física con 0 errores obligatoria;
- acompañamientos y coche de empresa forman parte de la logística física;
- la planificación visual muestra misiones de coche cuando existan;
- Realtime es señal; `optimization_jobs` es fuente de verdad;
- no existe polling periódico;
- Fase 2 de reoptimización permanece experimental y separada.

### Versionado y soporte

La Mini App muestra:

`v1.4.0 · Build 2026.09.04.04`

Root/Admin dispone de **Información del sistema**, que identifica:

- versión/build de Mini App;
- versión/build de backend;
- versión/build del último worker que ejecutó una optimización;
- último job asociado.

El worker estable sella:

- `optimizer_version = 2.1.2`
- `optimizer_build = 2026.09.04.04`

## Regla de protección

No modificar silenciosamente esta baseline.

Cualquier cambio posterior que afecte interfaz, permisos, flujo operativo, contrato backend o comportamiento del optimizador debe:

1. actualizar código y pruebas;
2. incrementar `build` en `docs/preview-modern/release.js`;
3. actualizar la versión del backend/worker cuando corresponda;
4. invalidar la caché del Service Worker cuando afecte la Mini App;
5. pasar los tests/smoke aplicables;
6. actualizar este documento si cambia el comportamiento estable;
7. mantener Fase 2 fuera del camino estable salvo promoción explícita.

Un cambio experimental no redefine esta release hasta que se promueva deliberadamente a estable.

## Seguridad aplicada a esta baseline

- **plate_verifications RLS:** resuelto el 2026-09-04.
- RLS habilitado.
- Acceso directo de `anon` y `authenticated` revocado.
- Acceso de producción únicamente desde backend/service-role.
- Debe mantenerse smoke test de OCR en Recogida, Aparcar y Entrega, además de Expediente 360º e informe de vehículo.

### Validación funcional 2026-09-04

Smoke test de producción completado tras endurecer `plate_verifications`:

- Recogida: OK
- Aparcar: OK
- Buscar: OK
- Entrega: OK
- Expediente 360º: OK

El Security Advisor ya no reporta `rls_disabled_in_public` para `plate_verifications`. El aviso restante `rls_enabled_no_policy` es informativo y coherente con el diseño backend-only: no existen políticas cliente y `anon/authenticated` no tienen privilegios directos sobre la tabla.

### Vista de solicitudes rechazadas

Resuelto el 2026-09-04: `telegram_access_requests_visible_rejected` pasó a `security_invoker=true` y se revocó el acceso directo de `anon/authenticated`. El acceso queda backend-only mediante `service_role`. El Security Advisor ya no reporta `security_definer_view` para esta vista.

### RPC de expiración de solicitudes

Resuelto el 2026-09-04: `expire_pending_access_requests()` conserva su ejecución interna mediante `pg_cron` cada 15 minutos, pero se revocó `EXECUTE` a `PUBLIC`, `anon` y `authenticated`. El Security Advisor ya no la reporta como función `SECURITY DEFINER` ejecutable por clientes.

### RPC privilegiados de reservas y ciclo de vida

Resuelto el 2026-09-04: `parking_booking_operational_snapshot(bigint)`, `vehicle_lifecycle_search(bigint,text)` y `vehicle_lifecycle_snapshot(bigint)` mantienen `SECURITY DEFINER` para su uso interno, pero `PUBLIC`, `anon` y `authenticated` ya no tienen `EXECUTE`. El acceso queda únicamente a `service_role`/backend. El Security Advisor ya no reporta estos RPC como ejecutables por clientes.

### search_path de triggers

Resuelto el 2026-09-04: las 8 funciones trigger señaladas por el Security Advisor tienen ahora `search_path=''`. Todos los triggers siguen activos y el advisor ya no reporta `function_search_path_mutable`.

## Validación funcional de la build 2026.09.04.04

Promovida tras smoke test completo de producción:

- Gestión de reservas y transferencia de permisos: OK.
- Asistente IA / Optimizer V2 con worker 2.1.2: OK.
- Aparcar con GPS válido, baja precisión y fallback manual: OK.
- Reubicar con GPS válido, baja precisión y fallback manual: OK.
- Buscar coche y Entrega con navegación solo si existen coordenadas reales: OK.
- Expediente 360º con ubicación GPS y ubicación manual: OK.
- Equipo & Accesos: OK.
- Actividad reciente / trazabilidad: OK.
- Información del sistema: OK.

Cambios incorporados respecto a la baseline anterior:

- preflight automático de rutas al optimizar;
- fallback dinámico/caché de trayectos;
- retirada del botón manual de actualización de trayectos;
- timeout global de optimización de 5 minutos;
- bloqueo de participantes/horizonte durante job activo;
- flujo de autorización visible y dirigido por eventos, sin polling;
- fallback manual cuando GPS está desactivado/no disponible;
- correcciones de navegación Buscar/Entrega y Expediente 360º;
- limpieza inicial de frontend, Service Worker y documentación histórica;
- endpoint de benchmark deshabilitado en producción.
