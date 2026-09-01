# Arquitectura actual

## Alcance

ParkingMartin-G gestiona un único parking mediante Telegram. La interfaz operativa de producción es una **Telegram Mini App** alojada en GitHub Pages. Supabase aporta PostgreSQL, Storage privado, Edge Functions, cron y red interna de backend.

## Vista general

```text
Telegram Bot API
      |
      v
telegram-gateway
  |-- chat privado: bienvenida + acceso a Mini App
  |-- Telegram Live Location
  |-- group/supergroup guard
  |-- forwarding controlado para acceso de usuarios no autorizados
      |
      +--------------------+
                           v
                ParkingMartin-G Mini App
                           |
       +-------------------+-------------------+
       |                   |                   |
 modern-pickup-api  modern-parking-api  modern-search-api
       |                   |                   |
       +----------- modern-delivery-api -------+
                           |
                       PostgreSQL
                           |
        +------------------+------------------+
        |                                     |
 Supabase Storage                    Google Cloud Vision
 `vehicle-evidence`                  OCR matrícula

Otras APIs Mini App:
- telegram-modern-action
- reservation-admin-api
- reservation-task-api
- reservation-notification-sender
- modern-live-team-api
- vehicle-consult-api
- vehicle-share-api
- vehicle-report-api

Automatización:
pg_cron -> pg_net -> performance-report-sender -> Telegram Bot API
INSERT de aviso -> pg_net -> reservation-notification-sender -> Telegram Bot API
```

## `telegram-gateway`

Único webhook de producción.

Responsabilidades:

- recibir `/start` y mensajes de usuarios activos;
- mostrar bienvenida y un único acceso a ParkingMartin-G;
- configurar el botón permanente de menú Telegram;
- impedir que callbacks antiguos restauren la UI clásica;
- capturar `message` y `edited_message` de ubicaciones en vivo;
- eliminar la última ubicación cuando Telegram informa fin de compartición;
- bloquear ejecución funcional en `group`/`supergroup`;
- reenviar únicamente casos que siguen necesitando backend heredado, principalmente acceso de usuarios no autorizados.

No debe volver a existir un menú operativo Recogida/Aparcar/Buscar/Entrega en el chat.

## `telegram-modern-action`

Backend de dashboard, Equipo & Accesos y acciones administrativas.

Responsabilidades actuales:

- validar criptográficamente `initData` de Telegram;
- aceptar `auth_date` de hasta **24 horas**;
- volver a comprobar en cada petición que el usuario siga activo;
- comprobar Root/Admin para cualquier acción administrativa;
- impedir self-change administrativo y proteger Root;
- sincronizar `telegram_users` con `workers` cuando cambia acceso/rol;
- auditar cambios en `user_admin_events`;
- enviar notificaciones automáticas por Telegram tras aprobar, reactivar, promover o degradar.

Notificaciones:

- aprobación -> bienvenida + rol visible + botón Mini App;
- reactivación -> bienvenida de regreso + rol visible + botón;
- promoción -> aviso de nuevo rol Admin;
- degradación -> aviso de nuevo rol Operario.

El valor interno `owner` se presenta siempre como **Root** en UI/mensajes.

## `reservation-admin-api`

Backend exclusivo de Root/Admin para la gestión de reservas y clientes.

Responsabilidades:

- validar `initData` de Telegram y volver a comprobar rol/estado en cada petición;
- exponer consulta y búsqueda a todos los administradores activos;
- permitir mutaciones solo al titular actual de **Lectura/Escritura**;
- ejecutar altas, modificaciones, importaciones y borrados lógicos mediante funciones PostgreSQL transaccionales;
- comprobar una época global de escritura y una versión por reserva;
- gestionar solicitudes y transferencias de escritura con aceptación/rechazo;
- crear avisos persistentes para la campana y entregarlos también por Telegram con reintentos;
- ocultar avisos leídos después de 30 días y eliminarlos automáticamente a los 90 mediante Supabase Cron, sin borrar solicitudes ni auditoría;
- analizar encabezados `.xlsx`, `.csv` y `.tsv` con Gemini antes de previsualizar la importación.

Privacidad de la importación: Gemini recibe únicamente etiquetas de encabezado saneadas. Las filas con nombres, correos, teléfonos, matrículas, fechas y cobros se procesan dentro de la Edge Function y no se envían al proveedor de IA.

## Programador de tareas

`reservation-task-api` convierte las fechas de recogida y regreso de cada reserva en tareas asignables. Antes de generar la recogida consulta el estado operativo del vehículo por su matrícula normalizada: una reserva pendiente (`requested` o sin vehículo actualmente bajo custodia) genera Recogida y Entrega; si el vehículo ya está `in_transit` o `parked`, genera o conserva únicamente la Entrega. Cuando una recogida anticipada cambia el vehículo a `in_transit`, la tarea de Recogida pendiente se completa automáticamente y desaparece de las asignaciones activas sin borrar su trazabilidad. Root y Admin pueden asignar o reasignar las tareas vigentes en bloque a cualquier Root, Admin u Operario activo que tenga identidad `worker` enlazada.

La versión de cada tarea protege frente a asignaciones concurrentes. El historial queda en `reservation_task_assignment_history`; el estado operativo se completa desde los eventos reales de recogida y entrega.

En la Mini App, Centro de Operaciones muestra el número de tareas asignadas en Recogida aeropuerto y Entrega al cliente. Cada pantalla operativa presenta únicamente las tareas `assigned` del usuario autenticado, ordenadas por `scheduled_at`. Al seleccionar una tarea se muestran los datos necesarios de reserva y el botón de inicio precarga la matrícula en el flujo operativo vigente; no crea un flujo paralelo ni completa la tarea antes del evento real.

Cada asignación o reasignación crea primero un aviso persistente en `parking_booking_notifications`. La entrega por Telegram usa la misma cola transaccional que las solicitudes de escritura:

- activación asíncrona de `reservation-notification-sender` únicamente al insertar avisos;
- hasta tres intentos breves contra Telegram dentro de esa ejecución activada por el evento;
- reclamación con bloqueo `skip locked` para evitar duplicados;
- confirmación de éxito o error en la propia fila;
- espera de cinco minutos antes de reintentar un fallo;
- llamada autenticada con un secreto aleatorio guardado en Supabase Vault.

La campana escucha el canal Realtime `reservation-notifications` y no usa sondeo periódico. Reconcilia el estado únicamente al abrir la Mini App, recibir un evento, recuperar Internet o volver al primer plano. Cada lectura vuelve a validar `initData` y filtra por `telegram_user_id`. La gestión de reservas aplica el mismo patrón y ya no consulta el panel cada 20 segundos. El listado operativo reutiliza el evento Realtime de tareas de la campana, evitando otra conexión y cualquier temporizador de sondeo.

Los controles globales de apariencia, campana y conectividad comparten una franja superior sin solaparse. Los avisos de red y la pantalla sin conexión usan las variables del tema resuelto, por lo que respetan Día, Noche y Automático.

### Concurrencia administrativa

`parking_booking_write_state` mantiene un único titular y una `epoch` creciente.

- una pantalla con una época antigua no puede escribir;
- una transferencia no cambia el titular hasta que el destinatario acepta;
- actualizar o borrar exige además la `version` vigente de la reserva;
- el borrado masivo es atómico y lógico, preservando auditoría;
- si el titular deja de ser Root/Admin activo, un trigger recupera el permiso para otro administrador activo e invalida las solicitudes pendientes.

## Backend heredado

`telegram-entry`, `telegram-router3`, `telegram-bot`, routers/reset/diagnostics antiguos siguen desplegados por compatibilidad y por lógica histórica de acceso.

No son interfaz de producción y no deben recuperar control del webhook ni crear navegación global visible.

## Mini App principal

Ruta base: `docs/preview-modern/`.

### `index.html`

Centro inteligente con:

- Centro de Operaciones;
- Vehículos;
- Actividad reciente;
- Equipo & Accesos **solo Root/Admin**;
- Gestión de reservas **solo Root/Admin**;
- Equipo en vivo;
- GPS Pro · Diagnóstico;
- Expediente 360º.

Equipo & Accesos se oculta por defecto y solo se muestra tras consultar el rol real. La API vuelve a comprobar permisos.

### Política UX de errores

El backend puede devolver códigos técnicos estables para lógica y logs, pero **la UI no debe mostrarlos directamente**.

La capa común `docs/preview-modern/ux-errors.js` traduce errores conocidos a mensajes de usuario con una acción recomendada. Deben cubrirse, como mínimo:

- sesión caducada;
- permisos insuficientes;
- usuario no autorizado/inactivo;
- fallo de red;
- respuesta inválida del servidor;
- estado de dominio cambiado;
- GPS insuficiente;
- matrícula/foto/archivo inválido.

No mostrar al usuario final prefijos `ERROR:`, `JS ERROR:`, códigos HTTP, SQL, stack traces ni códigos internos como `expired_init_data` o `not_admin`.

Los errores inesperados deben producir un mensaje genérico accionable y conservar el detalle técnico solo en consola/logs.

## Flujos

### Recogida

```text
requested -> in_transit
```

- requisitos dinámicos desde `evidence_requirements`;
- fotos de estado;
- foto matrícula + Google Vision OCR;
- override auditable;
- documentación imagen/PDF;
- galería visual con eliminación individual antes de finalizar;
- evento final `pickup`.

### Aparcar

```text
in_transit/requested -> parked
```

- foto matrícula + OCR;
- override auditable;
- GPS integrado;
- precisión horizontal;
- referencia textual obligatoria si se supera el umbral;
- evento `park`.

`vehicles.normalized_plate` es una columna generada y el backend solo escribe `plate`.

### Buscar

- solo acepta `status='parked'`;
- devuelve coordenadas, precisión y referencia;
- navegación solo con coordenadas válidas;
- evento `lookup`;
- no modifica estado.

### Entrega

```text
parked -> retrieved
```

- localización inicial;
- navegación opcional;
- foto de matrícula de salida;
- OCR `stage='parking_exit'`;
- override auditable;
- confirmación final;
- evento `retrieve`.

## OCR

Google Cloud Vision se usa en `airport_pickup`, `parking` y `parking_exit`.

Resultados en `plate_verifications`: `matched`, `mismatch`, `ocr_failed`, `overridden`.

## Evidencias

Fuente actual: `vehicle_evidence` + Storage privado `vehicle-evidence`.

Tipos: `state_photo`, `plate_photo`, `documentation`.

## Expediente 360º

`vehicle-v7.html` consume `vehicle-consult-api`.

Incluye resumen, evidencias, OCR, ubicación, navegación solo `parked`, historial, compartir y PDF.

La UI traduce operaciones internas del historial a español y presenta estados de forma legible. Las URLs de evidencias son firmadas y temporales.

## GPS

### GPS operativo

El aparcado usa GPS desde `park.html`. Se almacena la mejor lectura seleccionada y su precisión.

**No existe configuración funcional por sectores ni configuración de terreno.** La tabla legacy `parking_sectors` no implica que esa función esté implementada.

### GPS Pro · Diagnóstico

Informativo; no escribe en Supabase ni modifica vehículos.

## Equipo en vivo

`telegram-gateway` recibe primera ubicación por `message` y actualizaciones por `edited_message`.

`worker_live_locations` mantiene solo la última posición por usuario. Al terminar la compartición, la fila se elimina cuando Telegram emite la edición correspondiente.

`team-live.html` consume `modern-live-team-api`, visible para cualquier usuario activo, con refresco ~10 s y sin trayectoria histórica.

`worker_daily_presence` registra únicamente presencia diaria para informes.

## Informes automáticos

`performance-report-sender` se invoca mediante `pg_cron` + `pg_net`.

Horarios Europe/Madrid: **04:00, 13:00, 20:00**.

Operarios reciben informe individual; Root/Admin reciben además informe global. `performance_report_dispatches` deduplica.

## Identidad y roles

### `telegram_users`

Roles internos: `owner`, `admin`, `operario`.

En UI: `owner` -> **Root**.

Root está protegido por PostgreSQL. Admin no puede modificar a Root y el panel evita self-change.

### `workers`

Identidad de dominio usada por eventos/evidencias. Coexiste con `telegram_users`; no crear una tercera identidad.

## Tablas de uso actual

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
- `parking_bookings`
- `parking_booking_write_state`
- `parking_booking_permission_requests`
- `parking_booking_notifications`
- `parking_booking_import_analyses`
- `parking_booking_import_batches`
- `parking_booking_admin_events`
- `parking_booking_command_dedup`

`telegram_conversation_sessions` queda como compatibilidad de backend.

## Seguridad

Protecciones vigentes:

- secret header de webhook;
- Telegram `initData` validado por HMAC;
- ventana de `auth_date` de 24 h en administración;
- estado activo y rol comprobados en cada acción sensible;
- server/service keys solo backend;
- origen GitHub Pages restringido en APIs web;
- Storage privado;
- permisos administrativos en backend;
- group guard;
- RLS en tablas nuevas de live/reporting sin políticas cliente.

### Hallazgos abiertos del advisor

1. `plate_verifications`: RLS desactivado.
2. `telegram_access_requests_visible_rejected`: vista marcada `SECURITY DEFINER`.
3. funciones históricas de acceso con `search_path` mutable.
4. `expire_pending_access_requests()` ejecutable por roles cliente pese a `SECURITY DEFINER`.

## Legado

No forma parte del diseño funcional actual:

- `parking_sectors`;
- `vehicle_photos`;
- `app_users`;
- `config_audit`;
- `audit_events`.

No eliminar sin revisar FKs, triggers y dependencias.
