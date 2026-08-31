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
- modern-live-team-api
- vehicle-consult-api
- vehicle-share-api
- vehicle-report-api

Automatización:
pg_cron -> pg_net -> performance-report-sender -> Telegram Bot API
```

## `telegram-gateway`

Único webhook de producción.

Responsabilidades:

- recibir `/start` y mensajes de usuarios activos;
- mostrar una bienvenida y un único acceso a ParkingMartin-G;
- configurar el botón permanente de menú Telegram;
- impedir que callbacks antiguos restauren la UI clásica;
- capturar `message` y `edited_message` de ubicaciones en vivo;
- eliminar la última ubicación cuando Telegram informa fin de compartición;
- bloquear ejecución funcional en `group`/`supergroup`;
- reenviar únicamente los casos que siguen necesitando el backend heredado, principalmente acceso de usuarios no autorizados.

No debe volver a existir un menú operativo Recogida/Aparcar/Buscar/Entrega en el chat.

## Backend heredado

`telegram-entry`, `telegram-router3`, `telegram-bot`, routers/reset/diagnostics antiguos siguen desplegados por compatibilidad y por lógica histórica de acceso.

No son interfaz de producción y no deben recuperar control del webhook ni crear navegación global visible.

La retirada definitiva requiere primero versionar las Edge Functions y verificar dependencias.

## Mini App principal

Ruta base: `docs/preview-modern/`.

### `index.html`

Centro inteligente. Funcionalidades visibles:

- Centro de Operaciones;
- Vehículos;
- Actividad reciente;
- Equipo & Accesos **solo Root/Admin**;
- Equipo en vivo;
- GPS Pro · Diagnóstico;
- Expediente 360º.

Equipo & Accesos se oculta por defecto y solo se muestra tras consultar el rol real mediante `telegram-modern-action`. La API vuelve a comprobar permisos, por lo que ocultar la tarjeta no es el control de seguridad principal.

### Centro de Operaciones

`operations.html` enlaza los cuatro flujos actuales:

- `pickup.html` -> `modern-pickup-api`;
- `park.html` -> `modern-parking-api`;
- `search.html` -> `modern-search-api`;
- `delivery.html` -> `modern-delivery-api`.

## Flujos

### Recogida

Estado inicial/final típico:

```text
requested -> in_transit
```

Características:

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

Características:

- foto matrícula + OCR;
- override auditable;
- GPS integrado en la Mini App;
- precisión horizontal;
- referencia textual obligatoria si `accuracy_m` supera el umbral de `parking_config`;
- evento `park`.

`vehicles.normalized_plate` es una columna generada y el backend solo escribe `plate`.

### Buscar

No modifica el estado.

- solo acepta `status='parked'`;
- devuelve coordenadas actuales, precisión y referencia;
- navegación solo con coordenadas válidas;
- evento `lookup`.

### Entrega

```text
parked -> retrieved
```

- localización inicial del vehículo;
- navegación opcional;
- foto de matrícula de salida;
- OCR `stage='parking_exit'`;
- override auditable;
- confirmación explícita final;
- evento `retrieve`.

## OCR

Google Cloud Vision se utiliza actualmente en tres etapas:

- `airport_pickup`;
- `parking`;
- `parking_exit`.

Los resultados se registran en `plate_verifications` con `matched`, `mismatch`, `ocr_failed` u `overridden`.

Los overrides permanecen en esa misma tabla; no se insertan operaciones OCR arbitrarias en `parking_events`.

## Evidencias

Fuente actual: `vehicle_evidence` + Storage privado `vehicle-evidence`.

Tipos usados incluyen:

- `state_photo`;
- `plate_photo`;
- `documentation`.

Las evidencias finalizadas se vinculan al evento cuando corresponde. En Recogida, fotos de estado/documentación pendientes pueden eliminarse tanto de DB como de Storage.

## Expediente 360º

`vehicle-v7.html` consume `vehicle-consult-api`.

Funciones:

- resumen del vehículo;
- evidencias y OCR;
- ubicación actual;
- navegación solo `parked`;
- historial;
- compartir expediente mediante `vehicle-share-api`;
- PDF mediante `vehicle-report-api`.

Las URLs de evidencias son firmadas y temporales.

## GPS

### GPS operativo

El aparcado usa GPS desde `park.html`. Se almacena la mejor lectura seleccionada y su precisión.

No existe configuración por sectores.

### GPS Pro · Diagnóstico

`gps-diagnostic.html` es informativo. No escribe en Supabase ni modifica vehículos.

## Equipo en vivo

### Captura

El operario inicia **Compartir ubicación en tiempo real** desde Telegram.

`telegram-gateway` recibe:

- primera posición mediante `message`;
- actualizaciones mediante `edited_message`.

La tabla `worker_live_locations` mantiene **solo la última posición** por `telegram_user_id`.

Se evita una escritura redundante si no ha pasado aproximadamente 10 s, el movimiento es menor a ~5 m y la precisión no mejora de forma relevante.

Cuando Telegram emite una edición con fin de compartición, la fila se elimina.

### Visualización

`team-live.html` -> `modern-live-team-api`.

- visible para cualquier usuario activo;
- mapa Leaflet/OpenStreetMap;
- refresco ~10 s;
- estados EN VIVO / RETRASADA / ÚLTIMA POSICIÓN;
- API filtra posiciones de más de 30 minutos.

No se guarda trayectoria.

`worker_daily_presence` registra solo que un trabajador compartió ubicación en una fecha concreta para el informe diario.

## Informes automáticos

`performance-report-sender` se invoca mediante `pg_cron` + `pg_net`.

El cron puede ejecutarse cada hora; la Edge Function solo envía cuando la hora local Europe/Madrid es:

- 04:00;
- 13:00;
- 20:00.

A las 04:00 reporta el día anterior; el resto, el día en curso.

`get_daily_performance_report(date)` agrega `parking_events`, OCR y presencia diaria.

`performance_report_dispatches` implementa deduplicación por fecha/hora/destinatario/tipo.

Operarios reciben informe individual. Root/Admin reciben además el informe global del equipo.

## Identidad y roles

### `telegram_users`

Roles internos:

- `owner`;
- `admin`;
- `operario`.

En UI, **`owner` se muestra como Root**.

Root está protegido por restricciones/triggers de PostgreSQL. Admin no puede modificar a Root y el panel evita self-change.

### `workers`

Identidad de dominio usada por eventos y evidencias. Sigue coexistiendo con `telegram_users`.

No crear una tercera tabla de identidad.

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

`telegram_conversation_sessions` queda como compatibilidad de backend, no como estado normal de los cuatro flujos modernos.

## Seguridad

Protecciones vigentes:

- secret header de webhook;
- Telegram `initData` validado criptográficamente;
- expiración de `auth_date`;
- server/service keys solo backend;
- origen GitHub Pages restringido en APIs web;
- Storage privado;
- permisos de administración comprobados en backend;
- group guard en gateway;
- RLS en tablas nuevas de live/reporting sin políticas cliente.

### Hallazgos abiertos del advisor

Prioridad alta:

1. `plate_verifications`: RLS desactivado en esquema público.
2. `telegram_access_requests_visible_rejected`: vista marcada `SECURITY DEFINER`.

Prioridad media:

3. funciones históricas de acceso con `search_path` mutable;
4. `expire_pending_access_requests()` ejecutable por roles cliente pese a `SECURITY DEFINER`.

Las nuevas funciones `get_daily_performance_report(date)` y `mark_worker_daily_presence()` fueron endurecidas con `search_path=public` y `REVOKE EXECUTE` a `anon/authenticated`.

## Legado

No forma parte del diseño funcional actual:

- `parking_sectors`;
- `vehicle_photos`;
- `app_users`;
- `config_audit`;
- `audit_events`.

No eliminar todavía sin revisar FKs, triggers y dependencias.
