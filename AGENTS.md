# AGENTS.md — Instrucciones para Codex

Este archivo es la fuente operativa para agentes que implementen `MartinGallardo_GPS`.

## 1. Prioridad

Objetivo: completar un MVP usable en producción sin romper el flujo Telegram/Supabase ya operativo.

Orden de prioridad:

1. seguridad y control de acceso;
2. integridad de datos;
3. flujo rápido para el operario;
4. trazabilidad/auditoría;
5. pruebas automatizadas;
6. optimizaciones secundarias.

No introducir infraestructura innecesaria si Supabase + Telegram resuelven el caso.

## 2. Lo que YA funciona y no debe romperse

- Edge Function `telegram-bot` desplegada en Supabase.
- Telegram webhook funcional.
- Validación de webhook mediante secreto derivado del token.
- Secret `TELEGRAM_BOT_TOKEN` almacenado en Supabase, nunca en repo.
- Control de acceso por `telegram_user_id`.
- Roles `admin` y `operario`.
- Activación/desactivación de operarios.
- Solicitudes de acceso `pending/approved/rejected`.
- Botones inline `Aceptar` / `Rechazar` para solicitudes.
- Solo admins pueden ejecutar decisiones administrativas.
- Protección para no modificar accidentalmente admins mediante comandos de operario.

Antes de modificar `telegram-bot`, leer su versión desplegada y conservar compatibilidad con lo anterior.

## 3. Regla de trabajo

No desarrollar en `main`.

Crear una rama `feat/*`, `fix/*` o `test/*`.

Antes de cambiar esquema:

1. inspeccionar el esquema real;
2. revisar migraciones existentes;
3. diseñar migración idempotente/reproducible;
4. aplicar en entorno de desarrollo si existe;
5. verificar con consultas;
6. revisar RLS/advisors;
7. documentar el cambio.

Nunca adivinar nombres de columnas o tablas.

## 4. Arquitectura objetivo

```text
Telegram client
  -> Telegram Bot API
  -> Supabase Edge Function(s)
  -> PostgreSQL
  -> Supabase Storage (fotos privadas)
```

MVP sin panel web obligatorio. La interfaz primaria es Telegram.

## 5. Identidad y autorización — deuda técnica crítica

Actualmente existen:

- `telegram_users`: usada por el bot actual;
- `workers`: usada por el modelo operativo de parking;
- `app_users`: modelo anterior/alternativo.

NO crear otra tabla de usuarios.

Primera tarea estructural de Codex: proponer y ejecutar una consolidación segura.

Recomendación objetivo:

- `workers` como entidad de dominio del trabajador;
- `telegram_user_id` único en `workers`;
- `role`, `active`, nombres y datos de Telegram en `workers`;
- migrar la información relevante desde `telegram_users`;
- mantener compatibilidad transitoria en el bot durante la migración;
- retirar tablas redundantes solo cuando no tengan referencias ni datos necesarios.

No eliminar tablas en la misma migración en la que se introduzca la compatibilidad. Hacer la migración por fases.

## 6. Flujo de acceso

Usuario desconocido:

```text
/start
 -> registrar/actualizar telegram_access_requests
 -> si pending: informar que espera aprobación
 -> si rejected: informar que acceso fue rechazado; NO volver a pending
 -> si approved pero aún no existe worker activo: tratar como inconsistencia y registrar error
```

Admin:

```text
/solicitudes
 -> mostrar solo pending
 -> cada solicitud con botones:
    ✅ Aceptar
    ❌ Rechazar
```

Aceptar:

- operación idempotente;
- crear/reactivar worker;
- marcar solicitud `approved`;
- conservar identidad Telegram;
- registrar auditoría;
- opcionalmente notificar al usuario aprobado.

Rechazar:

- marcar `rejected`;
- no crear worker activo;
- registrar auditoría;
- opcionalmente notificar al usuario.

## 7. Flujo operativo del parking

El operario realiza esencialmente dos acciones.

### A. Dejar coche

Flujo deseado:

```text
/dejar
 -> solicitar matrícula
 -> normalizar matrícula
 -> confirmar vehículo
 -> solicitar fotos
 -> solicitar ubicación Telegram
 -> evaluar accuracy
    -> buena: guardar GPS
    -> mala: ofrecer sectores
       -> sector configurado: selección manual
       -> sin sector útil: pedir descripción textual
 -> crear/actualizar vehicle
 -> crear parking_event(operation='park')
 -> vincular fotos al vehicle/event
 -> responder resumen y botón/acción de corrección
```

Requisitos:

- evitar duplicar un coche ya activo sin confirmación;
- matrícula normalizada, búsqueda case-insensitive y sin separadores;
- evento histórico inmutable salvo correcciones auditadas;
- `vehicles` representa estado actual; `parking_events` representa historial.

### B. Retirar coche

```text
/retirar
 -> solicitar/buscar matrícula
 -> mostrar ficha actual:
    matrícula
    sector
    ubicación
    precisión
    descripción
    fotos
    hora de aparcado
 -> ofrecer abrir ubicación / mostrar sector
 -> confirmar retirada
 -> parking_event(operation='retrieve')
 -> vehicle.status='retrieved'
 -> vehicle.retrieved_at=now()
```

No borrar historial ni fotos al retirar.

## 8. Geolocalización

Fuente del umbral:

`parking_config.default_accuracy_threshold_m`

Reglas:

- `accuracy_m <= threshold` => GPS aceptable;
- `accuracy_m > threshold` => GPS degradado;
- nunca impedir aparcar por mala precisión;
- guardar siempre accuracy recibida;
- `gps_quality` puede ser `good`, `poor`, `manual`, `text_only`;
- si se elige sector manual, conservar GPS original si existía, pero marcar que la localización efectiva fue corregida manualmente.

No inferir una precisión que Telegram no envíe.

## 9. Sectores y configuración

Un solo parking en MVP.

Modo configuración:

- solo admin;
- debe exigir texto exacto de confirmación `Configurar` antes de modificar terreno/sectores;
- registrar actor, timestamp y cambios en `config_audit` o auditoría equivalente;
- permitir alta, edición, desactivación y listado de sectores;
- evitar borrado destructivo de sectores usados por eventos históricos.

Si se usa mini mapa/interfaz externa más adelante, debe ser opcional; el bot debe seguir pudiendo completar el flujo sin mapa.

## 10. Fotos

Bucket: `vehicle-photos`.

Reglas:

- privado;
- guardar `telegram_file_id`/metadatos útiles si se decide reutilizar Telegram sin descargar de nuevo;
- si se descarga a Storage, generar paths deterministas y sin PII innecesaria;
- evitar URLs públicas permanentes;
- consulta desde bot mediante envío de archivo o signed URL corta;
- vincular cada foto a `vehicle_id` y, cuando aplique, `event_id`.

## 11. Auditoría

Auditar como mínimo:

- solicitud de acceso;
- aprobación/rechazo;
- bloqueo/reactivación;
- alta/edición de sector;
- entrada a modo configuración;
- parking de vehículo;
- corrección manual de ubicación;
- retirada de vehículo;
- acciones administrativas sensibles.

Auditoría debe incluir actor y contexto suficiente para reconstruir qué ocurrió.

## 12. Manejo de estado conversacional

No depender de memoria RAM de una Edge Function entre invocaciones.

Si un flujo requiere varios mensajes (matrícula -> foto -> ubicación), persistir el estado de conversación en PostgreSQL con TTL/`updated_at`, o modelar el flujo de forma idempotente a partir de un borrador persistente.

Nunca asumir afinidad de instancia.

## 13. Idempotencia

Telegram puede reintentar updates.

Implementar deduplicación usando `update_id` o una tabla de updates procesados antes de operaciones que puedan duplicar eventos, fotos o vehículos.

Las acciones de callback deben tolerar doble pulsación:

- aprobar dos veces => mismo resultado final;
- rechazar dos veces => mismo resultado final;
- callback ya resuelto => responder `Solicitud ya procesada`.

## 14. Rendimiento esperado

Volumen inicial aproximado: 150 coches/día.

No requiere arquitectura distribuida compleja.

Sí requiere:

- índices por matrícula normalizada;
- índices por status;
- índice por `vehicle_id, created_at` en eventos;
- consultas limitadas/paginadas;
- evitar descargar todas las fotos en listados.

## 15. Seguridad

Prohibido:

- commitear tokens;
- exponer service-role key al cliente;
- crear endpoints administrativos sin autorización por rol;
- confiar en username de Telegram como identidad;
- usar solo texto del comando para determinar identidad;
- abrir bucket de fotos públicamente.

Usar `telegram_user_id` como identidad externa estable.

Para operaciones privilegiadas, resolver actor contra base de datos en cada update sensible.

## 16. Pruebas obligatorias

Toda feature debe incluir pruebas donde sea viable.

Prioridad:

1. unitarias de funciones puras;
2. integración contra Supabase local/dev;
3. simulación de payloads Telegram;
4. smoke test manual mínimo con bot real.

Nunca usar usuarios reales como requisito para la suite automática.

Ver `docs/TEST_PLAN.md`.

## 17. Definición de terminado

Una tarea no está terminada solo porque compile.

Debe cumplir:

- comportamiento funcional probado;
- consultas/migraciones verificadas;
- RLS/security revisados;
- errores controlados;
- idempotencia razonable;
- documentación actualizada;
- sin secretos en diff;
- pruebas verdes.

## 18. Qué NO hacer todavía

Salvo necesidad justificada:

- no crear app móvil nativa;
- no crear panel web completo;
- no introducir Redis/colas externas;
- no introducir microservicios;
- no migrar fuera de Supabase;
- no sustituir Telegram como interfaz principal.

El objetivo es un producto rápido, simple y operativo.
