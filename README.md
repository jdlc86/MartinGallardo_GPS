# ParkingMartin-G

Sistema de gestión de parking basado en **Telegram + Telegram Mini App + Supabase/PostgreSQL + Supabase Storage + GitHub Pages**.

La interfaz operativa de producción es la **Mini App ParkingMartin-G**. El chat privado del bot se utiliza como punto de entrada, canal de ubicación en vivo, notificaciones de acceso/rol e informes automáticos. La antigua interfaz operativa por botones ya no forma parte del producto visible.

Volumen inicial de diseño: **un parking y ~150 vehículos/día**.

## Release estable actual

La baseline de producción vigente es **ParkingMartin-G v1.4.0 · Build 2026.09.04.02**.

El contrato funcional y las reglas de protección de esta release están registrados en `docs/STABLE_RELEASE.md`. Cualquier cambio que altere interfaz, permisos, flujos o comportamiento del optimizador debe incrementar el build y actualizar la documentación correspondiente.

## Producción

```text
Telegram (chat privado)
  |
  | webhook
  v
telegram-gateway
  |-- bienvenida + botón ABRIR PARKINGMARTIN-G
  |-- ubicación Telegram Live (`message` + `edited_message`)
  |-- protección de group/supergroup
  |-- altas de usuarios no autorizados -> backend heredado controlado
  v
ParkingMartin-G Mini App (GitHub Pages)
  |
  +-- Centro de Operaciones
  |    +-- Recogida -> modern-pickup-api
  |    +-- Aparcar  -> modern-parking-api
  |    +-- Buscar   -> modern-search-api
  |    +-- Entrega  -> modern-delivery-api
  |
  +-- Vehículos / Actividad -> telegram-modern-action
  +-- Equipo & Accesos -> telegram-modern-action (solo Root/Admin)
  +-- Equipo en vivo -> modern-live-team-api
  +-- GPS Pro Diagnóstico -> solo navegador, no persiste datos
  +-- Expediente 360º -> vehicle-consult-api / share / report

Supabase
  +-- PostgreSQL
  +-- Storage privado `vehicle-evidence`
  +-- Edge Functions
  +-- pg_cron / pg_net para informes programados

Google Cloud Vision
  +-- OCR de matrícula en Recogida, Aparcar y Salida/Entrega
```

## Optimización de asignaciones

La asignación automática usa **Optimizer V2 Fase 1** (Back-Forward rolling horizon 24/7) mediante un worker Python/OR-Tools fuera de las Edge Functions.

```text
Mini App -> reservation-optimization-jobs-v1 -> optimization_jobs
         -> worker Docker -> OR-Tools -> ai_dispatch_plans
         -> Realtime / Telegram -> revisión de propuesta
```

Reglas vigentes:

- no existen fronteras rígidas por día;
- modos `fast` y `optimal` comparten el mismo motor forward/backward;
- la solución aceptada debe pasar el validador físico independiente con 0 errores;
- acompañamientos, transferencias entre terminales y coche/lanzadera forman parte de la logística física;
- Fase 2 de reoptimización local permanece **experimental y separada**;
- la UI muestra el resultado operativo y las tareas pendientes de asignación manual, no los códigos internos de auditoría;
- Realtime es aviso, no fuente de verdad: `optimization_jobs` permite reconciliar el estado sin polling.

Referencia estable Fast: **221/300 (73,67 %) con 0 errores físicos**. Optimal: **223/300 (74,33 %) con 0 errores físicos**.

## Acceso desde Telegram

Para un usuario activo, `/start` muestra una bienvenida y un único botón:

**🚘 ABRIR PARKINGMARTIN-G**

Telegram también tiene configurado el botón permanente de menú **Abrir ParkingMartin-G**.

Los callbacks antiguos no reactivan los flujos por botones. Si se pulsa un botón histórico, el gateway orienta al usuario hacia la Mini App.

### Notificaciones automáticas de acceso y rol

`telegram-modern-action` notifica al usuario por chat cuando cambia su situación de acceso:

- **aprobación inicial** -> bienvenida completa, rol asignado y botón para abrir la Mini App;
- **reactivación tras bloqueo** -> bienvenida de regreso, rol vigente y acceso directo;
- **promoción a Admin** -> aviso de cambio de rol;
- **degradación a Operario** -> aviso de cambio de rol.

Los nombres visibles son **Root, Admin y Operario**. El valor interno `owner` nunca se expone como etiqueta de producto.

### Sesión de la Mini App administrativa

`telegram-modern-action` valida criptográficamente `initData` de Telegram y acepta `auth_date` de hasta **24 horas**. En cada petición administrativa vuelve a comprobar que el usuario siga activo y conserve rol Root/Admin.

La ampliación a 24 h evita que un panel de administración abierto durante el turno falle a los 15 minutos, sin eliminar la validación HMAC ni las comprobaciones de autorización en base de datos.

### Política de errores de usuario

Los códigos técnicos se reservan para backend, logs y depuración. La interfaz no debe mostrar directamente valores como `expired_init_data`, `not_admin`, `invalid_action`, códigos HTTP, respuestas SQL ni mensajes JavaScript internos.

Las pantallas de producción deben traducirlos a mensajes en español que indiquen **qué ocurrió y qué debe hacer el usuario**. Ejemplos:

- sesión caducada -> cerrar y volver a abrir ParkingMartin-G desde Telegram;
- falta de permisos -> indicar que se necesita Root/Admin;
- fallo de red -> comprobar conexión y reintentar;
- estado cambiado -> actualizar y volver a intentar;
- GPS insuficiente -> mejorar señal o aportar la referencia requerida.

`docs/preview-modern/ux-errors.js` contiene el traductor común de errores para las pantallas modernas que lo integren.

### Protección de grupos

ParkingMartin-G funciona en chat privado. Si el bot es añadido accidentalmente a un `group` o `supergroup`:

- no procesa operaciones;
- no procesa ubicaciones;
- no crea/continúa sesiones;
- no gestiona accesos;
- no reenvía updates al backend operativo;
- callbacks históricos solo reciben un aviso neutro de usar chat privado.

## Flujos operativos

### Recogida

1. matrícula;
2. fotos del estado según `evidence_requirements`;
3. foto de matrícula + OCR;
4. si no coincide: repetir o ignorar con override auditado;
5. documentación requerida (imagen o PDF);
6. finalizar -> vehículo `in_transit` + evento `pickup`.

### Aparcar

1. matrícula;
2. foto de matrícula + OCR;
3. repetir/override si procede;
4. GPS Pro integrado con precisión y evaluación de calidad;
5. si la precisión supera el umbral configurado, se exige referencia textual;
6. confirmar -> vehículo `parked` + evento `park`.

`normalized_plate` es columna generada por PostgreSQL y **nunca debe escribirse directamente** desde APIs.

### Buscar coche

- solo localiza vehículos con `status='parked'`;
- muestra ubicación, precisión, referencia, operario y fecha;
- navegación solo si sigue aparcado y existen coordenadas válidas;
- registra evento `lookup`;
- no cambia el estado del vehículo.

### Entrega

1. localizar vehículo `parked`;
2. navegación opcional;
3. **Foto Matrícula** de salida + OCR (`stage='parking_exit'`);
4. repetir/override si procede;
5. confirmar entrega al cliente;
6. vehículo -> `retrieved` + evento `retrieve`.

## Expediente 360º

Consulta informativa con matrícula/estado, ubicación, evidencias, OCR, historial, compartir mediante enlace temporal e informe PDF. Los nombres internos de operaciones se traducen al español en la interfaz y los estados se presentan de forma legible. Storage es privado y las imágenes se sirven con URLs firmadas temporales.

## Equipo en vivo

Los usuarios pueden compartir **ubicación en tiempo real de Telegram** con el bot.

- una fila por usuario en `worker_live_locations`;
- no se almacena trayectoria;
- actualización aproximada cada 10 s / 5 m o por mejora de precisión;
- al pulsar **Dejar de compartir**, la fila se elimina cuando Telegram emite la actualización correspondiente;
- todos los usuarios activos pueden ver el mapa;
- posiciones de más de 30 min dejan de mostrarse como fallback de seguridad.

`worker_daily_presence` conserva únicamente que el usuario compartió ubicación en ese día; no guarda recorrido.

## Informes de desempeño

`performance-report-sender` envía informes por Telegram en zona horaria **Europe/Madrid** a las **04:00**, **13:00** y **20:00**.

Cada operario recibe resumen individual. Root/Admin reciben además un resumen global con desglose por operario. `performance_report_dispatches` deduplica los envíos.

## Roles

Valores internos en `telegram_users.role`: `owner`, `admin`, `operario`.

En la interfaz, `owner` se presenta como **Root**.

- **Root**: máximo nivel, protegido contra baja/degradación.
- **Admin**: gestión delegada de usuarios y accesos, excepto Root/self-change.
- **Operario**: operaciones normales; no ve ni puede usar Equipo & Accesos.

## Solicitudes de acceso

`telegram_access_requests.status`: `pending`, `approved`, `rejected`, `expired`.

Un rechazado sin cuenta puede volver a `pending` al contactar de nuevo. Un usuario bloqueado (`telegram_users.active=false`) no vuelve a pendiente automáticamente.

## Tablas principales

- `telegram_users`
- `telegram_access_requests`
- `workers`
- `vehicles`
- `parking_events`
- `vehicle_evidence`
- `evidence_requirements`
- `plate_verifications`
- `user_admin_events`
- `vehicle_share_links`
- `worker_live_locations`
- `worker_daily_presence`
- `performance_report_dispatches`

`telegram_conversation_sessions` permanece por compatibilidad con backend heredado, pero los usuarios activos no usan ya los flujos operativos conversacionales clásicos.

Tablas legacy que no deben reutilizarse sin migración deliberada: `app_users`, `vehicle_photos`, `parking_sectors`, `config_audit`, `audit_events`. La existencia de `parking_sectors` **no implica que exista configuración funcional del terreno**; esa funcionalidad no está implementada.

## Seguridad y deuda abierta

Protecciones actuales:

- secreto del webhook;
- validación HMAC de Telegram `initData`;
- ventana de `auth_date` de 24 h en `telegram-modern-action`;
- autorización de rol/estado comprobada en cada acción administrativa;
- service-role solo en backend;
- Storage privado;
- Root protegido en DB;
- aislamiento de grupos;
- RLS en tablas nuevas de live/reporting sin políticas cliente.

Estado del Security Advisor (2026-09-04):

- **0 errores** y **0 warnings** de seguridad;
- permanecen únicamente avisos informativos `rls_enabled_no_policy` en tablas diseñadas como backend-only;
- `plate_verifications`, la vista de rechazados, los `search_path` de triggers y los RPC privilegiados señalados previamente ya fueron endurecidos.

Las tablas backend-only mantienen RLS habilitado sin políticas cliente y acceso directo de `anon/authenticated` revocado deliberadamente.

## Documentación

- `AGENTS.md` -> reglas de mantenimiento.
- `docs/ARCHITECTURE.md` -> arquitectura y responsabilidades.
- `docs/CURRENT_ROADMAP.md` -> deuda técnica vigente.
- `docs/TEST_PLAN.md` -> matriz de pruebas de producción.
