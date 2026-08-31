# ParkingMartin-G

Sistema de gestión de parking basado en **Telegram + Telegram Mini App + Supabase/PostgreSQL + Supabase Storage + GitHub Pages**.

La interfaz operativa de producción es la **Mini App ParkingMartin-G**. El chat privado del bot se utiliza como punto de entrada, canal de ubicación en vivo y canal de informes automáticos. La antigua interfaz operativa por botones ya no forma parte del producto visible.

Volumen inicial de diseño: **un parking y ~150 vehículos/día**.

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

## Acceso desde Telegram

Para un usuario activo, `/start` muestra una bienvenida y un único botón:

**🚘 ABRIR PARKINGMARTIN-G**

Telegram también tiene configurado el botón permanente de menú **Abrir ParkingMartin-G**.

Los callbacks antiguos no reactivan los flujos por botones. Si se pulsa un botón histórico, el gateway orienta al usuario hacia la Mini App.

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

Flujo moderno:

1. matrícula;
2. fotos del estado según `evidence_requirements`;
3. foto de matrícula + OCR;
4. si no coincide: repetir o ignorar con override auditado;
5. documentación requerida (imagen o PDF);
6. finalizar -> vehículo `in_transit` + evento `pickup`.

Fotos de estado y documentación se muestran como miniaturas y pueden eliminarse individualmente antes de finalizar. La eliminación borra metadato y objeto de Storage.

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

El estado no cambia hasta la confirmación final.

## Expediente 360º

Consulta informativa con:

- matrícula y estado;
- ubicación y navegación si sigue `parked`;
- evidencias agrupadas por día/etapa;
- OCR y overrides;
- historial operativo;
- compartir mediante enlace temporal;
- informe PDF.

Storage es privado y las imágenes se sirven con URLs firmadas temporales.

## Equipo en vivo

Los usuarios pueden compartir **ubicación en tiempo real de Telegram** con el bot.

Diseño:

- una fila por usuario en `worker_live_locations`;
- no se almacena trayectoria;
- se actualiza si han pasado ~10 s, se movió ~5 m o mejoró claramente la precisión;
- al pulsar **Dejar de compartir**, la fila se elimina cuando Telegram emite la actualización correspondiente;
- `modern-live-team-api` devuelve ubicaciones recientes;
- `team-live.html` refresca aproximadamente cada 10 s;
- todos los usuarios activos pueden ver el mapa.

Estados visuales aproximados:

- hasta 45 s: **EN VIVO**;
- hasta 3 min: **RETRASADA**;
- después: **ÚLTIMA POSICIÓN**;
- las posiciones con más de 30 min dejan de devolverse como fallback de seguridad.

`worker_daily_presence` conserva únicamente que el usuario compartió ubicación en ese día; no guarda recorrido.

## Informes de desempeño

`performance-report-sender` envía informes por Telegram en zona horaria **Europe/Madrid**:

- **04:00** -> cierre del día anterior;
- **13:00** -> acumulado del día;
- **20:00** -> acumulado del día.

Cada operario recibe su resumen individual con:

- recogidas;
- aparcados;
- búsquedas;
- entregas;
- OCR ignorados;
- primera/última actividad;
- si compartió ubicación durante el turno.

Root/Admin reciben además un resumen global con desglose por operario. `performance_report_dispatches` deduplica los envíos.

## Roles

El valor técnico almacenado en `telegram_users.role` sigue siendo:

- `owner`
- `admin`
- `operario`

En la interfaz, **`owner` se presenta como Root**.

### Root (`owner` interno)

- máximo nivel;
- siempre activo;
- protegido en PostgreSQL;
- ningún usuario puede degradarlo, bloquearlo ni eliminarlo.

### Admin

Gestiona solicitudes, altas/bajas, promociones y degradaciones, excepto Root. No puede modificar sus propios permisos desde el panel.

### Operario

Ejecuta operaciones, consulta vehículos, Expediente 360º, GPS diagnóstico y Equipo en vivo. **No ve Equipo & Accesos** y la API administrativa también rechaza su acceso directo.

## Solicitudes de acceso

`telegram_access_requests.status`:

- `pending` -> caduca a las 72 h;
- `approved` -> usuario autorizado;
- `rejected` -> rechazo temporal;
- `expired` -> solicitud pendiente vencida.

Un rechazado sin cuenta puede volver a `pending` si vuelve a contactar. Un usuario bloqueado (`telegram_users.active=false`) no vuelve a pendiente automáticamente.

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

`telegram_conversation_sessions` permanece por compatibilidad con el backend de acceso/legado, pero los usuarios activos no usan ya los flujos operativos conversacionales clásicos.

Tablas legacy que no deben reutilizarse sin migración deliberada: `app_users`, `vehicle_photos`, `parking_sectors`, `config_audit`, `audit_events`.

## Seguridad y deuda abierta

Protecciones actuales:

- secreto del webhook;
- validación de Telegram `initData` en APIs de Mini App;
- service-role solo en backend;
- Storage privado;
- Root protegido en DB;
- comprobación de rol para administración;
- aislamiento de grupos;
- RLS habilitado en las nuevas tablas de live/reporting sin políticas cliente (backend-only).

Hallazgos abiertos del advisor de Supabase:

1. **`plate_verifications` tiene RLS desactivado** y está expuesta por PostgREST.
2. La vista `telegram_access_requests_visible_rejected` figura como `SECURITY DEFINER`.
3. Varias funciones históricas de acceso tienen `search_path` mutable.
4. `expire_pending_access_requests()` sigue marcado como `SECURITY DEFINER` ejecutable por roles cliente y debe endurecerse.

Las funciones nuevas de informes `get_daily_performance_report(date)` y `mark_worker_daily_presence()` ya tienen `search_path` fijado y `EXECUTE` revocado para `anon/authenticated`.

## Documentación

- `AGENTS.md` -> reglas de mantenimiento.
- `docs/ARCHITECTURE.md` -> arquitectura y responsabilidades.
- `docs/CURRENT_ROADMAP.md` -> deuda técnica vigente.
- `docs/TEST_PLAN.md` -> matriz de pruebas de producción.
