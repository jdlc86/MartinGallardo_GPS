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

## Candidatos a retirada posterior

Requieren prueba de ausencia de tráfico/dependencias antes de desactivar:

- `reservation-ai-global-solver`;
- `reservation-ai-global-solver-v2` — actualmente wrapper de compatibilidad;
- runtimes históricos que ya no carga la UI actual:
  - `access-runtime.js`;
  - `assignment-runtime.js`;
  - `guide-image.js`;
  - `task-dispatch-runtime.js`;
  - `ai-dispatch-runtime.js`.

Por ahora se han retirado del precache, pero no se han borrado físicamente.

## Elementos que deben conservarse hasta verificar enlaces externos

- `docs/location/index.html`;
- `docs/preview-modern/location/index.html`;
- `docs/vehicle/index.html`.

No aparecen en la navegación actual ni en los backends revisados, pero pueden existir botones o enlaces Telegram históricos fuera del repositorio.

## Documentación histórica a archivar/consolidar

Los siguientes documentos contienen decisiones antiguas o etapas diagnósticas que contradicen parcialmente el estado actual:

- `ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`;
- `ParkingMartinG_Asistente_IA_Asignacion_Operarios_CONTINUACION.md`;
- `ParkingMartinG_Asistente_IA_GLOBAL_SOLVER_V1.md`;
- `ParkingMartinG_Asistente_IA_Global_Search_V2.md`;
- `ParkingMartinG_Asistente_IA_Implementacion_V1.md`;
- `ParkingMartinG_Asistente_IA_Implementacion_V1_T4S_V6.md`.

No deben usarse como fuente normativa actual. La información vigente debe consolidarse en README / ARCHITECTURE / STABLE_RELEASE / TEST_PLAN y, después, estos documentos deben moverse a `docs/archive/optimizer/`.

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
