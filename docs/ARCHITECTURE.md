# Arquitectura actual

## Alcance

ParkingMartin-G gestiona un único parking mediante Telegram. Supabase aporta backend, base de datos y almacenamiento privado; GitHub Pages aloja las Mini Apps.

## Componentes

```text
Telegram Bot API
      |
      v
telegram-gateway
      |
      v
telegram-entry
      |
      +--> telegram-router3 / telegram-bot (lógica heredada interna)
      +--> PostgreSQL
      +--> Supabase Storage
      +--> Google Cloud Vision

Mini Apps
  +--> /location/  -> telegram-location-submit
  +--> /vehicle/   -> vehicle-consult-api
```

## Responsabilidades

### `telegram-gateway`

Entrada visible del bot. Debe ser el único webhook de producción.

Responsable de:

- `/start`;
- menú inicial;
- `OTRAS OPCIONES`;
- menú según rol;
- impedir que callbacks antiguos como `menu:close` restauren UI obsoleta.

### `telegram-entry`

Orquesta funciones actuales de mayor nivel:

- OCR al aparcar;
- gestión de usuarios;
- panel admin;
- sesiones y forwarding a lógica heredada.

### `telegram-router3` / `telegram-bot`

Contienen lógica operativa heredada todavía utilizada por algunos pasos. No deben considerarse fuentes de navegación global.

Riesgo actual: siguen activas y conservan endpoints de configuración capaces de cambiar el webhook. Deben retirarse o neutralizarse cuando el backend se versione y consolide.

### `telegram-location-submit`

Recibe la ubicación aprobada por el usuario desde la Mini App de GPS y actualiza el flujo de aparcado.

### `vehicle-consult-api`

API autenticada por datos de Telegram para cargar el expediente completo de un vehículo.

## Mini App de GPS

Flujo:

1. Telegram abre `/location/`.
2. Se obtiene posición y precisión.
3. El operario decide **USAR ESTA UBICACIÓN**.
4. La Mini App envía los datos al backend.
5. Muestra confirmación.
6. Espera ~2 s y se cierra para volver al chat.

No se usan sectores como fallback.

## Mini App Consultar vehículo

Muestra:

- estado actual;
- GPS/precisión;
- referencia;
- navegación solo si `status='parked'`;
- evidencias;
- OCR;
- overrides;
- operarios;
- historial.

Las evidencias se ordenan descendente por fecha y se agrupan por día + etapa.

## Datos principales

### `telegram_users`

Autorización y rol Telegram.

Roles actuales:

- `owner`
- `admin`
- `operario`

`active=false` representa bloqueo/dado de baja.

### `telegram_access_requests`

Estados actuales:

- `pending`
- `approved`
- `rejected`
- `expired`

`pending` caduca a las 72 h. Un rechazado puede generar una nueva solicitud al contactar de nuevo si no existe usuario bloqueado/autorizado.

### `workers`

Identidad de dominio usada en eventos/evidencias. Sigue coexistiendo con `telegram_users`; la consolidación requiere migración cuidadosa.

### `telegram_conversation_sessions`

Estado persistente de flujos Telegram multi-mensaje.

### `vehicles`

Proyección del estado actual del coche. La matrícula normalizada es la clave de búsqueda operativa.

### `parking_events`

Historial operativo append-oriented: aparcado, consulta, recogida, entrega y eventos de auditoría operativa.

### `vehicle_evidence`

Metadatos de fotografías/documentos actuales. Es la tabla de evidencias vigente.

### `evidence_requirements`

Requisitos de evidencias por etapa.

### `plate_verifications`

Resultado OCR de matrícula y overrides.

**RLS está actualmente desactivado en esta tabla y debe corregirse de forma controlada.**

### `user_admin_events`

Auditoría de altas, bajas, promociones, degradaciones y cambios de acceso.

## Tablas legacy

Existen pero no forman parte del diseño funcional actual:

- `app_users`
- `vehicle_photos`
- `parking_sectors`
- `config_audit`
- `audit_events`

No eliminarlas sin comprobar FKs, triggers y datos, pero tampoco desarrollar nuevas funciones basadas en ellas.

## Estados funcionales

### Acceso

```text
sin usuario -> pending -> approved
                     \-> rejected
pending vencido ------> expired
rejected + nuevo contacto -> pending
approved + active=false -> bloqueado
```

Un usuario que ya existe en `telegram_users` no debe aparecer como `pending/rejected/expired`.

### Vehículos

Los estados operativos usados actualmente incluyen `requested`, `in_transit`, `parked` y `retrieved`.

Solo `parked` habilita navegación hacia las coordenadas actuales.

## OCR

Google Cloud Vision se usa exclusivamente al **aparcar**.

No ejecutar OCR en:

- Aeropuerto · Recogida;
- salida/búsqueda;
- Aeropuerto · Entrega.

## Geolocalización

Fuente de verdad: GPS preciso capturado por Mini App.

Datos:

- latitud;
- longitud;
- `accuracy_m`;
- referencia textual opcional.

No existe flujo de configuración por sectores.

## Seguridad

- Webhook valida secret header.
- Mini Apps validan contexto Telegram.
- Service role y claves privadas permanecen en backend.
- Storage es privado.
- Owner está protegido por restricciones/triggers PostgreSQL.
- Acciones administrativas consultan rol/estado en DB.

### Riesgo RLS

Supabase reporta `plate_verifications` sin RLS. Antes de habilitarlo hay que decidir si la tabla será backend-only o si necesita políticas de lectura/escritura específicas.

## Deuda técnica de arquitectura

1. Versionar Edge Functions y migraciones en GitHub.
2. Hacer imposible que funciones legacy cambien el webhook.
3. Consolidar `telegram_users` y `workers` sin perder historial.
4. Implementar deduplicación por `update_id`.
5. Resolver RLS de `plate_verifications`.
6. Retirar funciones de prueba/diagnóstico que ya no sean necesarias (`miniapp-launch-test`, routers antiguos, reset/diagnostics) después de confirmar que no tienen dependencias.
