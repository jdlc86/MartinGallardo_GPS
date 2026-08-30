# MartinGallardo_GPS

MVP de gestión de vehículos de parking mediante **Telegram + Supabase/PostgreSQL + Storage**, orientado a operarios que reciben, aparcan, localizan y retiran vehículos.

> Estado: backend Telegram y control de acceso ya funcionales en Supabase. La siguiente fase es completar el flujo operativo de vehículos, sectores, fotos, geolocalización y pruebas automatizadas.

## Objetivo del producto

El operario debe poder hacer todo desde Telegram, sin una app adicional:

1. Solicitar acceso al bot.
2. Ser aprobado o rechazado por un administrador.
3. Registrar la llegada de un vehículo.
4. Guardar matrícula, fotos y ubicación.
5. Usar GPS cuando tenga precisión suficiente.
6. Si la precisión es mala, seleccionar manualmente un sector del parking o escribir una descripción de ubicación.
7. Buscar un vehículo cuando haya que retirarlo.
8. Ver fotos, ubicación, sector y notas desde el propio bot.
9. Registrar la retirada y mantener auditoría de quién hizo cada acción.

El sistema está diseñado inicialmente para **un solo parking** y un volumen aproximado de **150 vehículos/día**.

## Arquitectura actual

```text
Telegram
   |
   | webhook HTTPS
   v
Supabase Edge Function: telegram-bot
   |
   +--> PostgreSQL
   |      - telegram_users
   |      - telegram_access_requests
   |      - vehicles
   |      - parking_events
   |      - parking_sectors
   |      - parking_config
   |      - vehicle_photos
   |      - audit_events / config_audit
   |
   +--> Supabase Storage
          - bucket privado vehicle-photos
```

## Seguridad

- `TELEGRAM_BOT_TOKEN` se guarda únicamente como **Supabase Edge Function Secret**.
- No se deben guardar tokens, service-role keys ni secretos en GitHub.
- El webhook valida `X-Telegram-Bot-Api-Secret-Token`.
- El acceso de operarios se controla por `telegram_user_id`.
- Las cuentas tienen rol `admin` u `operario` y estado activo/inactivo.
- Las tablas expuestas tienen RLS habilitado; la lógica privilegiada vive en backend/Edge Functions.
- Un operario desactivado debe perder acceso inmediatamente.

## Funcionalidad ya implementada

### Control de acceso Telegram

Un usuario desconocido que escribe al bot queda registrado como solicitud pendiente.

El administrador puede usar:

- `/solicitudes`
- `/operarios`
- `/alta ID`
- `/bloquear ID`
- `/reactivar ID`
- `/estado ID`
- `/mi_id`
- `/admin`

`/solicitudes` muestra botones inline:

- `✅ Aceptar`
- `❌ Rechazar`

Estados de solicitud:

```text
pending -> approved
pending -> rejected
```

Una solicitud rechazada **no debe volver automáticamente a pending** por escribir de nuevo al bot.

### Modelo de parking ya creado

La base ya contiene tablas para:

- trabajadores/usuarios,
- vehículos,
- eventos de parking,
- sectores,
- configuración del parking,
- fotos,
- auditoría.

Hay una deuda técnica conocida: actualmente existen `app_users`, `workers` y `telegram_users`. El bot usa `telegram_users`, mientras parte del dominio de parking referencia `workers`. **Codex debe resolver esta duplicidad de forma explícita y mediante migraciones, no creando una cuarta tabla de usuarios.**

## Reglas funcionales críticas

### Operaciones principales del operario

Solo existen dos acciones operativas principales:

1. **Dejar coche**: el vehículo llega del aeropuerto y el operario lo aparca.
2. **Retirar coche**: el operario necesita localizarlo para devolverlo.

### Geolocalización

- Usar GPS cuando la precisión sea aceptable.
- El umbral debe venir de `parking_config.default_accuracy_threshold_m`.
- Si la precisión es mala, el operario debe poder elegir manualmente un sector.
- Si el parking/sector aún no está configurado, debe poder escribir una descripción textual de dónde dejó el vehículo.
- Nunca bloquear el flujo porque el GPS sea malo.

### Configuración del terreno

- Solo administradores pueden configurar el parking.
- Para entrar al modo de configuración debe exigirse la palabra **`Configurar`**.
- Debe quedar auditado qué usuario de Telegram realizó cada cambio.
- Inicialmente hay un único parking.

### Fotos

- Se almacenan en bucket privado `vehicle-photos`.
- El administrador/operario autorizado debe poder consultarlas desde Telegram.
- No exponer URLs públicas permanentes; usar acceso backend o URLs firmadas de corta duración.

## Desarrollo

Las instrucciones completas para agentes/Codex están en [`AGENTS.md`](./AGENTS.md).

Documentación técnica:

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- [`docs/CODEX_IMPLEMENTATION_PLAN.md`](./docs/CODEX_IMPLEMENTATION_PLAN.md)
- [`docs/TEST_PLAN.md`](./docs/TEST_PLAN.md)

## Regla de ramas

No implementar directamente en `main`.

Usar ramas del tipo:

```text
feat/<descripcion>
fix/<descripcion>
test/<descripcion>
docs/<descripcion>
```

Cada cambio debe incluir pruebas y, si modifica esquema, una migración reproducible.
