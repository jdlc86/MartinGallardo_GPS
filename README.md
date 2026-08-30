# ParkingMartin-G

Sistema de gestión de vehículos de parking mediante **Telegram + Supabase/PostgreSQL + Supabase Storage + GitHub Pages**.

La interfaz operativa principal es Telegram. El sistema registra matrícula, estado, ubicación, precisión GPS, fotografías, documentación, verificaciones OCR, operario y fecha/hora de cada acción.

Volumen inicial de diseño: **un parking y ~150 vehículos/día**.

## Arquitectura vigente

```text
Telegram
   |
   | webhook único de interfaz
   v
telegram-gateway
   |
   v
telegram-entry
   |
   +--> lógica operativa heredada (telegram-router3 / telegram-bot)
   +--> PostgreSQL
   +--> Supabase Storage privado
   +--> Google Cloud Vision (OCR al aparcar)

Telegram Mini Apps
   +--> GPS preciso
   +--> Consultar vehículo
          |
          +--> GitHub Pages
          +--> vehicle-consult-api
```

**`telegram-gateway` es la única entrada que debe controlar `/start`, OTRAS OPCIONES y los menús globales.** Las funciones antiguas continúan activas por compatibilidad interna, pero no deben considerarse fuentes de interfaz.

## Menú operativo

Inicio:

- **AEROPUERTO · RECOGIDA**
- **OTRAS OPCIONES**

Otras opciones para operario:

- **APARCAR**
- **BUSCAR VEHÍCULO**
- **AEROPUERTO · ENTREGA**
- **CONSULTAR VEHÍCULO**

Owner/admin tienen además:

- **GESTIONAR OPERARIOS**

No existe un botón funcional `CERRAR`. Los callbacks antiguos `menu:close` deben ser absorbidos por el gateway y devolver al menú vigente.

## Flujo de vehículos

### Aeropuerto · Recogida

Registra la recepción del vehículo y sus evidencias. La foto de matrícula se conserva como evidencia, pero **no se ejecuta OCR en esta etapa**.

### Aparcar

1. Introducir matrícula.
2. Foto clara de matrícula.
3. OCR con Google Cloud Vision.
4. Comparar OCR con matrícula introducida.
5. Si coincide: **MATRÍCULA VERIFICADA**.
6. Si no coincide/no se lee: **REPETIR FOTO / IGNORAR Y CONTINUAR / CANCELAR**.
7. Todo override queda auditado.
8. Abrir Mini App de GPS.
9. Mostrar precisión al operario.
10. El operario pulsa **USAR ESTA UBICACIÓN**.
11. Se guarda la ubicación y la Mini App vuelve al chat tras ~2 s.

**OCR se usa únicamente al aparcar.**

### Buscar vehículo

Busca por matrícula normalizada. Si el vehículo está `parked`, puede aparecer **NAVEGAR HASTA EL COCHE** con Google Maps.

El botón de navegación no debe aparecer para vehículos que ya no estén aparcados, aunque existan coordenadas históricas.

### Aeropuerto · Entrega

Registra la salida/entrega y cambia el estado del vehículo. No realiza OCR.

## Consultar vehículo

Mini App informativa que no modifica el estado operativo. Muestra, cuando existen:

- matrícula y estado;
- fecha/hora de aparcado y última actualización;
- GPS y precisión;
- referencia textual;
- navegación solo si sigue aparcado;
- fotografías y documentación;
- verificaciones OCR y overrides;
- operario de cada acción/evidencia;
- historial cronológico.

Las fotografías se agrupan por **día + etapa** y se ordenan de la más nueva a la más antigua. Cada evidencia muestra tipo, hora y operario.

Los archivos están en Storage privado y se consultan mediante URLs firmadas temporales.

## Geolocalización

La ubicación principal es **GPS preciso**. Se almacenan latitud, longitud, precisión horizontal y referencia textual cuando sea útil.

**No se utiliza configuración por sectores en el producto vigente.** Las tablas `parking_sectors`/campos históricos relacionados pueden seguir existiendo en la base, pero no forman parte del flujo actual.

## Acceso y roles

### Owner

- Único propietario.
- Siempre activo.
- No puede ser degradado, bloqueado ni eliminado.
- Protección aplicada en PostgreSQL.

### Admin

Puede gestionar solicitudes y usuarios, promover operarios a admin, degradar otros admins, bloquear/reactivar usuarios y autorizar nuevos usuarios. No puede modificar al owner ni sus propios permisos desde el panel.

### Operario

Puede ejecutar los flujos del parking y consultar vehículos, pero no administrar usuarios.

## Estados de acceso

`telegram_access_requests.status`:

- `pending`: solicitud nueva, caduca a las **72 h**;
- `approved`: persona que ya fue autorizada;
- `rejected`: rechazo temporal;
- `expired`: pendiente que agotó su TTL.

Reglas:

- `pending/rejected/expired` solo deben representar personas que todavía no tienen usuario autorizado;
- si existe `telegram_users`, la solicitud debe quedar `approved`;
- `telegram_users.active=true` = usuario activo;
- `telegram_users.active=false` = bloqueado/dado de baja;
- un bloqueado no vuelve a `pending` al escribir;
- un rechazado sin cuenta autorizada puede volver a `pending` cuando vuelva a contactar;
- las solicitudes `pending` vencidas se convierten a `expired` automáticamente;
- un rechazo deja de mostrarse en listados operativos después de 24 h, aunque se conserve en base para auditoría.

## Tablas de uso actual

Principales:

- `telegram_users`
- `telegram_access_requests`
- `telegram_conversation_sessions`
- `workers`
- `vehicles`
- `parking_events`
- `vehicle_evidence`
- `evidence_requirements`
- `plate_verifications`
- `user_admin_events`

Existen tablas antiguas sin uso activo (`app_users`, `vehicle_photos`, `parking_sectors`, `config_audit`, `audit_events`). No deben reutilizarse sin revisar primero dependencias y datos.

## Seguridad

- Tokens y claves solo en secretos de Supabase.
- Nunca exponer service-role key en Telegram Mini Apps o GitHub Pages.
- Identidad externa: `telegram_user_id`.
- Storage de evidencias privado.
- Mini Apps validan datos de Telegram antes de acceder a información sensible.
- Cambios administrativos y overrides OCR quedan auditados.

### Riesgo abierto: RLS

`public.plate_verifications` tiene actualmente **RLS desactivado**. Supabase lo marca como problema crítico. Debe resolverse de forma controlada definiendo primero las políticas necesarias y después habilitando RLS.

SQL base recomendado por Supabase (no ejecutar sin revisar políticas):

```sql
ALTER TABLE public.plate_verifications ENABLE ROW LEVEL SECURITY;
```

## Deuda técnica prioritaria

1. Consolidar la entrada Telegram y retirar la capacidad de las funciones antiguas de cambiar el webhook mediante endpoints `?setup=1`.
2. Versionar en GitHub las Edge Functions y migraciones que hoy viven solo en Supabase.
3. Resolver RLS de `plate_verifications`.
4. Reducir duplicidad `telegram_users` / `workers` sin romper referencias históricas.
5. Añadir deduplicación explícita por `update_id` para reintentos de Telegram.

## Documentación

- `AGENTS.md`: reglas para modificar el sistema.
- `docs/ARCHITECTURE.md`: arquitectura y responsabilidades actuales.
- `docs/CURRENT_ROADMAP.md`: trabajo pendiente vigente.
- `docs/TEST_PLAN.md`: pruebas requeridas.
