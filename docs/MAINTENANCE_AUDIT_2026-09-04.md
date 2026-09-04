# ParkingMartin-G — Auditoría de limpieza técnica

Fecha: 2026-09-04

## Objetivo

Reducir código duplicado, compatibilidad histórica innecesaria, documentación contradictoria y endpoints de prueba expuestos, sin romper producción.

## Estado general

El sistema operativo actual está concentrado en:

- Mini App: `docs/preview-modern/`;
- Optimizer V2: worker Python/OR-Tools externo;
- cola durable: `optimization_jobs`;
- backend de reservas/tareas/notificaciones mediante Edge Functions;
- Realtime/eventos, sin polling periódico.

## Limpieza ya aplicada

### Frontend

- versiones antiguas `team.html`, `team-v2.html`, `team-v3.html` convertidas en redirecciones de compatibilidad a `team-v4.html`;
- `vehicle-v2.html` ... `vehicle-v6.html` convertidas en redirecciones a `vehicle-v7.html`;
- `park-beta.html` redirige a `park.html`;
- los parches de `task-dispatch.html` y `vehicle-v7.html` que vivían dentro del Service Worker fueron retirados;
- la lógica vigente de ciclo de vida del vehículo se integró en `vehicle-v7.html`;
- `reservations-admin.html` carga explícitamente `reservation-operational-runtime.js` y `reservation-import-runtime.js`;
- varios runtimes históricos dejaron de precargarse en el Service Worker.

### Seguridad

- `reservation-optimizer-benchmark-v1` estaba desplegado como endpoint de benchmark accesible por GET y podía devolver datos operativos;
- el endpoint quedó deshabilitado en producción y responde `410 benchmark_endpoint_disabled`.

### Documentación

- README y AGENTS ya no enumeran como deuda problemas de seguridad que fueron resueltos;
- el roadmap prohíbe explícitamente polling periódico;
- TEST_PLAN refleja worker 2.1.2 / Build 2026.09.04.04, bloqueo de participantes/horizonte y límite global de 5 minutos.

## Componentes activos — no eliminar

### Optimización

- `reservation-optimization-jobs-v1`
- `reservation-ai-planner-v2`
- `reservation-ai-planner`
- `reservation-ai-seed-v1`
- worker Docker `optimizer_v2`

Importante: los nombres `planner-v2` y `seed-v1` parecen históricos, pero siguen formando parte del flujo actual. No deben eliminarse solo por su nombre.

### Compartir expediente

- `shared-expediente.html` sigue siendo destino de `vehicle-share-api`.

### Backend Telegram heredado

- `telegram-gateway` sigue delegando determinadas rutas heredadas;
- `telegram-entry`, `telegram-router3` y `telegram-bot` no se consideran eliminables hasta desacoplar completamente altas/acceso y verificar callbacks antiguos.

## Solvers históricos retirados en Supabase

Se comprobó que la UI actual y `reservation-optimization-jobs-v1` usan `reservation-ai-planner-v2` / `reservation-ai-planner`, sin referencias a:

- `reservation-ai-global-solver`;
- `reservation-ai-global-solver-v2`.

Tampoco presentaban tráfico observado en las últimas 24 horas. Ambos quedaron neutralizados de forma reversible con `410 endpoint_retired`, sin acceso a secretos ni base de datos.

### Runtimes históricos retirados

Se comprobó que no estaban referenciados por las pantallas activas ni por el Service Worker, y se retiraron físicamente:

- `access-runtime.js`;
- `assignment-runtime.js`;
- `guide-image.js`;
- `task-dispatch-runtime.js`;
- `ai-dispatch-runtime.js`.

## Elementos que deben conservarse hasta verificar enlaces externos

- `docs/location/index.html`;
- `docs/preview-modern/location/index.html`;
- `docs/vehicle/index.html`.

No aparecen en la navegación actual ni en los backends revisados, pero pueden existir botones o enlaces Telegram históricos fuera del repositorio.

## Documentación histórica archivada / pendiente de consolidación

Los siguientes documentos contienen decisiones antiguas o etapas diagnósticas que contradicen parcialmente el estado actual:

- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`;
- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_Asignacion_Operarios_CONTINUACION.md`;
- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_GLOBAL_SOLVER_V1.md`;
- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_Global_Search_V2.md`;
- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_Implementacion_V1.md`;
- `docs/archive/optimizer/ParkingMartinG_Asistente_IA_Implementacion_V1_T4S_V6.md`.

No deben usarse como fuente normativa actual. Ya fueron movidos a `docs/archive/optimizer/`; la información vigente continúa en README / ARCHITECTURE / STABLE_RELEASE / TEST_PLAN.


## Endpoints de prueba/diagnóstico retirados en Supabase

Tras comprobar ausencia de tráfico observado en las últimas 24 horas y revisar su comportamiento, se neutralizaron de forma reversible los siguientes endpoints desplegados:

- `miniapp-launch-test`;
- `telegram-diagnostics`;
- `telegram-keyboard-reset`.

Motivo:

- no forman parte del código actual del repositorio;
- no presentaban tráfico observado;
- exponían capacidades innecesarias relacionadas con Telegram;
- su existencia aumentaba la superficie de ataque.

No se borraron físicamente de la plataforma. Se sustituyeron por un tombstone que responde `410 endpoint_retired` y no lee `TELEGRAM_BOT_TOKEN`, claves Supabase ni base de datos.



## Compatibilidad de ubicación saneada

El endpoint desplegado `parking-location` contenía una copia antigua de la interfaz de geolocalización. No tenía tráfico observado y no estaba referenciado por la UI o gateway actuales.

Para no romper enlaces históricos, no se eliminó el slug. Se sustituyó por una redirección HTTP `302` hacia:

`https://jdlc86.github.io/MartinGallardo_GPS/preview-modern/location/`

La nueva versión no accede a `TELEGRAM_BOT_TOKEN`, claves Supabase ni base de datos.



## Cadena Telegram heredada — endurecimiento de setup

Se reconstruyó la cadena vigente:

`telegram-gateway -> telegram-entry -> telegram-router3 / telegram-bot`

El webhook actual lo configura `telegram-gateway`. Sin embargo, varias funciones heredadas conservaban rutas públicas `GET ?setup=1` capaces de ejecutar `setWebhook`.

Se neutralizó de forma reversible `?setup=1` en:

- `telegram-entry` (v9);
- `telegram-router3` (v15).

Ambas responden ahora `410 setup_disabled` y mantienen intacto su procesamiento POST.

`telegram-bot` sigue pendiente de este endurecimiento porque la herramienta de despliegue bloqueó el cambio antes de publicarlo. No se modificó.

No deben retirarse todavía `telegram-entry`, `telegram-router3` ni `telegram-bot`: `telegram-entry` continúa delegando casos concretos, incluido el flujo heredado de foto de matrícula de recogida, y usa `telegram-router3` como fallback general.



## Alta de usuarios desconocidos migrada al gateway

`telegram-gateway` v21 registra directamente usuarios desconocidos en `telegram_access_requests`.

Comportamiento:

- si no existe una solicitud rechazada, crea o refresca la solicitud como `pending`;
- si la solicitud ya estaba `rejected`, conserva ese estado;
- actualiza nombre, username y `last_seen_at`;
- responde al usuario indicando si está pendiente o rechazado;
- no introduce credenciales nuevas ni cambia el modelo de secretos.

La cadena `telegram-entry -> telegram-router3 -> telegram-bot` se conserva temporalmente solo como fallback técnico para actualizaciones anómalas. Ya no es necesaria para el alta normal de un usuario desconocido.

Antes de retirar ese fallback debe probarse en producción el alta desde una cuenta Telegram no autorizada.


## Base de datos

Security Advisor a fecha de auditoría:

- 0 ERROR;
- 0 WARN;
- avisos INFO `rls_enabled_no_policy` únicamente.

Estos avisos son compatibles con el diseño backend-only cuando el acceso directo cliente está revocado.

Performance Advisor informa índices sin uso. No se recomienda eliminarlos por contador cero sin observar una ventana de uso real más larga.

## Próximas fases recomendadas

1. consolidar documentación del Optimizer V2 en un único documento vigente;
2. mover documentación histórica a archivo;
3. comprobar tráfico real de Edge Functions antiguas;
4. desactivar funciones sin consumidores;
5. retirar físicamente runtimes históricos después de smoke test;
6. sustituir gradualmente la inyección de scripts desde Service Worker por dependencias explícitas en las páginas fuente;
7. ejecutar smoke test de navegación, reservas, autorizaciones, operaciones y optimizador;
8. promover únicamente después una nueva baseline estable.
