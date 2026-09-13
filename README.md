# ParkingMartin-G

Sistema de gestión de parking basado en **Telegram + Telegram Mini App + Supabase/PostgreSQL + Supabase Storage + GitHub Pages**. Volumen inicial de diseño: un parking y aproximadamente 150 vehículos/día.

## Fuente de verdad

**El código, las migraciones y la configuración versionada en `main` son la fuente de verdad técnica del proyecto.** Los handoff, auditorías fechadas, planes de prueba y documentos archivados describen estados históricos y no prevalecen sobre el código vigente.

La documentación operativa actual se mantiene en `docs/ARCHITECTURE.md`, `docs/CURRENT_ROADMAP.md`, `docs/TEST_PLAN.md`, `docs/DATA_RETENTION_AND_FACTORY_RESET.md` y `docs/OWNER_FACTORY_RESET_RUNBOOK.md`.

## Arquitectura

```text
Telegram Bot API
      |
telegram-gateway
      |
Telegram Mini App (GitHub Pages)
      |
Supabase Edge Functions
      |
PostgreSQL + Storage privado
      |
servicios auxiliares / worker Optimizer V2
```

La Mini App es la interfaz operativa. El chat privado del bot sirve como entrada, ubicación en vivo y canal de notificaciones/informes. La interfaz operativa clásica por botones no forma parte del producto visible.

## Flujos operativos

- **Recogida**: evidencias, matrícula/OCR, documentación y transición a custodia.
- **Aparcar**: matrícula/OCR, GPS/referencia y estado aparcado.
- **Buscar coche**: consulta autenticada del vehículo aparcado; no crea sesión de flujo.
- **Entrega**: localización, verificación de matrícula y cierre de la estancia.
- **Reubicar**: cambio controlado de ubicación de un vehículo bajo custodia cuando aplica en la UI vigente.

Los flujos protegidos utilizan `operation_flow_sessions` con TTL vigente de **20 minutos**. La sesión de acceso de la Mini App gestionada por `miniapp-access-session-api` tiene TTL de **22 horas**. Son conceptos distintos.

## Reservas y asignaciones

Gestión de reservas permite consulta, importación y operaciones administrativas según permisos. Las tareas pueden asignarse manualmente, reasignarse o quedar `SIN ASIGNAR`.

La planificación IA utiliza Optimizer V2 de forma asíncrona. La confirmación de planes dispone de paridad de notificaciones con la asignación manual; la validación física end-to-end de ese aviso permanece como prueba pendiente, no como implementación pendiente.

## Optimizer V2

Fase 1 es el motor estable: rolling horizon 24/7, modos Fast/Optimal, worker Docker externo con OR-Tools, cola durable `optimization_jobs`, reconciliación de estado y validador físico independiente.

Fase 2 de reoptimización permanece experimental y separada del entry point estable.

## Equipo en vivo

La ubicación compartida utiliza la última posición disponible y una arquitectura dirigida por eventos/Realtime, sin polling periódico del backend. No se almacena trayectoria histórica.

## Evidencias, retención y Factory Reset

Las evidencias operativas se almacenan en Storage privado y metadatos PostgreSQL. Una disputa abierta protege la evidencia frente a la purga ordinaria.

El entorno desplegado actual es un **entorno de pruebas sin usuarios reales**. La retención efectiva de evidencias se mantiene intencionadamente en **5 minutos** para acelerar pruebas. La política prevista para explotación real es **15 días** y debe restaurarse/verificarse antes de incorporar usuarios reales.

Factory Reset es Owner-only y está implementado con preview, confirmación, limpieza de datos operativos y restauración de invariantes necesarias para reutilizar la instalación. No equivale al mantenimiento periódico.

## Observabilidad

El sistema dispone de informes y mecanismos de salud/consumo de base de datos. Las métricas de infraestructura no deben confundirse con datos operativos vivos ni con el tamaño lógico de las tablas.

## Seguridad y permisos

Los roles internos son `owner`, `admin` y `operario`; `owner` se presenta como **Root**. Las operaciones administrativas vuelven a comprobar permisos en backend. Los secretos y credenciales de servicio permanecen fuera del cliente.

La UI debe mostrar mensajes accionables al usuario y reservar códigos técnicos, SQL, HTTP y detalles internos para logs/diagnóstico.

## Release

Los cambios se realizan desde un `main` conocido, en rama separada y mediante Pull Request. Los workflows de protección y verificación se ejecutan según los paths que cubre su configuración vigente. No se debe inferir la release actual a partir de números de build escritos en documentos históricos: consultar el código/manifest vigente.

## Documentación

- `docs/ARCHITECTURE.md` — arquitectura y responsabilidades.
- `docs/CURRENT_ROADMAP.md` — únicamente trabajo vigente/pending.
- `docs/TEST_PLAN.md` — pruebas y regresión.
- `docs/DATA_RETENTION_AND_FACTORY_RESET.md` — retención, disputas y reset.
- `docs/OWNER_FACTORY_RESET_RUNBOOK.md` — procedimiento operativo del reset.
- `docs/STABLE_RELEASE.md` — contrato/protecciones de release cuando aplique.
- `docs/archive/` — documentación histórica que no constituye fuente de verdad.
